import type { Server } from "node:http";

import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_WBOT_PLATFORM_URL, resolveWbotConfig } from "./wbot-config";

const packageRoot = new URL(".", import.meta.url).pathname;
const cliEntry = join(packageRoot, "wbot-cli.ts");
const servers: Array<Server> = [];

type FixtureOverrides = {
  environment?: Record<string, string>;
};

const createFixture = (overrides: FixtureOverrides = {}) => ({
  environment: {
    WBOT_API_KEY: "fixture-secret",
    ...overrides.environment,
  },
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
});

describe("功能 1：外部用户只看到一个产品入口", () => {
  test("场景 1.1：安装产物只提供 wbot 命令", async () => {
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };

    expect(packageJson.bin).toEqual({ wbot: "./wbot-cli.ts" });
  });

  test("场景 1.2：Agent 通过 wbot 使用只读 CLI", async () => {
    const result = await runCli(["@schema"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/conversations:\s*\{[\s\S]*list\(input:/);
    expect(result.stdout).toMatch(/messages:\s*\{[\s\S]*history\(input:/);
    expect(result.stdout).toMatch(/messages:\s*\{[\s\S]*updates\(input:/);
    expect(result.stdout).toContain("mcp()");
    expect(result.stdout).not.toMatch(/send\(input:|outbound-sends|operator/i);
  });

  test("场景 1.3：MCP host 通过 wbot mcp 启动服务", async () => {
    const fixture = await createStdioMcpFixture();

    const result = await fixture.client.listTools();

    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "list_conversations",
      "read_message_history",
      "read_message_updates",
    ]);
    expect(result.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    await fixture.close();
  });
});

describe("功能 2：环境选择不扩张公开命令面", () => {
  test("场景 2.1：默认连接生产服务", async () => {
    const config = await resolveWbotConfig(createFixture().environment);

    expect(config.baseUrl).toBe(DEFAULT_WBOT_PLATFORM_URL);
  });

  test("场景 2.2：内部 dogfood 显式连接测试服务", async () => {
    const platformUrl = await createPlatformServer(200, {
      items: [],
      nextCursor: "next-conversation",
      hasMore: false,
    });
    const fixture = createFixture({ environment: { WBOT_PLATFORM_URL: platformUrl } });

    const cliResult = await runCli(["conversations.list"], fixture.environment);
    const mcp = await createStdioMcpFixture(fixture.environment);
    const mcpResult = await mcp.client.callTool({ name: "list_conversations", arguments: {} });

    expect(cliResult.exitCode, cliResult.stderr).toBe(0);
    expect(JSON.parse(cliResult.stdout)).toEqual({
      items: [],
      nextCursor: "next-conversation",
      hasMore: false,
    });
    expect(mcpResult.isError, JSON.stringify(mcpResult)).not.toBe(true);
    expect(mcpResult.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(
          { items: [], nextCursor: "next-conversation", hasMore: false },
          null,
          2,
        ),
      },
    ]);
    await mcp.close();
  });

  test("场景 2.3：环境与 API Key 不匹配时明确失败", async () => {
    const platformUrl = await createPlatformServer(401, {
      error: { code: "unauthorized", message: "Unauthorized" },
    });
    const apiKey = "environment-mismatch-secret";

    const result = await runCli(["conversations.list"], {
      WBOT_API_KEY: apiKey,
      WBOT_PLATFORM_URL: platformUrl,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unauthorized");
    expect(result.stderr).not.toContain(apiKey);
  });
});

describe("功能 3：Plugin 复用公开入口", () => {
  test("场景 3.1：Codex 与 Claude Code Plugin 启动同一个 MCP 入口", async () => {
    const codex = await readJson(join(packageRoot, "../../plugins/codex/wbot/.mcp.json"));
    const claude = await readJson(join(packageRoot, "../../plugins/claude/wbot/.mcp.json"));

    expect(codex).toEqual(claude);
    expect(codex.mcpServers.wbot.args.slice(-2)).toEqual(["wbot", "mcp"]);
    expect(JSON.stringify(codex)).not.toMatch(/api[_-]?key|secret|token/i);
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

const createStdioMcpFixture = async (environment: Record<string, string> = {}) => {
  const client = new Client({ name: "wbot-public-entrypoint-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", cliEntry, "mcp"],
    env: {
      PATH: requiredProcessEnv("PATH"),
      WBOT_API_KEY: "fixture-secret",
      ...environment,
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  return {
    client,
    close: () => client.close(),
  };
};

const createPlatformServer = (statusCode: number, body: unknown) =>
  new Promise<string>((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.statusCode = statusCode;
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
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

const requiredProcessEnv = (name: string) => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is required for tests`);
  return value;
};
