import * as v from 'valibot'

import type { MessageContent } from './platform-types'

const nullableString = v.nullable(v.string())
const epochMs = v.pipe(v.number(), v.integer(), v.minValue(0))
const count = v.pipe(v.number(), v.integer(), v.minValue(0))

const identitySchema = v.looseObject({
	identityId: v.string(),
	displayName: nullableString,
	avatar: v.variant('status', [
		v.looseObject({ status: v.literal('pending') }),
		v.looseObject({ status: v.literal('ready'), url: v.string() }),
	]),
})

const knownContentKinds = [
	'text',
	'image',
	'audio',
	'video',
	'file',
	'emoji',
	'location',
	'link',
	'mini_program',
	'nudge',
	'group_invitation',
	'unknown',
] as const satisfies ReadonlyArray<MessageContent['kind']>
const knownContentKindSchema = v.picklist(knownContentKinds)

const knownContentSchema = v.variant('kind', [
	v.looseObject({ kind: v.literal('text'), text: nullableString }),
	v.looseObject({ kind: v.literal('image') }),
	v.looseObject({ kind: v.literal('audio') }),
	v.looseObject({ kind: v.literal('video') }),
	v.looseObject({
		kind: v.literal('file'),
		filename: nullableString,
		sizeBytes: v.nullable(count),
	}),
	v.looseObject({ kind: v.literal('emoji') }),
	v.looseObject({ kind: v.literal('location') }),
	v.looseObject({
		kind: v.literal('link'),
		title: nullableString,
		description: nullableString,
		url: nullableString,
		thumbnailUrl: nullableString,
	}),
	v.looseObject({
		kind: v.literal('mini_program'),
		title: nullableString,
		appId: nullableString,
		username: nullableString,
		pagePath: nullableString,
		thumbnailUrl: nullableString,
	}),
	v.looseObject({
		kind: v.literal('nudge'),
		suffix: nullableString,
		target: v.nullable(identitySchema),
	}),
	v.looseObject({
		kind: v.literal('group_invitation'),
		members: v.array(identitySchema),
	}),
	v.looseObject({ kind: v.literal('unknown'), preview: v.string() }),
])

// Only unfamiliar kinds enter this branch; malformed known variants still fail closed.
const futureContentSchema = v.pipe(
	v.looseObject({ kind: v.pipe(v.string(), v.minLength(1)) }),
	v.check((content) => !v.is(knownContentKindSchema, content.kind)),
	v.transform((content) => ({
		kind: 'unknown' as const,
		preview: 'Unsupported message type',
		originalKind: content.kind,
		originalContent: content as Record<string, unknown>,
	})),
)

const contentSchema = v.union([knownContentSchema, futureContentSchema])

const stateSchema = v.picklist(['active', 'retracted'])

// Retraction is a state, not a content kind: content is null exactly when retracted.
const contentMatchesState = (state: 'active' | 'retracted', content: unknown) =>
	(state === 'retracted') === (content === null)

const attachmentSchema = v.variant('status', [
	v.looseObject({ status: v.literal('pending') }),
	v.looseObject({
		status: v.literal('ready'),
		url: v.string(),
		mimeType: v.string(),
		sizeBytes: count,
		descriptor: v.variant('kind', [
			v.looseObject({
				kind: v.literal('image'),
				width: count,
				height: count,
			}),
			v.looseObject({ kind: v.literal('file') }),
			v.looseObject({ kind: v.literal('audio'), durationMs: count }),
		]),
	}),
])

const messageSchema = v.pipe(
	v.looseObject({
		id: v.string(),
		conversationId: v.string(),
		direction: v.picklist(['in', 'out']),
		occurredAtMs: epochMs,
		referenceId: v.optional(v.string()),
		revision: count,
		state: stateSchema,
		retractedAtMs: v.optional(epochMs),
		content: v.nullable(contentSchema),
		sender: v.nullable(identitySchema),
		replyTo: v.nullable(
			v.pipe(
				v.looseObject({
					messageId: nullableString,
					referenceId: v.optional(v.string()),
					sender: v.nullable(identitySchema),
					occurredAtMs: v.nullable(epochMs),
					state: stateSchema,
					content: v.nullable(contentSchema),
				}),
				v.check(
					(reply) => contentMatchesState(reply.state, reply.content),
					'replyTo content must match its state',
				),
			),
		),
		mentions: v.array(identitySchema),
		mentionsAll: v.boolean(),
		mentionsSelf: v.boolean(),
		attachment: v.optional(attachmentSchema),
		outboundSendId: v.optional(v.string()),
	}),
	v.check(
		(message) => contentMatchesState(message.state, message.content),
		'message content must match its state',
	),
)

const captureFreshnessSchema = v.looseObject({
	status: v.picklist(['unknown', 'current', 'delayed', 'unavailable']),
	asOfMs: v.nullable(epochMs),
})

const accountSchema = v.looseObject({
	id: v.string(),
	channel: v.string(),
	// Adapter capabilities grow with channel features; keep unknown values.
	capabilities: v.array(v.string()),
	selfIdentity: v.nullable(identitySchema),
	captureFreshness: captureFreshnessSchema,
})

const conversationSchema = v.looseObject({
	id: v.string(),
	accountId: v.string(),
	channel: v.string(),
	channelConversationId: v.string(),
	kind: v.picklist(['direct', 'room']),
	title: nullableString,
	avatar: v.variant('kind', [
		v.looseObject({ kind: v.literal('fallback') }),
		v.looseObject({ kind: v.literal('image'), url: v.string() }),
		v.looseObject({ kind: v.literal('composite'), urls: v.array(v.string()) }),
	]),
	latestMessage: v.nullable(messageSchema),
	lastActivityAtMs: v.nullable(epochMs),
	capabilities: v.array(v.picklist(['read', 'send'])),
})

export const accountListSchema = v.looseObject({
	items: v.array(accountSchema),
})

export const conversationListSchema = v.looseObject({
	items: v.array(conversationSchema),
})

export const messageResultSchema = messageSchema

export const messagePageSchema = v.looseObject({
	items: v.array(messageSchema),
	nextCursor: nullableString,
	hasMore: v.boolean(),
})

export const messageChangePageSchema = v.looseObject({
	items: v.array(
		v.looseObject({
			sequence: count,
			kind: v.picklist([
				'message.created',
				'message.retracted',
				'message.attachment_ready',
			]),
			occurredAtMs: epochMs,
			message: messageSchema,
		}),
	),
	nextCursor: v.pipe(v.string(), v.minLength(1)),
	hasMore: v.boolean(),
})

export const outboundSendSchema = v.looseObject({
	id: v.string(),
	conversationId: v.string(),
	status: v.picklist([
		'queued',
		'processing',
		'accepted',
		'failed',
		'indeterminate',
	]),
	attemptCount: count,
	error: nullableString,
	reflectedMessageId: nullableString,
	createdAtMs: epochMs,
	updatedAtMs: epochMs,
})

/** /platform/v1/messages/send result, projected onto the v2 send identity. */
export const imageSendReceiptSchema = v.pipe(
	v.looseObject({
		outboundSendId: v.string(),
		conversationId: v.string(),
		status: v.literal('queued'),
	}),
	v.transform(({ outboundSendId, conversationId, status }) => ({
		id: outboundSendId,
		conversationId,
		status,
	})),
)

const webhookDeliverySummarySchema = v.object({
	health: v.picklist(['idle', 'healthy', 'degraded', 'failing']),
	pendingCount: count,
	failedCount: count,
	lastDeliveredAtMs: v.nullable(epochMs),
	lastError: nullableString,
})

const webhookDeliveryStateSchema = v.object({
	conversationId: v.pipe(v.string(), v.minLength(1)),
	status: v.picklist(['idle', 'pending', 'sending', 'failed', 'cancelled']),
	attempts: count,
	lastError: nullableString,
	lastDeliveredAtMs: v.nullable(epochMs),
	nextAttemptAtMs: v.nullable(epochMs),
})

export const webhookEndpointSummarySchema = v.object({
	id: v.pipe(v.string(), v.minLength(1)),
	url: v.string(),
	conversationIds: v.nullable(v.array(v.pipe(v.string(), v.minLength(1)))),
	status: v.picklist(['active', 'disabled']),
	createdAtMs: epochMs,
	updatedAtMs: epochMs,
	summary: webhookDeliverySummarySchema,
})

export const webhookEndpointDetailSchema = v.object({
	id: v.pipe(v.string(), v.minLength(1)),
	url: v.string(),
	conversationIds: v.nullable(v.array(v.pipe(v.string(), v.minLength(1)))),
	status: v.picklist(['active', 'disabled']),
	createdAtMs: epochMs,
	updatedAtMs: epochMs,
	summary: webhookDeliverySummarySchema,
	deliveries: v.array(webhookDeliveryStateSchema),
})

export const webhookEndpointListSchema = v.object({
	items: v.array(webhookEndpointSummarySchema),
})

export const webhookDeleteResultSchema = v.object({ deleted: v.boolean() })
