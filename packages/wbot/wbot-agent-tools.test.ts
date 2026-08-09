import type { Server } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { PlatformClient } from "./platform-client";

import { DEFAULT_WBOT_PLATFORM_URL, resolveWbotConfig } from "./wbot-config";
import { createWbotMcpServer } from "./wbot-mcp";

type PluginMcpConfig = {
  mcpServers: {
    wbot: {
      args: Array<string>;
    };
  };
};

const cliEntry = new URL("./wbot-cli.ts", import.meta.url).pathname;
const temporaryDirectories: Array<string> = [];
const servers: Array<Server> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("功能 1：外部 Agent 看到 wbot 只读工具面", () => {
  test("场景 1.1：CLI schema 使用 wbot 品牌且只暴露三条只读命令", async () => {
    const result = await runCli(["@schema"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("wbot");
    expect(result.stdout).toMatch(/conversations:\s*\{[\s\S]*list\(input:/);
    expect(result.stdout).toMatch(/messages:\s*\{[\s\S]*history\(input:/);
    expect(result.stdout).toMatch(/messages:\s*\{[\s\S]*updates\(input:/);
    expect(result.stdout).not.toMatch(/send\(input:|outbound-sends|operator/i);
  });

  test("场景 1.2：MCP 使用 wbot 品牌且只列出同样三条只读工具", async () => {
    const fixture = await createMcpFixture(createPlatformClientStub());

    const result = await fixture.client.listTools();

    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "list_conversations",
      "read_message_history",
      "read_message_updates",
    ]);
    expect(result.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/send|outbound|operator/i);
    await fixture.close();
  });
});

describe("功能 2：CLI 与 MCP 复用安全的本机凭据", () => {
  test("场景 2.4：环境变量 API Key 覆盖本地凭据", async () => {
    const configRoot = await createTemporaryDirectory();
    await writeCredentials(configRoot, "file-secret");

    const config = await resolveWbotConfig({
      WBOT_API_KEY: "environment-secret",
      XDG_CONFIG_HOME: configRoot,
    });

    expect(config.apiKey).toBe("environment-secret");
    expect(await readCredentials(configRoot)).toContain("file-secret");
  });

  test("场景 2.5：缺少凭据时 CLI 在网络请求前失败", async () => {
    const configRoot = await createTemporaryDirectory();
    const result = await runCli(["conversations.list"], {
      XDG_CONFIG_HOME: configRoot,
      WBOT_PLATFORM_URL: "http://127.0.0.1:1",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("RUNTIME_ERROR");
    expect(result.stderr).toContain("wbot auth set");
    expect(result.stderr).toContain("WBOT_API_KEY");
  });

  test("场景 2.6：损坏凭据文件不会把内容输出给 Agent", async () => {
    const configRoot = await createTemporaryDirectory();
    const damagedSecret = "damaged-secret-value";
    await writeCredentials(configRoot, damagedSecret, false);

    const result = await runCli(["conversations.list"], {
      XDG_CONFIG_HOME: configRoot,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("wbot auth set");
    expect(result.stderr).not.toContain(damagedSecret);
  });

  test("场景 2.7：默认使用生产 endpoint，并允许显式覆盖", async () => {
    const defaultConfig = await resolveWbotConfig({ WBOT_API_KEY: "secret" });
    const overriddenConfig = await resolveWbotConfig({
      WBOT_API_KEY: "secret",
      WBOT_PLATFORM_URL: "http://localhost:8787",
    });

    expect(defaultConfig.baseUrl).toBe(DEFAULT_WBOT_PLATFORM_URL);
    expect(overriddenConfig.baseUrl).toBe("http://localhost:8787");
  });

  test("场景 2.3：非交互 auth set 立即失败并指引环境变量", async () => {
    const result = await runCli(["auth.set"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("interactive terminal");
    expect(result.stderr).toContain("WBOT_API_KEY");
  });

  test("场景 2.1：交互 auth set 隐藏输入并以 0600 保存", async () => {
    const configRoot = await createTemporaryDirectory();
    const secret = "wbot-interactive-secret";

    const result = await runInteractiveAuth(configRoot, secret);
    expect(result.exitCode, result.output).toBe(0);
    const stored = JSON.parse(await readCredentials(configRoot)) as {
      apiKey: string;
    };

    expect(result.output).not.toContain(secret);
    expect(stored.apiKey).toBe(secret);
    expect((await stat(credentialsPath(configRoot))).mode & 0o777).toBe(0o600);
  });
});

describe("功能 3 至 5：CLI 与 MCP 保持显式分页语义", () => {
  test("场景 3.1：CLI 成功结果是 stdout 中唯一的 JSON", async () => {
    const platform = await createFakePlatformServer({
      items: [],
      nextCursor: "next-conversation",
      hasMore: false,
    });

    const result = await runCli(["conversations.list"], {
      WBOT_API_KEY: "test-secret",
      WBOT_PLATFORM_URL: platform.url,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      items: [],
      nextCursor: "next-conversation",
      hasMore: false,
    });
  });

  test("场景 4.1 与 5.1：MCP 将 history 和 updates 分发到不同 Platform 方法", async () => {
    const calls: Array<{ kind: string; input: unknown }> = [];
    const fixture = await createMcpFixture(
      createPlatformClientStub({
        queryMessageHistory: async (input) => {
          calls.push({ kind: "history", input });
          return { items: [], nextCursor: "history-next", hasMore: true };
        },
        queryMessages: async (input) => {
          calls.push({ kind: "updates", input });
          return { items: [], nextCursor: "updates-next", hasMore: false };
        },
      }),
    );

    const history = await fixture.client.callTool({
      name: "read_message_history",
      arguments: { conversationId: "room-1", cursor: "history-cursor" },
    });
    const updates = await fixture.client.callTool({
      name: "read_message_updates",
      arguments: { conversationId: "room-1", cursor: "updates-cursor" },
    });

    expect(calls).toEqual([
      {
        kind: "history",
        input: {
          conversationId: "room-1",
          cursor: "history-cursor",
          limit: 50,
        },
      },
      {
        kind: "updates",
        input: {
          conversationId: "room-1",
          cursor: "updates-cursor",
          limit: 50,
        },
      },
    ]);
    expect(history.structuredContent).toEqual({
      result: { items: [], nextCursor: "history-next", hasMore: true },
    });
    expect(updates.structuredContent).toEqual({
      result: { items: [], nextCursor: "updates-next", hasMore: false },
    });
    await fixture.close();
  });
});

describe("功能 6 与 7：公共 package 和两个 Plugin 共享 runtime", () => {
  test("场景 7.1：@celados/wbot 只发布一个公共 executable", async () => {
    const packageJson = await readJson(new URL("./package.json", import.meta.url).pathname);

    expect(packageJson.name).toBe("@celados/wbot");
    expect(packageJson.private).toBe(true);
    expect(packageJson.bin).toEqual({ wbot: "./wbot-cli.ts" });
  });

  test("场景 6.1 至 6.3：Codex 与 Claude Plugin 启动相同 MCP 且不携带凭据", async () => {
    const codexMcp = await readJson<PluginMcpConfig>(
      new URL("../../plugins/codex/wbot/.mcp.json", import.meta.url).pathname,
    );
    const claudeMcp = await readJson<PluginMcpConfig>(
      new URL("../../plugins/claude/wbot/.mcp.json", import.meta.url).pathname,
    );
    const codexManifest = await readJson(
      new URL("../../plugins/codex/wbot/.codex-plugin/plugin.json", import.meta.url).pathname,
    );
    const claudeManifest = await readJson(
      new URL("../../plugins/claude/wbot/.claude-plugin/plugin.json", import.meta.url).pathname,
    );
    const claudeMarketplace = await readJson(
      new URL("../../plugins/claude/.claude-plugin/marketplace.json", import.meta.url).pathname,
    );

    expect(codexManifest.name).toBe("wbot");
    expect(claudeManifest.name).toBe("wbot");
    expect(claudeMarketplace.name).toBe("wbot");
    expect(claudeMarketplace.plugins).toEqual([
      expect.objectContaining({ name: "wbot", source: "./wbot" }),
    ]);
    expect(codexMcp).toEqual(claudeMcp);
    expect(codexMcp.mcpServers.wbot.args.slice(-2)).toEqual(["wbot", "mcp"]);
    expect(JSON.stringify({ codexMcp, claudeMcp })).not.toMatch(/api[_-]?key|secret|token/i);
  });

  test("场景 6.4：两个 Plugin 的 Agent 指引保持等价", async () => {
    const codexSkill = await readFile(
      new URL("../../plugins/codex/wbot/skills/wbot/SKILL.md", import.meta.url),
      "utf8",
    );
    const claudeSkill = await readFile(
      new URL("../../plugins/claude/wbot/skills/wbot/SKILL.md", import.meta.url),
      "utf8",
    );

    expect(codexSkill).toBe(claudeSkill);
    expect(codexSkill).toContain("read_message_history");
    expect(codexSkill).toContain("read_message_updates");
    expect(codexSkill).toMatch(/save|persist/i);
    expect(codexSkill).not.toMatch(/send_message|messages_send/);
  });
});

const runCli = async (args: Array<string>, environment: Record<string, string> = {}) => {
  const child = spawn("bun", ["run", cliEntry, ...args], {
    env: { PATH: requiredProcessEnv("PATH"), ...environment },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [exitCode] = (await once(child, "close")) as [number];
  return { stdout, stderr, exitCode };
};

const createMcpFixture = async (platformClient: PlatformClient) => {
  const server = createWbotMcpServer(platformClient);
  const client = new Client({ name: "wbot-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

const createPlatformClientStub = (overrides: Partial<PlatformClient> = {}): PlatformClient => ({
  queryConversations: async () => ({
    items: [],
    nextCursor: "conversation-cursor",
    hasMore: false,
  }),
  queryMessages: async () => ({
    items: [],
    nextCursor: "updates-cursor",
    hasMore: false,
  }),
  queryMessageHistory: async () => ({
    items: [],
    nextCursor: "history-cursor",
    hasMore: false,
  }),
  sendMessage: async () => ({
    outboundSendId: "send-1",
    conversationId: "room-1",
    status: "queued",
  }),
  getOutboundSend: async () => ({
    outboundSendId: "send-1",
    conversationId: "room-1",
    status: "accepted",
    reflectedMessageId: null,
  }),
  ...overrides,
});

const createTemporaryDirectory = async () => {
  const path = await mkdtemp(join(tmpdir(), "wbot-test-"));
  temporaryDirectories.push(path);
  return path;
};

const credentialsPath = (configRoot: string) => join(configRoot, "wbot", "credentials.json");

const writeCredentials = async (configRoot: string, apiKey: string, validJson = true) => {
  const path = credentialsPath(configRoot);
  await mkdir(join(configRoot, "wbot"), { recursive: true });
  await writeFile(path, validJson ? JSON.stringify({ apiKey }) : `{ "apiKey": "${apiKey}"`, {
    mode: 0o600,
  });
  expect((await stat(path)).isFile()).toBe(true);
};

const readCredentials = (configRoot: string) => readFile(credentialsPath(configRoot), "utf8");

const createFakePlatformServer = (body: unknown) =>
  new Promise<{ url: string }>((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(body));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Test server did not expose a TCP address"));
        return;
      }
      servers.push(server);
      resolve({ url: `http://127.0.0.1:${address.port}` });
    });
  });

const runInteractiveAuth = async (configRoot: string, secret: string) => {
  const scriptCommand =
    process.platform === "darwin"
      ? 'cat | script -q /dev/null bun run "$WBOT_CLI_ENTRY" auth.set'
      : "cat | script -q -c 'bun run \"$WBOT_CLI_ENTRY\" auth.set' /dev/null";
  const child = spawn("/bin/sh", ["-c", scriptCommand], {
    env: {
      PATH: requiredProcessEnv("PATH"),
      XDG_CONFIG_HOME: configRoot,
      WBOT_CLI_ENTRY: cliEntry,
    },
  });
  let output = "";
  let secretSent = false;
  const promptTimeout = setTimeout(() => child.kill(), 2_000);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const capture = (chunk: string) => {
    output += chunk;
    if (!secretSent && output.includes("API key: ")) {
      secretSent = true;
      child.stdin.end(`${secret}\n`);
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const [exitCode] = (await once(child, "close")) as [number];
  clearTimeout(promptTimeout);
  if (!secretSent) throw new Error(`Interactive auth prompt did not appear: ${output}`);
  return { output, exitCode };
};

const requiredProcessEnv = (name: string) => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is required for tests`);
  return value;
};

const readJson = async <Value = Record<string, unknown>>(path: string) =>
  JSON.parse(await readFile(path, "utf8")) as Value;
