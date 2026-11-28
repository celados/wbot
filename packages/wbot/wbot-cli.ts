#!/usr/bin/env bun

import { c, cli, group } from '@celados/argc'
import { toStandardJsonSchema } from '@valibot/to-json-schema'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import * as v from 'valibot'

import type { WbotClient } from './platform-client'

import packageJson from './package.json' with { type: 'json' }
import { MAX_SEND_IMAGE_BYTES } from './platform-client'
import {
	createWbotPlatformClientFromEnvironment,
	storeWbotApiKey,
} from './wbot-config'
import { runWbotMcpServer } from './wbot-mcp'

const schema = toStandardJsonSchema
const nonEmptyString = v.pipe(v.string(), v.minLength(1))
const envVarName = v.pipe(v.string(), v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
const limit = v.optional(
	v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
	50,
)
const messagePageInput = v.strictObject({
	conversationId: nonEmptyString,
	cursor: v.optional(nonEmptyString),
	limit,
})
const messageGetInput = v.strictObject({
	conversationId: nonEmptyString,
	messageId: nonEmptyString,
})
const messageSendInput = v.strictObject({
	conversationId: nonEmptyString,
	requestId: nonEmptyString,
	text: v.optional(nonEmptyString),
	imagePath: v.optional(nonEmptyString),
	requestedBy: nonEmptyString,
})
const outboundSendGetInput = v.strictObject({
	outboundSendId: nonEmptyString,
})

const webhookConversationIdsInput = v.nullable(
	v.pipe(v.array(nonEmptyString), v.minLength(1), v.maxLength(100)),
)
const webhookIdInput = v.strictObject({ webhookId: nonEmptyString })
const webhookCreateInput = v.strictObject({
	url: v.pipe(nonEmptyString, v.maxLength(2048)),
	conversationIds: v.optional(webhookConversationIdsInput),
	signingSecretEnv: v.optional(envVarName, 'WBOT_WEBHOOK_SIGNING_SECRET'),
})
const webhookUpdateInput = v.strictObject({
	webhookId: nonEmptyString,
	url: v.optional(v.pipe(nonEmptyString, v.maxLength(2048))),
	conversationIds: v.optional(webhookConversationIdsInput),
	status: v.optional(v.picklist(['active', 'disabled'])),
	rotateSecret: v.optional(v.boolean()),
	signingSecretEnv: v.optional(envVarName),
})
const webhookRetryInput = v.strictObject({
	webhookId: nonEmptyString,
	conversationId: v.optional(nonEmptyString),
})

const commands = {
	webhooks: group(
		{ description: 'Manage Platform v2 HTTPS doorbell webhook endpoints' },
		{
			create: c
				.meta({
					description:
						'Create a webhook endpoint (omit conversationIds for all read-granted conversations); read signing secret from an environment variable',
				})
				.input(schema(webhookCreateInput)),
			list: c.meta({
				description:
					'List webhook endpoints and derived delivery health summaries',
			}),
			get: c
				.meta({
					description:
						'Get one webhook endpoint with per-conversation delivery states',
				})
				.input(schema(webhookIdInput)),
			update: c
				.meta({
					description:
						'Update URL, conversationIds, status, or rotate the signing secret from an environment variable',
				})
				.input(schema(webhookUpdateInput)),
			retry: c
				.meta({
					description:
						'Retry failed or cancelled deliveries on a webhook endpoint; does not consume messages',
				})
				.input(schema(webhookRetryInput)),
			delete: c
				.meta({ description: 'Delete a webhook endpoint' })
				.input(schema(webhookIdInput)),
		},
	),
	auth: group(
		{
			description: 'Configure local wbot credentials',
			hidden: true,
		},
		{
			set: c.meta({
				description: 'Read and save an API key without echoing it',
			}),
		},
	),
	accounts: group(
		{ description: 'Read the accounts behind readable conversations' },
		{
			list: c.meta({
				description:
					'List accounts with capabilities and capture freshness (quiet is not the same as current)',
			}),
		},
	),
	conversations: group(
		{ description: 'Read wbot conversations' },
		{
			list: c.meta({
				description:
					'List every conversation this API key can read, most recent activity first (not paginated)',
			}),
		},
	),
	messages: group(
		{ description: 'Read and send wbot messages' },
		{
			history: c
				.meta({
					description:
						'Read newest messages (oldest first within a page) and page backward with nextCursor',
				})
				.input(schema(messagePageInput)),
			updates: c
				.meta({
					description:
						'Read message changes forward from a saved cursor; without cursor, return no items and a tail cursor to save',
				})
				.input(schema(messagePageInput)),
			get: c
				.meta({
					description:
						'Get the latest projection of one message with a freshly signed attachment URL',
				})
				.input(schema(messageGetInput)),
			send: c
				.meta({
					description:
						'Queue text or one JPEG using exactly one of text/imagePath and a caller-owned requestId; not a delivery receipt',
				})
				.input(schema(messageSendInput)),
		},
	),
	'outbound-sends': group(
		{ description: 'Inspect send outcomes' },
		{
			get: c
				.meta({
					description:
						'Get a send outcome; accepted is not delivered, and indeterminate must not be automatically resent',
				})
				.input(schema(outboundSendGetInput)),
		},
	),
	mcp: c.meta({
		description: 'Start the read-only wbot MCP server over stdio',
	}),
}

const app = cli(commands, {
	name: 'wbot',
	version: packageJson.version,
	description:
		'Read WeChat conversations and send authorized text or JPEG images through wbot',
})

const assertValidWebhookUrl = (rawUrl: string): void => {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		throw new Error('Webhook URL must be valid HTTPS')
	}
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.hash ||
		(url.port && url.port !== '443')
	) {
		throw new Error(
			'Webhook URL must use HTTPS port 443 without credentials or fragments',
		)
	}
}

const readWebhookSigningSecret = (envName: string): string => {
	const signingSecret = process.env[envName]
	if (!signingSecret || !/^[A-Za-z0-9_-]{43,128}$/.test(signingSecret)) {
		throw new Error(
			'Webhook signing secret environment variable must contain 43–128 base64url characters.',
		)
	}
	return signingSecret
}

const runWbotCli = async () => {
	const callPlatform = async <Result>(
		operation: (client: WbotClient) => Promise<Result>,
	) => operation(await createWbotPlatformClientFromEnvironment(process.env))

	await app.run({
		handlers: {
			webhooks: {
				create: async (args) => {
					const { signingSecretEnv, url, conversationIds } = args.input
					assertValidWebhookUrl(url)
					const signingSecret = readWebhookSigningSecret(signingSecretEnv)
					return JSON.stringify(
						await callPlatform((client) =>
							client.createWebhook({
								url,
								signingSecret,
								...(conversationIds === undefined ? {} : { conversationIds }),
							}),
						),
					)
				},
				list: async () =>
					JSON.stringify(await callPlatform((client) => client.listWebhooks())),
				get: async (args) =>
					JSON.stringify(
						await callPlatform((client) => client.getWebhook(args.input)),
					),
				update: async (args) => {
					const {
						webhookId,
						url,
						conversationIds,
						status,
						rotateSecret,
						signingSecretEnv,
					} = args.input
					if (url !== undefined) assertValidWebhookUrl(url)
					if (rotateSecret === false && signingSecretEnv !== undefined) {
						throw new Error(
							'rotateSecret: false cannot be combined with signingSecretEnv',
						)
					}
					const shouldRotate =
						rotateSecret === true || signingSecretEnv !== undefined
					const signingSecret = shouldRotate
						? readWebhookSigningSecret(
								signingSecretEnv ?? 'WBOT_WEBHOOK_SIGNING_SECRET',
							)
						: undefined
					if (
						url === undefined &&
						conversationIds === undefined &&
						status === undefined &&
						signingSecret === undefined
					) {
						throw new Error(
							'Specify at least one field to update (url, conversationIds, status, rotateSecret, or signingSecretEnv)',
						)
					}
					return JSON.stringify(
						await callPlatform((client) =>
							client.updateWebhook({
								webhookId,
								...(url === undefined ? {} : { url }),
								...(conversationIds === undefined ? {} : { conversationIds }),
								...(status === undefined ? {} : { status }),
								...(signingSecret === undefined ? {} : { signingSecret }),
							}),
						),
					)
				},
				retry: async (args) =>
					JSON.stringify(
						await callPlatform((client) => client.retryWebhook(args.input)),
					),
				delete: async (args) =>
					JSON.stringify(
						await callPlatform((client) => client.deleteWebhook(args.input)),
					),
			},
			auth: {
				set: async () => {
					const apiKey = await readHiddenApiKey()
					const path = await storeWbotApiKey(process.env, apiKey)
					return JSON.stringify({ configured: true, path })
				},
			},
			accounts: {
				list: async () =>
					JSON.stringify(await callPlatform((client) => client.listAccounts())),
			},
			conversations: {
				list: async () =>
					JSON.stringify(
						await callPlatform((client) => client.listConversations()),
					),
			},
			messages: {
				history: async (args) =>
					JSON.stringify(
						await callPlatform((client) => client.listMessages(args.input)),
					),
				updates: async (args) =>
					JSON.stringify(
						await callPlatform((client) => client.listChanges(args.input)),
					),
				get: async (args) =>
					JSON.stringify(
						await callPlatform((client) => client.getMessage(args.input)),
					),
				send: async (args) => {
					const { text, imagePath, ...identity } = args.input
					if ((text === undefined) === (imagePath === undefined)) {
						throw new Error('Specify exactly one of text or imagePath')
					}
					if (imagePath === undefined) {
						const input = { ...identity, text: text! }
						return JSON.stringify(
							await callPlatform((client) => client.sendText(input)),
						)
					}
					const input = {
						...identity,
						content: {
							kind: 'image' as const,
							base64: await readImageFile(imagePath),
						},
					}
					return JSON.stringify(
						await callPlatform((client) => client.sendImage(input)),
					)
				},
			},
			'outbound-sends': {
				get: async (args) =>
					JSON.stringify(
						await callPlatform((client) => client.getOutboundSend(args.input)),
					),
			},
			mcp: runWbotMcpServer,
		},
	})
}

if (import.meta.main) await runWbotCli()

async function readHiddenApiKey() {
	const input = process.stdin
	if (!input.isTTY || typeof input.setRawMode !== 'function') {
		throw new Error(
			'`wbot auth set` requires an interactive terminal. Set WBOT_API_KEY for automation.',
		)
	}
	input.setEncoding('utf8')
	input.setRawMode(true)
	input.resume()
	process.stderr.write('API key: ')
	try {
		return await new Promise<string>((resolve, reject) => {
			let secret = ''
			const onData = (chunk: string) => {
				for (const character of chunk) {
					if (character === '\u0003') {
						cleanup()
						reject(new Error('wbot credential setup cancelled.'))
						return
					}
					if (character === '\r' || character === '\n') {
						cleanup()
						if (secret.length === 0) {
							reject(new Error('wbot API key must be non-empty.'))
						} else {
							resolve(secret)
						}
						return
					}
					if (character === '\u007f' || character === '\b') {
						secret = secret.slice(0, -1)
					} else {
						secret += character
					}
				}
			}
			const cleanup = () => {
				input.off('data', onData)
			}
			input.on('data', onData)
		})
	} finally {
		input.setRawMode(false)
		input.pause()
		process.stderr.write('\n')
	}
}

async function readImageFile(path: string): Promise<string> {
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
	try {
		const info = await file.stat()
		if (!info.isFile() || info.size < 1 || info.size > MAX_SEND_IMAGE_BYTES) {
			throw new Error('Expected a regular JPEG file within 5 MiB')
		}
		const bytes = Buffer.alloc(MAX_SEND_IMAGE_BYTES + 1)
		let size = 0
		while (size < bytes.length) {
			const { bytesRead } = await file.read(
				bytes,
				size,
				bytes.length - size,
				size,
			)
			if (!bytesRead) break
			size += bytesRead
		}
		if (size > MAX_SEND_IMAGE_BYTES) throw new Error('Image exceeds 5 MiB')
		return bytes.subarray(0, size).toString('base64')
	} finally {
		await file.close()
	}
}
