import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

test('receiver persists multi-conversation cursors across restart and keeps a wake-up arriving during a drain', async () => {
	const root = await mkdtemp(join(tmpdir(), 'wbot-receiver-test-'))
	const portServer = createServer()
	await new Promise<void>((resolve) =>
		portServer.listen(0, '127.0.0.1', resolve),
	)
	const address = portServer.address()
	if (!address || typeof address === 'string') throw new Error('No port')
	await new Promise<void>((resolve) => portServer.close(() => resolve()))
	const secret = 's'.repeat(43)
	const log = join(root, 'queries.jsonl')
	const executable = join(root, 'fake-wbot')
	await writeFile(
		executable,
		`#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const input = JSON.parse(process.argv[3]);
appendFileSync(process.env.QUERY_LOG, JSON.stringify(input) + '\\n');
if (input.conversationId === 'room-a' && input.cursor === 'room-a:one') await Bun.sleep(400);
const cursor = input.cursor ? input.conversationId + ':two' : input.conversationId + ':one';
console.log(JSON.stringify({
	items: input.cursor === input.conversationId + ':two'
		? []
		: [{ sequence: 1, kind: 'message.created', occurredAtMs: 1, message: { id: cursor, conversationId: input.conversationId, revision: 0 } }],
	nextCursor: cursor,
	hasMore: false,
}));
`,
		{ mode: 0o700 },
	)
	const environment = {
		...process.env,
		WBOT_CONVERSATION_IDS: 'room-a',
		WBOT_WEBHOOK_SIGNING_SECRET: secret,
		WBOT_WEBHOOK_DB: join(root, 'state.sqlite'),
		WBOT_BIN: executable,
		PORT: String(address.port),
		QUERY_LOG: log,
	}
	const start = () =>
		spawn(
			'bun',
			[new URL('../../examples/webhook/receiver.ts', import.meta.url).pathname],
			{
				env: environment,
				stdio: 'ignore',
			},
		)
	let child: ChildProcess | undefined
	const queries = async () => {
		try {
			return (await readFile(log, 'utf8'))
				.trim()
				.split('\n')
				.map(
					(line) =>
						JSON.parse(line) as { conversationId: string; cursor?: string },
				)
		} catch {
			return []
		}
	}
	const until = async (check: () => Promise<boolean>) => {
		for (let n = 0; n < 100; n++) {
			if (await check()) return
			await new Promise((resolve) => setTimeout(resolve, 30))
		}
		throw new Error('Receiver condition timed out')
	}
	const stop = async () => {
		if (child) {
			const current = child
			child = undefined
			await new Promise<void>((resolve) => {
				current.once('exit', () => resolve())
				current.kill()
			})
		}
	}
	const notify = async (
		conversationId: string,
		eventId: string,
		reasons: ('message' | 'retraction' | 'attachment')[] = ['message'],
	) => {
		const body = JSON.stringify({
			version: 2,
			type: 'conversation.updated',
			eventId,
			conversationId,
			reasons,
			createdAtMs: Date.now(),
		})
		const timestamp = String(Math.floor(Date.now() / 1000))
		const response = await fetch(`http://127.0.0.1:${address.port}/webhook`, {
			method: 'POST',
			body,
			headers: {
				'Switchboard-Timestamp': timestamp,
				'Switchboard-Event-Id': eventId,
				'Switchboard-Signature': `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`,
			},
		})
		expect(response.status).toBe(202)
	}
	try {
		child = start()
		await until(async () => (await queries()).length >= 1)
		await new Promise((resolve) => setTimeout(resolve, 100))
		await notify('room-a', 'evt-a-1', ['message'])
		await until(async () =>
			(await queries()).some(
				(q) => q.conversationId === 'room-a' && q.cursor === 'room-a:one',
			),
		)
		// Second wake-up arrives while room-a is draining; room-b arrives dynamically.
		await notify('room-a', 'evt-a-2', ['retraction'])
		await notify('room-b', 'evt-b-1', ['attachment'])
		await until(async () => {
			const all = await queries()
			return (
				all.some(
					(q) => q.conversationId === 'room-a' && q.cursor === 'room-a:two',
				) && all.some((q) => q.conversationId === 'room-b')
			)
		})
		await new Promise((resolve) => setTimeout(resolve, 100))
		await stop()
		const before = (await queries()).length
		child = start()
		await until(async () => (await queries()).length >= before + 2)
		const afterRestart = (await queries()).slice(before)
		expect(afterRestart).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					conversationId: 'room-a',
					cursor: 'room-a:two',
				}),
				expect.objectContaining({
					conversationId: 'room-b',
					cursor: 'room-b:one',
				}),
			]),
		)
		expect(
			(await queries()).filter(
				(q) => q.conversationId === 'room-a' && q.cursor === undefined,
			),
		).toHaveLength(1)
	} finally {
		await stop()
		await rm(root, { recursive: true, force: true })
	}
}, 15000)
