import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterEach, expect, test } from 'vitest'

import { verifyNotification } from '../../examples/webhook/verify'
import { createPlatformClient, PlatformContractError } from './platform-client'

const secret = 's'.repeat(43)
const summary = {
	id: 'wh_123',
	url: 'https://hooks.customer.com/webhook',
	status: 'active' as const,
	conversationIds: null,
	createdAtMs: 1795840786000,
	updatedAtMs: 1795840786000,
	summary: {
		health: 'idle' as const,
		pendingCount: 0,
		failedCount: 0,
		lastDeliveredAtMs: null,
		lastError: null,
	},
}
const detail = {
	...summary,
	deliveries: [
		{
			conversationId: 'room',
			status: 'idle' as const,
			attempts: 0,
			lastError: null,
			lastDeliveredAtMs: 1795840790000,
			nextAttemptAtMs: null,
		},
	],
}
const servers: Server[] = []
afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
	)
})
async function fixture(response: unknown = summary, status = 200) {
	const requests: {
		method?: string
		path?: string
		auth?: string
		body: unknown
	}[] = []
	// oxlint-disable-next-line typescript/no-misused-promises -- test server: a handler rejection surfaces as an unhandled error and fails the run
	const server = createServer(async (req, res) => {
		let raw = ''
		for await (const part of req) raw += part
		requests.push({
			method: req.method,
			path: req.url,
			auth: req.headers.authorization,
			body: raw.length > 0 ? JSON.parse(raw) : undefined,
		})
		res.writeHead(status, { 'content-type': 'application/json' })
		res.end(JSON.stringify(response))
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	if (!address || typeof address === 'string')
		throw new Error('Missing server address')
	return { url: `http://127.0.0.1:${address.port}`, requests }
}
async function cli(
	url: string,
	command: string,
	input?: unknown,
	extra: Record<string, string> = {},
) {
	return await new Promise<{
		code: number | null
		stdout: string
		stderr: string
	}>((resolve, reject) => {
		const child = spawn(
			'bun',
			[
				new URL('./wbot-cli.ts', import.meta.url).pathname,
				command,
				...(input === undefined ? [] : [JSON.stringify(input)]),
			],
			{
				env: {
					...process.env,
					WBOT_PLATFORM_URL: url,
					WBOT_API_KEY: 'fixture-key',
					WBOT_WEBHOOK_SIGNING_SECRET: secret,
					...extra,
				},
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		)
		let stdout = '',
			stderr = ''
		child.stdout.on('data', (part) => (stdout += part))
		child.stderr.on('data', (part) => (stderr += part))
		child.on('error', reject)
		child.on('close', (code) => resolve({ code, stdout, stderr }))
	})
}

test.each([
	{
		operation: 'create',
		input: { url: summary.url },
		response: summary,
		status: 201,
		expectedMethod: 'POST',
		expectedPath: '/platform/v2/webhooks',
		expectedBody: { url: summary.url, signingSecret: secret },
	},
	{
		operation: 'create',
		input: { url: summary.url, conversationIds: ['room-1', 'room-2'] },
		response: { ...summary, conversationIds: ['room-1', 'room-2'] },
		status: 201,
		expectedMethod: 'POST',
		expectedPath: '/platform/v2/webhooks',
		expectedBody: {
			url: summary.url,
			conversationIds: ['room-1', 'room-2'],
			signingSecret: secret,
		},
	},
	{
		operation: 'list',
		input: undefined,
		response: { items: [summary] },
		status: 200,
		expectedMethod: 'GET',
		expectedPath: '/platform/v2/webhooks',
		expectedBody: undefined,
	},
	{
		operation: 'get',
		input: { webhookId: 'wh_123' },
		response: detail,
		status: 200,
		expectedMethod: 'GET',
		expectedPath: '/platform/v2/webhooks/wh_123',
		expectedBody: undefined,
	},
	{
		operation: 'update',
		input: { webhookId: 'wh_123', status: 'disabled', conversationIds: null },
		response: { ...summary, status: 'disabled' },
		status: 200,
		expectedMethod: 'PATCH',
		expectedPath: '/platform/v2/webhooks/wh_123',
		expectedBody: { status: 'disabled', conversationIds: null },
	},
	{
		operation: 'retry',
		input: { webhookId: 'wh_123', conversationId: 'room' },
		response: detail,
		status: 200,
		expectedMethod: 'POST',
		expectedPath: '/platform/v2/webhooks/wh_123/retry',
		expectedBody: { conversationId: 'room' },
	},
	{
		operation: 'delete',
		input: { webhookId: 'wh_123' },
		response: { deleted: true },
		status: 200,
		expectedMethod: 'DELETE',
		expectedPath: '/platform/v2/webhooks/wh_123',
		expectedBody: undefined,
	},
])(
	'CLI webhooks.$operation uses $expectedMethod $expectedPath once',
	async (row) => {
		const f = await fixture(row.response, row.status)
		const r = await cli(f.url, `webhooks.${row.operation}`, row.input)
		expect(r.code, r.stderr).toBe(0)
		expect(JSON.parse(r.stdout)).toEqual(row.response)
		expect(r.stderr).toBe('')
		expect(f.requests).toEqual([
			{
				method: row.expectedMethod,
				path: row.expectedPath,
				auth: 'Bearer fixture-key',
				body: row.expectedBody,
			},
		])
		expect(r.stdout + r.stderr).not.toContain(secret)
	},
)

test('create supports a named secret environment variable', async () => {
	const f = await fixture(summary, 201)
	const other = 't'.repeat(43)
	const r = await cli(
		f.url,
		'webhooks.create',
		{
			url: summary.url,
			signingSecretEnv: 'CUSTOM_SIGNING_SECRET',
		},
		{ CUSTOM_SIGNING_SECRET: other },
	)
	expect(r.code, r.stderr).toBe(0)
	expect(f.requests[0]?.body).toEqual({
		url: summary.url,
		signingSecret: other,
	})
	expect(r.stdout + r.stderr).not.toContain(other)
})

test('update rotates secret only when rotateSecret or signingSecretEnv is set', async () => {
	const f = await fixture(summary, 200)
	const nextSecret = 'r'.repeat(43)
	const r = await cli(
		f.url,
		'webhooks.update',
		{
			webhookId: 'wh_123',
			rotateSecret: true,
			signingSecretEnv: 'NEXT_SIGNING_SECRET',
		},
		{ NEXT_SIGNING_SECRET: nextSecret },
	)
	expect(r.code, r.stderr).toBe(0)
	expect(f.requests[0]).toEqual({
		method: 'PATCH',
		path: '/platform/v2/webhooks/wh_123',
		auth: 'Bearer fixture-key',
		body: { signingSecret: nextSecret },
	})
	expect(r.stdout + r.stderr).not.toContain(nextSecret)
})

test.each(['', 'short', '!'.repeat(43)])(
	'invalid secret fails locally without revealing it',
	async (invalid) => {
		const f = await fixture(summary, 201)
		const r = await cli(
			f.url,
			'webhooks.create',
			{ url: summary.url },
			{ WBOT_WEBHOOK_SIGNING_SECRET: invalid },
		)
		expect(r.code).not.toBe(0)
		expect(r.stdout).toBe('')
		expect(f.requests).toHaveLength(0)
		if (invalid) expect(r.stderr).not.toContain(invalid)
	},
)

test.each([
	{ command: 'webhooks.create', input: {} },
	{ command: 'webhooks.create', input: { url: 'http://example.com' } },
	{ command: 'webhooks.create', input: { url: 'https://example.com:444' } },
	{
		command: 'webhooks.create',
		input: { url: summary.url, conversationIds: [] },
	},
	{ command: 'webhooks.update', input: { webhookId: 'wh_123' } },
	{
		command: 'webhooks.update',
		input: { webhookId: 'wh_123', url: 'http://example.com' },
	},
])(
	'invalid $command input fails locally without contacting Platform',
	async ({ command, input }) => {
		const f = await fixture()
		const r = await cli(f.url, command, input)
		expect(r.code).not.toBe(0)
		expect(f.requests).toHaveLength(0)
	},
)

test('additive response fields are tolerated but never echo signing material', async () => {
	const client = createPlatformClient({
		baseUrl: 'https://api.customer.com',
		tenantApiKey: 'key',
		fetch: async () =>
			Response.json(
				{ ...summary, futureField: true, signingSecret: secret },
				{ status: 201 },
			),
	})
	expect(
		await client.createWebhook({
			url: summary.url,
			signingSecret: secret,
		}),
	).toEqual(summary)
})

test.each([
	{ ...detail, status: 'unknown' },
	{ ...detail, summary: { ...detail.summary, health: 'broken' } },
	{
		...detail,
		deliveries: [{ ...detail.deliveries[0], attempts: -1 }],
	},
	{
		...detail,
		deliveries: [{ ...detail.deliveries[0], lastDeliveredAtMs: 'bad' }],
	},
])(
	'malformed webhook result is a sanitized contract error',
	async (response) => {
		const client = createPlatformClient({
			baseUrl: 'https://api.customer.com',
			tenantApiKey: 'key',
			fetch: async () => Response.json({ ...response, signingSecret: secret }),
		})
		await expect(
			client.retryWebhook({ webhookId: 'wh_123' }),
		).rejects.toBeInstanceOf(PlatformContractError)
		await expect(
			client.retryWebhook({ webhookId: 'wh_123' }),
		).rejects.not.toThrow(secret)
	},
)

test('business error remains a nonzero CLI error with empty stdout', async () => {
	const f = await fixture(
		{ error: { code: 'forbidden', message: 'Read grant required' } },
		403,
	)
	const r = await cli(f.url, 'webhooks.retry', { webhookId: 'wh_123' })
	expect(r.code).not.toBe(0)
	expect(r.stdout).toBe('')
	expect(r.stderr).toContain('Read grant required')
})

test('receiver verifies exact signed v2 bytes and rejects tampering, stale events, v1 payloads, bad reasons and header mismatch', () => {
	const now = 1793600000000
	const stamp = String(now / 1000)
	const sign = (payload: unknown, eventId = 'event') => {
		const body = JSON.stringify(payload)
		const headers = new Headers({
			'Switchboard-Timestamp': stamp,
			'Switchboard-Event-Id': eventId,
			'Switchboard-Signature': `v1=${createHmac('sha256', secret).update(`${stamp}.${body}`).digest('hex')}`,
		})
		return { body, headers }
	}
	const valid = sign({
		version: 2,
		type: 'conversation.updated',
		eventId: 'event',
		conversationId: 'room',
		reasons: ['message', 'retraction', 'attachment'],
		createdAtMs: now,
	})
	expect(verifyNotification(valid.body, valid.headers, secret, now)).toEqual({
		version: 2,
		type: 'conversation.updated',
		eventId: 'event',
		conversationId: 'room',
		reasons: ['message', 'retraction', 'attachment'],
		createdAtMs: now,
	})
	expect(
		verifyNotification(valid.body + ' ', valid.headers, secret, now),
	).toBeNull()
	expect(verifyNotification(valid.body, valid.headers, 'wrong', now)).toBeNull()
	expect(
		verifyNotification(valid.body, valid.headers, secret, now + 301000),
	).toBeNull()
	valid.headers.set('Switchboard-Event-Id', 'other')
	expect(verifyNotification(valid.body, valid.headers, secret, now)).toBeNull()

	// Reject v1 payload shape
	const v1 = sign({
		version: 1,
		type: 'messages.available',
		eventId: 'event',
		conversationId: 'room',
		createdAtMs: now,
	})
	expect(verifyNotification(v1.body, v1.headers, secret, now)).toBeNull()

	// Reject empty, unknown, or duplicate reasons
	for (const badReasons of [[], ['unknown'], ['message', 'message']]) {
		const bad = sign({
			version: 2,
			type: 'conversation.updated',
			eventId: 'event',
			conversationId: 'room',
			reasons: badReasons,
			createdAtMs: now,
		})
		expect(verifyNotification(bad.body, bad.headers, secret, now)).toBeNull()
	}
})
