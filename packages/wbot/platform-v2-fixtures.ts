// Wire-shaped /platform/v2 fixtures shared by tests. Not part of the release bundle.

export const createIdentityFixture = (identityId = 'identity-1') => ({
	identityId,
	displayName: 'Sender',
	avatar: { status: 'pending' },
})

export const createMessageFixture = (
	overrides: Record<string, unknown> = {},
) => ({
	id: 'message-1',
	conversationId: 'conversation-1',
	direction: 'in',
	occurredAtMs: 1_786_000_000_000,
	revision: 1,
	state: 'active',
	content: {
		kind: 'nudge',
		suffix: 'hello',
		target: createIdentityFixture('identity-2'),
	},
	sender: createIdentityFixture(),
	replyTo: null,
	mentions: [],
	mentionsAll: false,
	mentionsSelf: false,
	attachment: {
		status: 'ready',
		url: 'https://media.example/audio.m4a',
		mimeType: 'audio/mp4',
		sizeBytes: 512,
		descriptor: { kind: 'audio', durationMs: 1250 },
	},
	...overrides,
})

export const createConversationFixture = (
	overrides: Record<string, unknown> = {},
) => ({
	id: 'conversation-1',
	accountId: 'account-1',
	channel: 'wechat',
	channelConversationId: 'opaque-conversation-1',
	kind: 'room',
	title: 'Founders Circle',
	avatar: { kind: 'fallback' },
	latestMessage: null,
	lastActivityAtMs: 1_786_000_000_000,
	capabilities: ['read', 'send'],
	...overrides,
})

export const createAccountFixture = (
	overrides: Record<string, unknown> = {},
) => ({
	id: 'account-1',
	channel: 'wechat',
	capabilities: ['observe_messages', 'send_text'],
	selfIdentity: createIdentityFixture('identity-self'),
	captureFreshness: { status: 'current', asOfMs: 1_786_000_000_000 },
	...overrides,
})

export const createOutboundSendFixture = (
	overrides: Record<string, unknown> = {},
) => ({
	id: 'send-1',
	conversationId: 'conversation-1',
	status: 'queued',
	attemptCount: 0,
	error: null,
	reflectedMessageId: null,
	createdAtMs: 1_786_000_000_000,
	updatedAtMs: 1_786_000_000_000,
	...overrides,
})
