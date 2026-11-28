import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import type { PlatformClient } from './platform-client'

import packageJson from './package.json' with { type: 'json' }
import { createWbotPlatformClientFromEnvironment } from './wbot-config'

type PlatformClientSource =
	| PlatformClient
	| (() => PlatformClient | Promise<PlatformClient>)

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const

export const createWbotMcpServer = (clientSource: PlatformClientSource) => {
	const server = new McpServer({ name: 'wbot', version: packageJson.version })

	server.registerTool(
		'list_accounts',
		{
			title: 'List accounts',
			description:
				'List the accounts behind readable conversations, with capabilities and capture freshness. Use freshness to tell a quiet conversation from delayed or unavailable capture.',
			annotations: READ_ONLY,
		},
		() => callTool(clientSource, (client) => client.listAccounts()),
	)

	server.registerTool(
		'list_conversations',
		{
			title: 'List conversations',
			description:
				'List every WeChat conversation this wbot API key can read, most recent activity first. Not paginated; do not poll it for new messages.',
			annotations: READ_ONLY,
		},
		() => callTool(clientSource, (client) => client.listConversations()),
	)

	server.registerTool(
		'read_message_history',
		{
			title: 'Read message history',
			description:
				'Read the newest messages (oldest first within a page), then page backward with the returned nextCursor.',
			inputSchema: {
				conversationId: z.string().min(1),
				cursor: z.string().min(1).optional(),
				limit: z.number().int().min(1).max(100).default(50),
			},
			annotations: READ_ONLY,
		},
		(input) => callTool(clientSource, (client) => client.listMessages(input)),
	)

	server.registerTool(
		'read_message_updates',
		{
			title: 'Read message updates',
			description:
				'Read message changes forward from a saved cursor until hasMore is false; merge messages by id and revision. Without a cursor it returns no items and a tail cursor. Persist nextCursor in the caller.',
			inputSchema: {
				conversationId: z.string().min(1),
				cursor: z.string().min(1).optional(),
				limit: z.number().int().min(1).max(100).default(50),
			},
			annotations: READ_ONLY,
		},
		(input) => callTool(clientSource, (client) => client.listChanges(input)),
	)

	server.registerTool(
		'get_message',
		{
			title: 'Get message',
			description:
				'Get the latest projection of one message, with a freshly signed attachment URL.',
			inputSchema: {
				conversationId: z.string().min(1),
				messageId: z.string().min(1),
			},
			annotations: READ_ONLY,
		},
		(input) => callTool(clientSource, (client) => client.getMessage(input)),
	)

	return server
}

export const runWbotMcpServer = async () => {
	const server = createWbotMcpServer(() =>
		createWbotPlatformClientFromEnvironment(process.env),
	)
	await server.connect(new StdioServerTransport())
}

const callTool = async <Result>(
	clientSource: PlatformClientSource,
	operation: (client: PlatformClient) => Promise<Result>,
) => {
	try {
		const client = await (typeof clientSource === 'function'
			? clientSource()
			: clientSource)
		const result = await operation(client)
		return {
			content: [
				{ type: 'text' as const, text: JSON.stringify(result, null, 2) },
			],
			structuredContent: { result },
		}
	} catch (error) {
		return {
			isError: true,
			content: [
				{
					type: 'text' as const,
					text: error instanceof Error ? error.message : 'wbot request failed',
				},
			],
		}
	}
}
