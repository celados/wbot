import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterEach, expect, test } from "vitest";

const cliEntry = new URL("./wbot-cli.ts", import.meta.url).pathname;
const servers: Server[] = [];
const directories: string[] = [];
const input = {
  conversationId: "room-1",
  requestId: "digest:2026-09-21:room-1",
  text: 'Daily summary\n"Hello" — 你好 👋',
  requestedBy: "agent:grok",
};
const queued = { outboundSendId: "send-1", conversationId: "room-1", status: "queued" };

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
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
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const contentType = request.headers["content-type"] ?? "";
    let requestBody: unknown;
    if (contentType.startsWith("multipart/form-data; boundary=")) {
      const form = await new Response(raw, { headers: { "Content-Type": contentType } }).formData();
      const image = form.get("image") as File;
      requestBody = {
        metadata: JSON.parse(String(form.get("metadata"))),
        image: Array.from(new Uint8Array(await image.arrayBuffer())),
        imageType: image.type,
        imageName: image.name,
        parts: [...form.keys()],
      };
    } else {
      requestBody = JSON.parse(raw.toString());
    }

    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body: requestBody,
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

const jpeg = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]); // Transport fixture; Platform validates full image structure.
const imageFixture = async (bytes = jpeg) => {
  const directory = await mkdtemp(join(tmpdir(), "wbot-image-"));
  directories.push(directory);
  const imagePath = join(directory, "private-local-name.jpg");
  await writeFile(imagePath, bytes);
  const { text: _, ...identity } = input;
  return { directory, args: { ...identity, imagePath } };
};

test("CLI sends exact JPEG multipart bytes and identity without exposing its local path", async () => {
  const fixture = await createFixture(200, queued);
  const image = await imageFixture();
  const result = await runCli("messages.send", image.args, fixture.url);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(queued);
  const { text: _, ...identity } = input;
  expect(fixture.requests).toEqual([
    {
      method: "POST",
      path: "/platform/v1/messages/send",
      authorization: "Bearer fixture-secret",
      body: {
        metadata: { ...identity, content: { kind: "image" } },
        image: Array.from(jpeg),
        imageType: "image/jpeg",
        imageName: "image.jpg",
        parts: ["metadata", "image"],
      },
    },
  ]);
  expect(JSON.stringify(fixture.requests)).not.toContain(image.args.imagePath);
});

test("image file failures and mutually exclusive inputs never contact Platform", async () => {
  const fixture = await createFixture(200, queued);
  const image = await imageFixture();
  const empty = await imageFixture(Buffer.alloc(0));
  const oversize = await imageFixture(Buffer.alloc(5 * 1024 * 1024 + 1));
  const png = await imageFixture(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  for (const args of [
    { ...image.args, text: "mixed" },
    { ...image.args, imagePath: image.directory },
    { ...image.args, imagePath: join(image.directory, "missing.jpg") },
    empty.args,
    oversize.args,
    png.args,
  ]) {
    const result = await runCli("messages.send", args, fixture.url);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
  }
  expect(fixture.requests).toHaveLength(0);
});

test.each(["drop", "conflict", "malformed"])(
  "image %s failure never retries or leaks content",
  async (mode) => {
    const fixture = await createFixture(
      mode === "conflict" ? 409 : 200,
      mode === "conflict"
        ? { error: { code: "conflict", message: "Conflicting request" } }
        : { ...queued, status: "delivered", privateDetail: "private-response" },
      mode === "drop",
    );
    const image = await imageFixture();
    const result = await runCli("messages.send", image.args, fixture.url);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(fixture.requests).toHaveLength(1);
    expect(result.stderr).not.toContain("fixture-secret");
    expect(result.stderr).not.toContain("private-response");
    expect(result.stderr).not.toContain(jpeg.toString("base64"));
  },
);

test("a JPEG at the 5 MiB boundary is submitted once", async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024);
  bytes[0] = 255;
  bytes[1] = 216;
  bytes[bytes.length - 2] = 255;
  bytes[bytes.length - 1] = 217;
  const image = await imageFixture(bytes);
  const fixture = await createFixture(200, queued);
  const result = await runCli("messages.send", image.args, fixture.url);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(fixture.requests).toHaveLength(1);
  expect((fixture.requests[0]!.body as { image: number[] }).image).toHaveLength(bytes.length);
});
