import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, test } from "vitest";

import {
  createPlatformClient,
  maxRateLimitRetryWaitMs,
  PlatformRequestError,
} from "./platform-client";

const cliEntry = new URL("./wbot-cli.ts", import.meta.url).pathname;
const servers: Array<Server> = [];
const page = { items: [], nextCursor: "cursor", hasMore: false };
const updates = {
  ...page,
  captureFreshness: { status: "current", asOfMs: "1788739200000" },
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

const rateLimitedBody = (retryAfterMs: number) => ({
  error: { code: "rate_limited", message: "Rate limit exceeded", retryAfterMs },
});

const rateLimited = (retryAfterSeconds: string | null, retryAfterMs = 1500) =>
  Response.json(rateLimitedBody(retryAfterMs), {
    status: 429,
    headers: retryAfterSeconds === null ? {} : { "Retry-After": retryAfterSeconds },
  });

const harness = (responses: Array<() => Response>) => {
  const calls: Array<string> = [];
  const sleeps: Array<number> = [];
  const client = createPlatformClient({
    baseUrl: "https://platform.test",
    tenantApiKey: "fixture-secret",
    fetch: async (url) => {
      calls.push(new URL(String(url)).pathname);
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected request");
      return next();
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, calls, sleeps };
};

describe("功能：共享 Platform client 遵守 429 Retry-After", () => {
  test("收到 429 后按 Retry-After 等待并重试一次", async () => {
    const { client, calls, sleeps } = harness([() => rateLimited("2"), () => Response.json(page)]);

    expect(await client.queryConversations()).toEqual(page);
    expect(sleeps).toEqual([2000]);
    expect(calls).toEqual(["/platform/v1/conversations/query", "/platform/v1/conversations/query"]);
  });

  test("重试后仍为 429 时抛出 typed rate_limited 错误且不再第三次请求", async () => {
    const { client, calls, sleeps } = harness([
      () => rateLimited("1"),
      () => rateLimited("3", 2500),
    ]);

    const error = await client
      .queryMessages({ conversationId: "room-1" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformRequestError);
    expect(error).toMatchObject({ status: 429, code: "rate_limited", retryAfterMs: 3000 });
    expect(String(error)).toContain("retry after 3s");
    expect(sleeps).toEqual([1000]);
    expect(calls).toHaveLength(2);
  });

  test("缺少头时回退到正文 retryAfterMs，并限制最长等待", async () => {
    const missingHeader = harness([() => rateLimited(null, 750), () => Response.json(page)]);
    const hugeHeader = harness([() => rateLimited("3600"), () => Response.json(page)]);

    await missingHeader.client.queryConversations();
    await hugeHeader.client.queryConversations();

    expect(missingHeader.sleeps).toEqual([750]);
    expect(hugeHeader.sleeps).toEqual([maxRateLimitRetryWaitMs]);
  });

  test("发送在 429 后以同一请求重试一次", async () => {
    const queued = { outboundSendId: "send-1", conversationId: "room-1", status: "queued" };
    const bodies: Array<string> = [];
    const responses = [() => rateLimited("1"), () => Response.json(queued)];
    const client = createPlatformClient({
      baseUrl: "https://platform.test",
      tenantApiKey: "fixture-secret",
      fetch: async (_url, init) => {
        bodies.push(String(init?.body));
        return responses.shift()!();
      },
      sleep: async () => {},
    });
    const input = {
      conversationId: "room-1",
      requestId: "digest:1",
      text: "hi",
      requestedBy: "agent:test",
    };

    expect(await client.sendMessage(input)).toEqual(queued);
    expect(bodies).toEqual([JSON.stringify(input), JSON.stringify(input)]);
  });

  test("非 429 错误不重试", async () => {
    const { client, calls, sleeps } = harness([
      () => Response.json({ error: { code: "forbidden", message: "Forbidden" } }, { status: 403 }),
    ]);

    await expect(client.queryConversations()).rejects.toMatchObject({
      code: "forbidden",
      retryAfterMs: null,
    });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});

describe("功能：CLI 与 MCP 入口共享 429 处理", () => {
  test("CLI 在一次 429 后成功返回 JSON", async () => {
    const fixture = await createPlatformServer([429, 200], page);
    const result = await runCli(["conversations.list"], fixture.url);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(page);
    expect(fixture.requests).toBe(2);
  });

  test("CLI 连续 429 时报告 rate_limited 并退出非零", async () => {
    const fixture = await createPlatformServer([429, 429], page);
    const result = await runCli(["conversations.list"], fixture.url);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("rate_limited");
    expect(result.stderr).not.toContain("fixture-secret");
    expect(fixture.requests).toBe(2);
  });

  test("MCP 工具在一次 429 后成功，连续 429 返回 rate_limited 错误", async () => {
    const recovering = await createPlatformServer([429, 200], updates);
    const recoveringMcp = await connectMcp(recovering.url);
    const ok = await recoveringMcp.callTool({
      name: "read_message_updates",
      arguments: { conversationId: "room-1" },
    });
    await recoveringMcp.close();

    expect(ok.isError).not.toBe(true);
    expect(ok.structuredContent).toEqual({ result: updates });
    expect(recovering.requests).toBe(2);

    const limited = await createPlatformServer([429, 429], updates);
    const limitedMcp = await connectMcp(limited.url);
    const failed = await limitedMcp.callTool({
      name: "list_conversations",
      arguments: {},
    });
    await limitedMcp.close();

    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain("rate_limited");
    expect(limited.requests).toBe(2);
  });
});

const createPlatformServer = async (statuses: Array<number>, body: unknown) => {
  const state = { requests: 0 };
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      state.requests += 1;
      const status = statuses.shift() ?? 500;
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(status === 429 ? rateLimitedBody(20) : body));
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    get requests() {
      return state.requests;
    },
  };
};

const runCli = async (args: Array<string>, platformUrl: string) => {
  const child = spawn("bun", ["run", cliEntry, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      WBOT_API_KEY: "fixture-secret",
      WBOT_PLATFORM_URL: platformUrl,
    },
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

const connectMcp = async (platformUrl: string) => {
  const client = new Client({ name: "wbot-rate-limit-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: "bun",
      args: ["run", cliEntry, "mcp"],
      env: {
        PATH: process.env.PATH ?? "",
        WBOT_API_KEY: "fixture-secret",
        WBOT_PLATFORM_URL: platformUrl,
      },
      stderr: "pipe",
    }),
  );
  return client;
};
