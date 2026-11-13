import { Database } from 'bun:sqlite'

import { verifyNotification } from './verify'

const conversationId = required('WBOT_CONVERSATION_ID')
const secret = required('WBOT_WEBHOOK_SIGNING_SECRET')
const cli = process.env.WBOT_BIN ?? 'wbot'
process.umask(0o077)
const db = new Database(process.env.WBOT_WEBHOOK_DB ?? 'webhook.sqlite', {
	create: true,
})
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), conversation TEXT NOT NULL, cursor TEXT, pending INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, accepted_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS projections (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);`)
db.query('INSERT OR IGNORE INTO checkpoint VALUES (1, ?, NULL, 1)').run(
	conversationId,
)
if (
	(
		db.query('SELECT conversation FROM checkpoint WHERE id=1').get() as {
			conversation: string
		}
	).conversation !== conversationId
) {
	throw new Error('Use a separate database for each conversation.')
}
db.exec('UPDATE checkpoint SET pending=1 WHERE id=1')
let running = false
let retry: ReturnType<typeof setTimeout> | undefined

// Durable startup recovery and webhook wake-ups; no idle polling loop.
async function drain() {
	if (running) return
	running = true
	if (retry) {
		clearTimeout(retry)
		retry = undefined
	}
	try {
		while (true) {
			const row = db
				.query('SELECT cursor, pending FROM checkpoint WHERE id=1')
				.get() as {
				cursor: string | null
				pending: number
			}
			if (!row.pending) break
			// Notifications arriving during this await set pending again. Never erase that newer wake-up.
			db.exec('UPDATE checkpoint SET pending=0 WHERE id=1')
			const child = Bun.spawn(
				[
					cli,
					'messages.updates',
					JSON.stringify({
						conversationId,
						...(row.cursor ? { cursor: row.cursor } : {}),
						limit: 100,
					}),
				],
				{
					signal: AbortSignal.timeout(30_000),
					stdout: 'pipe',
					stderr: 'pipe',
					env: process.env,
				},
			)
			const [exit, output] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			])
			if (exit !== 0) throw new Error('messages.updates failed')
			const page = JSON.parse(output) as {
				items: { messageId: string; revision?: number }[]
				nextCursor: string
				hasMore: boolean
			}
			// Demonstration processing: persist IDs/revisions only. Replace this transaction with your
			// durable business processing/outbox, preserving atomic checkpoint advancement.
			db.transaction(() => {
				for (const message of page.items) {
					db.query(
						'INSERT INTO projections VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET revision=MAX(revision, excluded.revision)',
					).run(message.messageId, message.revision ?? 0)
				}
				db.query(
					'UPDATE checkpoint SET cursor=?, pending=MAX(pending, ?) WHERE id=1',
				).run(page.nextCursor, Number(page.hasMore))
			})()
		}
	} catch {
		db.exec('UPDATE checkpoint SET pending=1 WHERE id=1')
		console.error(
			'Message drain failed; cursor retained. Retrying in 30 seconds.',
		)
		retry = setTimeout(() => void drain(), 30_000)
	} finally {
		running = false
	}
}

Bun.serve({
	hostname: '127.0.0.1',
	port: Number(process.env.PORT ?? 8787),
	maxRequestBodySize: 4096,
	async fetch(request) {
		if (
			request.method !== 'POST' ||
			new URL(request.url).pathname !== '/webhook'
		)
			return new Response(null, { status: 404 })
		const event = verifyNotification(
			await request.text(),
			request.headers,
			secret,
		)
		if (!event || event.conversationId !== conversationId)
			return new Response(null, { status: 401 })
		db.transaction(() => {
			db.query('INSERT OR IGNORE INTO events VALUES (?, ?)').run(
				event.eventId,
				Date.now(),
			)
			db.exec('UPDATE checkpoint SET pending=1 WHERE id=1')
			db.query('DELETE FROM events WHERE accepted_at < ?').run(
				Date.now() - 7 * 86400_000,
			)
		})()
		void drain()
		return new Response(null, { status: 202 })
	},
})
void drain()
console.error(
	'Webhook receiver listening locally; publish /webhook behind an HTTPS reverse proxy.',
)

function required(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`Missing ${name}`)
	return value
}
