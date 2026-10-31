#!/usr/bin/env bun

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { MAX_SEND_IMAGE_BYTES } from "./platform-client";

import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { c, cli, group } from "@celados/argc";
import * as v from "valibot";

import type { PlatformClient } from "./platform-client";

import packageJson from "./package.json" with { type: "json" };
import { createWbotPlatformClientFromEnvironment, storeWbotApiKey } from "./wbot-config";
import { runWbotMcpServer } from "./wbot-mcp";

const schema = toStandardJsonSchema;
const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const limit = v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)), 50);
const pageInput = v.strictObject({
  cursor: v.optional(nonEmptyString),
  limit,
});
const messagePageInput = v.strictObject({
  conversationId: nonEmptyString,
  cursor: v.optional(nonEmptyString),
  limit,
});
const messageSendInput = v.strictObject({
  conversationId: nonEmptyString,
  requestId: nonEmptyString,
  text: v.optional(nonEmptyString),
  imagePath: v.optional(nonEmptyString),
  requestedBy: nonEmptyString,
});
const outboundSendGetInput = v.strictObject({
  outboundSendId: nonEmptyString,
});

const commands = {
  auth: group(
    {
      description: "Configure local wbot credentials",
      hidden: true,
    },
    {
      set: c.meta({
        description: "Read and save an API key without echoing it",
      }),
    },
  ),
  conversations: group(
    { description: "Read wbot conversations" },
    {
      list: c
        .meta({ description: "List conversations this API key can read" })
        .input(schema(pageInput)),
    },
  ),
  messages: group(
    { description: "Read and send wbot messages" },
    {
      history: c
        .meta({ description: "Read newest messages and page backward" })
        .input(schema(messagePageInput)),
      updates: c
        .meta({ description: "Read messages forward from an updates cursor" })
        .input(schema(messagePageInput)),
      send: c
        .meta({
          description:
            "Queue text or one JPEG using exactly one of text/imagePath and a caller-owned requestId; not a delivery receipt",
        })
        .input(schema(messageSendInput)),
    },
  ),
  "outbound-sends": group(
    { description: "Inspect send outcomes" },
    {
      get: c
        .meta({
          description:
            "Get a send outcome; accepted is not delivered, and indeterminate must not be automatically resent",
        })
        .input(schema(outboundSendGetInput)),
    },
  ),
  mcp: c.meta({
    description: "Start the read-only wbot MCP server over stdio",
  }),
};

const app = cli(commands, {
  name: "wbot",
  version: packageJson.version,
  description: "Read WeChat conversations and send authorized text or JPEG images through wbot",
});

export const runWbotCli = async () => {
  const callPlatform = async <Result>(operation: (client: PlatformClient) => Promise<Result>) =>
    operation(await createWbotPlatformClientFromEnvironment(process.env));

  await app.run({
    handlers: {
      auth: {
        set: async () => {
          const apiKey = await readHiddenApiKey();
          const path = await storeWbotApiKey(process.env, apiKey);
          return JSON.stringify({ configured: true, path });
        },
      },
      conversations: {
        list: async (args) =>
          JSON.stringify(await callPlatform((client) => client.queryConversations(args.input))),
      },
      messages: {
        history: async (args) =>
          JSON.stringify(await callPlatform((client) => client.queryMessageHistory(args.input))),
        updates: async (args) =>
          JSON.stringify(await callPlatform((client) => client.queryMessages(args.input))),
        send: async (args) => {
          const { text, imagePath, ...identity } = args.input;
          if ((text === undefined) === (imagePath === undefined)) {
            throw new Error("Specify exactly one of text or imagePath");
          }
          const input =
            imagePath === undefined
              ? { ...identity, text: text! }
              : {
                  ...identity,
                  content: { kind: "image" as const, base64: await readImageFile(imagePath) },
                };
          return JSON.stringify(await callPlatform((client) => client.sendMessage(input)));
        },
      },
      "outbound-sends": {
        get: async (args) =>
          JSON.stringify(await callPlatform((client) => client.getOutboundSend(args.input))),
      },
      mcp: runWbotMcpServer,
    },
  });
};

if (import.meta.main) await runWbotCli();

async function readHiddenApiKey() {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error(
      "`wbot auth set` requires an interactive terminal. Set WBOT_API_KEY for automation.",
    );
  }
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();
  process.stderr.write("API key: ");
  try {
    return await new Promise<string>((resolve, reject) => {
      let secret = "";
      const onData = (chunk: string) => {
        for (const character of chunk) {
          if (character === "\u0003") {
            cleanup();
            reject(new Error("wbot credential setup cancelled."));
            return;
          }
          if (character === "\r" || character === "\n") {
            cleanup();
            if (secret.length === 0) {
              reject(new Error("wbot API key must be non-empty."));
            } else {
              resolve(secret);
            }
            return;
          }
          if (character === "\u007f" || character === "\b") {
            secret = secret.slice(0, -1);
          } else {
            secret += character;
          }
        }
      };
      const cleanup = () => {
        input.off("data", onData);
      };
      input.on("data", onData);
    });
  } finally {
    input.setRawMode(false);
    input.pause();
    process.stderr.write("\n");
  }
}

async function readImageFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_SEND_IMAGE_BYTES) {
      throw new Error("Expected a regular JPEG file within 5 MiB");
    }
    const bytes = Buffer.alloc(MAX_SEND_IMAGE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_SEND_IMAGE_BYTES) throw new Error("Image exceeds 5 MiB");
    return bytes.subarray(0, size).toString("base64");
  } finally {
    await file.close();
  }
}
