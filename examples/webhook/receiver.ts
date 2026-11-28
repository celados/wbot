import { Database } from 'bun:sqlite'

import { verifyNotification } from './verify'

const secret = required('WBOT_WEBHOOK_SIGNING_SECRET')
const cli = process.env.WBOT_BIN ?? 'wbot'
const seedConversationIds = (process.env.WBOT_CONVERSATION_IDS ?? '')
	.split(',')
	.map((value) => value.trim())
	.filter((value) => value.length > 0)

process.umask(0o077)
const db = new Database(process.env.WBOT_WEBHOOK_DB ?? 'webhook.sqlite', {
	create: true,
})
db.run(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS checkpoints (
    conversation_id TEXT PRIMARY KEY,
    cursor TEXT,
    pending INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, accepted_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS projections (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    revision INTEGER NOT NULL
  );`)

for (const conversationId of seedConversationIds) {
	db.query(
		'INSERT OR IGNORE INTO checkpoints (conversation_id, cursor, pending) VALUES (?, NULL, 1)',
	).run(conversationId)
}
db.run('UPDATE checkpoints SET pending = 1')

const running = new Set<string>()
const retries = new Map<string, ReturnType<typeof setTimeout>>()

// Durable per-conversation startup recovery and webhook wake-ups; no idle polling loop.
async function drain(conversationId: string) {
	if (running.has(conversationId)) return
	running.add(conversationId)
	const existingRetry = retries.get(conversationId)
	if (existingRetry) {
		clearTimeout(existingRetry)
		retries.delete(conversationId)
	}
	try {
		while (true) {
			const row = db
				.query(
					'SELECT cursor, pending FROM checkpoints WHERE conversation_id = ?',
				)
				.get(conversationId) as {
				cursor: string | null
				pending: number
			} | null
			if (!row?.pending) break
			// Notifications arriving during this await set pending again. Never erase that newer wake-up.
			db.query(
				'UPDATE checkpoints SET pending = 0 WHERE conversation_id = ?',
			).run(conversationId)
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
				items: {
					kind: string
					message: { id: string; conversationId?: string; revision: number }
				}[]
				nextCursor: string
				hasMore: boolean
			}
			// Demonstration processing: persist IDs/revisions only. Replace this transaction with your
			// durable business processing/outbox, preserving atomic checkpoint advancement.
			db.transaction(() => {
				for (const item of page.items) {
					db.query(
						`INSERT INTO projections (id, conversation_id, revision)
             VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET revision = MAX(revision, excluded.revision)`,
					).run(
						item.message.id,
						item.message.conversationId ?? conversationId,
						item.message.revision,
					)
				}
				db.query(
					'UPDATE checkpoints SET cursor = ?, pending = MAX(pending, ?) WHERE conversation_id = ?',
				).run(page.nextCursor, Number(page.hasMore), conversationId)
			})()
		}
	} catch {
		db.query(
			'UPDATE checkpoints SET pending = 1 WHERE conversation_id = ?',
		).run(conversationId)
		console.error(
			`Message drain failed for ${conversationId}; cursor retained. Retrying in 30 seconds.`,
		)
		retries.set(
			conversationId,
			setTimeout(() => void drain(conversationId), 30_000),
		)
	} finally {
		running.delete(conversationId)
	}
}

function drainAllPending() {
	const rows = db
		.query('SELECT conversation_id FROM checkpoints WHERE pending = 1')
		.all() as { conversation_id: string }[]
	for (const row of rows) {
		void drain(row.conversation_id)
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
		if (!event) return new Response(null, { status: 401 })
		db.transaction(() => {
			db.query('INSERT OR IGNORE INTO events VALUES (?, ?)').run(
				event.eventId,
				Date.now(),
			)
			db.query(
				`INSERT INTO checkpoints (conversation_id, cursor, pending)
         VALUES (?, NULL, 1)
         ON CONFLICT(conversation_id) DO UPDATE SET pending = 1`,
			).run(event.conversationId)
			db.query('DELETE FROM events WHERE accepted_at < ?').run(
				Date.now() - 7 * 86400_000,
			)
		})()
		void drain(event.conversationId)
		return new Response(null, { status: 202 })
	},
})

drainAllPending()
console.error(
	'Multi-conversation webhook receiver listening locally; publish /webhook behind an HTTPS reverse proxy.',
)

function required(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`Missing ${name}`)
	return value
}
