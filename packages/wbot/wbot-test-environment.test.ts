import type { Server } from "node:http";

import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_WBOT_PLATFORM_URL,
  DEFAULT_WBOT_TEST_PLATFORM_URL,
  resolveWbotConfig,
} from "./wbot-config";

type FixtureOverrides = {
  defaultPlatformUrl?: string;
  environment?: Record<string, string>;
};

const packageRoot = new URL(".", import.meta.url).pathname;
const productionCliEntry = join(packageRoot, "wbot-cli.ts");
const testCliEntry = join(packageRoot, "wbot-test-cli.ts");
const productionMcpEntry = join(packageRoot, "wbot-mcp-entry.ts");
const testMcpEntry = join(packageRoot, "wbot-test-mcp-entry.ts");
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
});

const createFixture = (overrides: FixtureOverrides = {}) => ({
  defaultPlatformUrl: overrides.defaultPlatformUrl ?? DEFAULT_WBOT_PLATFORM_URL,
  environment: {
    WBOT_API_KEY: "fixture-secret",
    ...overrides.environment,
  },
});

describe("功能 1：Agent 连接签发 API Key 的对应环境", () => {
  test.each([
    {
      entry: "wbot",
      defaultPlatformUrl: DEFAULT_WBOT_PLATFORM_URL,
      expected: "https://wbot-api-prod.celados.com",
    },
    {
      entry: "wbot-test",
      defaultPlatformUrl: DEFAULT_WBOT_TEST_PLATFORM_URL,
      expected: "https://wbot-api-test.celados.com",
    },
  ])("场景 1.1 与 1.2：$entry 选择 $expected", async (row) => {
    const fixture = createFixture({ defaultPlatformUrl: row.defaultPlatformUrl });

    const config = await resolveWbotConfig(fixture.environment, fixture.defaultPlatformUrl);

    expect(config.baseUrl).toBe(row.expected);
  });

  test("场景 1.3：测试入口复用现有凭据规则", async () => {
    const fixture = createFixture({
      defaultPlatformUrl: DEFAULT_WBOT_TEST_PLATFORM_URL,
      environment: { WBOT_PLATFORM_URL: "http://localhost:8787" },
    });

    const config = await resolveWbotConfig(fixture.environment, fixture.defaultPlatformUrl);

    expect(config).toEqual({
      apiKey: "fixture-secret",
      baseUrl: "http://localhost:8787",
    });
  });

  test("场景 1.4：环境与 API Key 不匹配时明确失败", async () => {
    const platformUrl = await createUnauthorizedPlatformServer();
    const apiKey = "environment-mismatch-secret";

    const result = await runCli(testCliEntry, ["conversations.list"], {
      WBOT_API_KEY: apiKey,
      WBOT_PLATFORM_URL: platformUrl,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unauthorized");
    expect(result.stderr).not.toContain(apiKey);
  });
});

describe("功能 2：测试入口不复制产品能力", () => {
  test("场景 2.1：一个 package 同时提供正式和测试入口", async () => {
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };

    expect(packageJson.bin).toEqual({
      wbot: "./wbot-cli.ts",
      "wbot-mcp": "./wbot-mcp-entry.ts",
      "wbot-test": "./wbot-test-cli.ts",
      "wbot-test-mcp": "./wbot-test-mcp-entry.ts",
    });
    await Promise.all(
      Object.values(packageJson.bin).map((relativePath) => access(join(packageRoot, relativePath))),
    );
  });

  test("场景 2.2：测试 CLI 与正式 CLI 暴露相同命令", async () => {
    const [productionSchema, testSchema] = await Promise.all([
      runCli(productionCliEntry, ["@schema"]),
      runCli(testCliEntry, ["@schema"]),
    ]);

    expect(productionSchema.exitCode, productionSchema.stderr).toBe(0);
    expect(testSchema.exitCode, testSchema.stderr).toBe(0);
    expect(testSchema.stdout).toBe(productionSchema.stdout);
  });

  test("场景 2.3：测试 MCP 与正式 MCP 暴露相同工具", async () => {
    const production = await createStdioMcpFixture(productionMcpEntry);
    const testEnvironment = await createStdioMcpFixture(testMcpEntry);

    const [productionTools, testTools] = await Promise.all([
      production.client.listTools(),
      testEnvironment.client.listTools(),
    ]);

    expect(testTools.tools).toEqual(productionTools.tools);
    expect(testTools.tools.map((tool) => tool.name).sort()).toEqual([
      "list_conversations",
      "read_message_history",
      "read_message_updates",
    ]);
    await Promise.all([production.close(), testEnvironment.close()]);
  });
});

const runCli = async (
  entry: string,
  args: Array<string>,
  environment: Record<string, string> = {},
) => {
  const child = spawn("bun", ["run", entry, ...args], {
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

const requiredProcessEnv = (name: string) => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is required for tests`);
  return value;
};

const createUnauthorizedPlatformServer = () =>
  new Promise<string>((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.statusCode = 401;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          error: { code: "unauthorized", message: "Unauthorized" },
        }),
      );
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

const createStdioMcpFixture = async (entry: string) => {
  const client = new Client({ name: "wbot-test-suite", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", entry],
    env: {
      PATH: requiredProcessEnv("PATH"),
      WBOT_API_KEY: "fixture-secret",
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  return {
    client,
    close: () => client.close(),
  };
};
