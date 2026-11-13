import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterEach, expect, test } from 'vitest'

import { verifyNotification } from '../../examples/webhook/verify'
import { createPlatformClient, PlatformContractError } from './platform-client'

const secret = 's'.repeat(43)
const result = {
	conversationId: 'room',
	url: 'https://hooks.customer.com/webhook',
	deliveryStatus: 'idle',
	attempts: 0,
	lastError: null,
	lastDeliveredAtMs: null,
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
async function fixture(response: unknown = result, status = 200) {
	const requests: { path?: string; auth?: string; body: unknown }[] = []
	// oxlint-disable-next-line typescript/no-misused-promises -- test server: a handler rejection surfaces as an unhandled error and fails the run
	const server = createServer(async (req, res) => {
		let body = ''
		for await (const part of req) body += part
		requests.push({
			path: req.url,
			auth: req.headers.authorization,
			body: JSON.parse(body),
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
test.each(['configure', 'list', 'retry', 'remove'])(
	'CLI %s uses the authenticated public endpoint once',
	async (operation) => {
		const response =
			operation === 'list'
				? { items: [result] }
				: operation === 'remove'
					? { removed: true }
					: result
		const f = await fixture(response)
		const input =
			operation === 'list'
				? undefined
				: operation === 'configure'
					? { conversationId: 'room', url: result.url }
					: { conversationId: 'room' }
		const r = await cli(f.url, `webhooks.${operation}`, input)
		expect(r.code, r.stderr).toBe(0)
		expect(JSON.parse(r.stdout)).toEqual(response)
		expect(r.stderr).toBe('')
		expect(f.requests).toEqual([
			{
				path: `/platform/v1/webhooks/${operation}`,
				auth: 'Bearer fixture-key',
				body:
					operation === 'configure'
						? { ...input, signingSecret: secret }
						: (input ?? {}),
			},
		])
		expect(r.stdout + r.stderr).not.toContain(secret)
	},
)
test('configure supports a named secret environment variable', async () => {
	const f = await fixture()
	const other = 't'.repeat(43)
	const r = await cli(
		f.url,
		'webhooks.configure',
		{
			conversationId: 'room',
			url: result.url,
			signingSecretEnv: 'CUSTOM_SIGNING_SECRET',
		},
		{ CUSTOM_SIGNING_SECRET: other },
	)
	expect(r.code, r.stderr).toBe(0)
	expect(f.requests[0]?.body).toEqual({
		conversationId: 'room',
		url: result.url,
		signingSecret: other,
	})
	expect(r.stdout + r.stderr).not.toContain(other)
})
test.each(['', 'short', '!'.repeat(43)])(
	'invalid secret fails locally without revealing it',
	async (invalid) => {
		const f = await fixture()
		const r = await cli(
			f.url,
			'webhooks.configure',
			{ conversationId: 'room', url: result.url },
			{ WBOT_WEBHOOK_SIGNING_SECRET: invalid },
		)
		expect(r.code).not.toBe(0)
		expect(r.stdout).toBe('')
		expect(f.requests).toHaveLength(0)
		if (invalid) expect(r.stderr).not.toContain(invalid)
	},
)
test.each([
	{ url: result.url },
	{ conversationId: 'room', url: 'http://example.com' },
	{ conversationId: 'room', url: 'https://example.com:444' },
])('invalid configure input fails locally', async (input) => {
	const f = await fixture()
	const r = await cli(f.url, 'webhooks.configure', input)
	expect(r.code).not.toBe(0)
	expect(f.requests).toHaveLength(0)
})
test('additive response fields are tolerated but never echo signing material', async () => {
	const client = createPlatformClient({
		baseUrl: 'https://api.customer.com',
		tenantApiKey: 'key',
		fetch: async () =>
			Response.json({ ...result, futureField: true, signingSecret: secret }),
	})
	expect(
		await client.configureWebhook({
			conversationId: 'room',
			url: result.url,
			signingSecret: secret,
		}),
	).toEqual(result)
})
test.each([
	{ ...result, deliveryStatus: 'unknown' },
	{ ...result, attempts: -1 },
	{ ...result, lastDeliveredAtMs: 'bad' },
])(
	'malformed webhook result is a sanitized contract error',
	async (response) => {
		const client = createPlatformClient({
			baseUrl: 'https://api.customer.com',
			tenantApiKey: 'key',
			fetch: async () => Response.json({ ...response, signingSecret: secret }),
		})
		await expect(
			client.retryWebhook({ conversationId: 'room' }),
		).rejects.toBeInstanceOf(PlatformContractError)
		await expect(
			client.retryWebhook({ conversationId: 'room' }),
		).rejects.not.toThrow(secret)
	},
)
test('business error remains a nonzero CLI error with empty stdout', async () => {
	const f = await fixture(
		{ error: { code: 'forbidden', message: 'Read grant required' } },
		403,
	)
	const r = await cli(f.url, 'webhooks.retry', { conversationId: 'room' })
	expect(r.code).not.toBe(0)
	expect(r.stdout).toBe('')
	expect(r.stderr).toContain('Read grant required')
})
test('receiver verifies exact signed bytes and rejects tampering, stale events and header mismatch', () => {
	const now = 1793600000000,
		stamp = String(now / 1000)
	const body = JSON.stringify({
		version: 1,
		type: 'messages.available',
		eventId: 'event',
		conversationId: 'room',
		createdAtMs: now,
	})
	const headers = new Headers({
		'Switchboard-Timestamp': stamp,
		'Switchboard-Event-Id': 'event',
		'Switchboard-Signature': `v1=${createHmac('sha256', secret).update(`${stamp}.${body}`).digest('hex')}`,
	})
	expect(verifyNotification(body, headers, secret, now)?.eventId).toBe('event')
	expect(verifyNotification(body + ' ', headers, secret, now)).toBeNull()
	expect(verifyNotification(body, headers, 'wrong', now)).toBeNull()
	expect(verifyNotification(body, headers, secret, now + 301000)).toBeNull()
	headers.set('Switchboard-Event-Id', 'other')
	expect(verifyNotification(body, headers, secret, now)).toBeNull()
})
