import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { PlatformClient } from "./platform-client";

import { createWbotPlatformClientFromEnvironment } from "./wbot-config";

type PlatformClientSource = PlatformClient | (() => PlatformClient | Promise<PlatformClient>);

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export const createWbotMcpServer = (clientSource: PlatformClientSource) => {
  const server = new McpServer({ name: "wbot", version: "0.1.2" });

  server.registerTool(
    "list_conversations",
    {
      title: "List conversations",
      description: "List the WeChat conversations this wbot API key can read.",
      inputSchema: {
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
      annotations: READ_ONLY,
    },
    (input) => callTool(clientSource, (client) => client.queryConversations(input)),
  );

  server.registerTool(
    "read_message_history",
    {
      title: "Read message history",
      description:
        "Read the newest available messages, then page backward with the returned history cursor.",
      inputSchema: {
        conversationId: z.string().min(1),
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
      annotations: READ_ONLY,
    },
    (input) => callTool(clientSource, (client) => client.queryMessageHistory(input)),
  );

  server.registerTool(
    "read_message_updates",
    {
      title: "Read message updates",
      description:
        "Read messages forward from an updates cursor; persist the returned cursor in the caller.",
      inputSchema: {
        conversationId: z.string().min(1),
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
      annotations: READ_ONLY,
    },
    (input) => callTool(clientSource, (client) => client.queryMessages(input)),
  );

  return server;
};

export const runWbotMcpServer = async () => {
  const server = createWbotMcpServer(() => createWbotPlatformClientFromEnvironment(process.env));
  await server.connect(new StdioServerTransport());
};

const callTool = async <Result>(
  clientSource: PlatformClientSource,
  operation: (client: PlatformClient) => Promise<Result>,
) => {
  try {
    const client = await (typeof clientSource === "function" ? clientSource() : clientSource);
    const result = await operation(client);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { result },
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : "wbot request failed",
        },
      ],
    };
  }
};
