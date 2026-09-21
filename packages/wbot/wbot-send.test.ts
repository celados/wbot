import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterEach, expect, test } from "vitest";

const cliEntry = new URL("./wbot-cli.ts", import.meta.url).pathname;
const servers: Server[] = [];
const input = {
  conversationId: "room-1",
  requestId: "digest:2026-09-21:room-1",
  text: 'Daily summary\n"Hello" — 你好 👋',
  requestedBy: "agent:grok",
};
const queued = { outboundSendId: "send-1", conversationId: "room-1", status: "queued" };

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

test("CLI forwards authenticated sends and caller-owned idempotency unchanged", async () => {
  const fixture = await createFixture(200, queued);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runCli("messages.send", input, fixture.url);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(queued);
  }
  expect(fixture.requests).toEqual(
    Array.from({ length: 2 }, () => ({
      method: "POST",
      path: "/platform/v1/messages/send",
      authorization: "Bearer fixture-secret",
      body: input,
    })),
  );
});

test.each([
  ...Object.keys(input).map((key) =>
    Object.fromEntries(Object.entries(input).filter(([name]) => name !== key)),
  ),
  ...Object.keys(input).map((key) => ({ ...input, [key]: "" })),
  { ...input, text: 42 },
  { ...input, requestId: null },
  { ...input, extra: true },
])("invalid send input never reaches Platform: %j", async (invalidInput) => {
  const fixture = await createFixture(200, queued);
  const result = await runCli("messages.send", invalidInput, fixture.url);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(fixture.requests).toHaveLength(0);
});

test.each(["queued", "processing", "accepted", "failed", "indeterminate"])(
  "lookup preserves %s without sending or polling",
  async (status) => {
    const body = {
      ...queued,
      status,
      reflectedMessageId: status === "accepted" ? "message-1" : null,
      futureField: true,
    };
    const fixture = await createFixture(200, body);
    const result = await runCli("outbound-sends.get", { outboundSendId: "send-1" }, fixture.url);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(body);
    expect(fixture.requests).toEqual([
      {
        method: "POST",
        path: "/platform/v1/outbound-sends/get",
        authorization: "Bearer fixture-secret",
        body: { outboundSendId: "send-1" },
      },
    ]);
  },
);

test.each([
  {},
  { outboundSendId: "" },
  { outboundSendId: 42 },
  { outboundSendId: "send-1", extra: true },
])("invalid lookup input never reaches Platform: %j", async (invalidInput) => {
  const fixture = await createFixture(200, queued);
  const result = await runCli("outbound-sends.get", invalidInput, fixture.url);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(fixture.requests).toHaveLength(0);
});

test.each([
  [401, "unauthorized", "Unauthorized"],
  [403, "forbidden", "Tenant cannot send to this conversation"],
  [409, "conflict", "Idempotency key conflicts with an existing send"],
  [500, "internal_error", "Platform temporarily unavailable"],
] as const)("send failure %s is reported without retry", async (status, code, message) => {
  const fixture = await createFixture(status, { error: { code, message } });
  const result = await runCli("messages.send", input, fixture.url);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toContain("fixture-secret");
  expect(fixture.requests).toHaveLength(1);
});

test.each(["messages.send", "outbound-sends.get"])(
  "%s validates successful responses without leaking payloads",
  async (command) => {
    const fixture = await createFixture(200, {
      ...queued,
      status: "delivered",
      privateDetail: "sensitive-response-body",
    });
    const result = await runCli(
      command,
      command === "messages.send" ? input : { outboundSendId: "send-1" },
      fixture.url,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid response");
    expect(result.stderr).not.toContain("sensitive-response-body");
    expect(result.stderr).not.toContain("fixture-secret");
    expect(fixture.requests).toHaveLength(1);
  },
);

test("a dropped send connection is not automatically retried", async () => {
  const fixture = await createFixture(200, null, true);
  const result = await runCli("messages.send", input, fixture.url);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(fixture.requests).toHaveLength(1);
});

const runCli = async (command: string, body: unknown, url: string) => {
  const child = spawn("bun", ["run", cliEntry, command, JSON.stringify(body)], {
    env: { PATH: process.env.PATH, WBOT_PLATFORM_URL: url, WBOT_API_KEY: "fixture-secret" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [exitCode] = await once(child, "close");
  return { exitCode, stdout, stderr };
};

const createFixture = async (status: number, body: unknown, dropConnection = false) => {
  const requests: Array<{ method?: string; path?: string; authorization?: string; body: unknown }> =
    [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk.toString();
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(raw),
    });
    if (dropConnection) {
      request.socket.destroy();
      return;
    }
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP fixture address");
  return { url: `http://127.0.0.1:${address.port}`, requests };
};
