// Public result types for the Platform API v2 contract (docs/platform-v2.md).
// Only JPEG image sends still use /platform/v1; see `platformV1Routes`.

export type Identity = {
	identityId: string
	displayName: string | null
	avatar: { status: 'pending' } | { status: 'ready'; url: string }
}

export type MessageContent =
	| { kind: 'text'; text: string | null }
	| { kind: 'image' }
	| { kind: 'audio' }
	| { kind: 'video' }
	| { kind: 'file'; filename: string | null; sizeBytes: number | null }
	| { kind: 'emoji' }
	| { kind: 'location' }
	| {
			kind: 'link'
			title: string | null
			description: string | null
			url: string | null
			thumbnailUrl: string | null
	  }
	| {
			kind: 'mini_program'
			title: string | null
			appId: string | null
			username: string | null
			pagePath: string | null
			thumbnailUrl: string | null
	  }
	| { kind: 'nudge'; suffix: string | null; target: Identity | null }
	| { kind: 'group_invitation'; members: Array<Identity> }
	| {
			kind: 'unknown'
			preview: string
			/** Set when the Platform returned a kind this client does not know. */
			originalKind?: string
			originalContent?: Record<string, unknown>
	  }

export type MessageAttachment =
	| { status: 'pending' }
	| {
			status: 'ready'
			/** Signed and short-lived; refresh with `messages.get`. */
			url: string
			mimeType: string
			sizeBytes: number
			descriptor:
				| { kind: 'image'; width: number; height: number }
				| { kind: 'file' }
				| { kind: 'audio'; durationMs: number }
	  }

export type MessageState = 'active' | 'retracted'

export type Message = {
	id: string
	conversationId: string
	direction: 'in' | 'out'
	occurredAtMs: number
	referenceId?: string
	revision: number
	state: MessageState
	retractedAtMs?: number
	/** `null` exactly when `state` is `retracted`. */
	content: MessageContent | null
	sender: Identity | null
	replyTo: {
		messageId: string | null
		referenceId?: string
		sender: Identity | null
		occurredAtMs: number | null
		state: MessageState
		content: MessageContent | null
	} | null
	mentions: Array<Identity>
	mentionsAll: boolean
	mentionsSelf: boolean
	attachment?: MessageAttachment
	/** Present only on outgoing messages sent by the caller's own Tenant. */
	outboundSendId?: string
}

export type CaptureFreshness = {
	status: 'unknown' | 'current' | 'delayed' | 'unavailable'
	asOfMs: number | null
}

/** Known adapter capabilities; the Platform may add more, so unknown strings are kept. */
export type AccountCapability =
	| 'observe_messages'
	| 'send_text'
	| 'send_image'
	| 'send_mentions'
	| (string & {})

export type Account = {
	id: string
	channel: string
	capabilities: Array<AccountCapability>
	selfIdentity: Identity | null
	captureFreshness: CaptureFreshness
}

export type ConversationAvatar =
	| { kind: 'fallback' }
	| { kind: 'image'; url: string }
	| { kind: 'composite'; urls: Array<string> }

export type ConversationCapability = 'read' | 'send'

export type Conversation = {
	id: string
	accountId: string
	channel: string
	channelConversationId: string
	kind: 'direct' | 'room'
	title: string | null
	avatar: ConversationAvatar
	latestMessage: Message | null
	lastActivityAtMs: number | null
	capabilities: Array<ConversationCapability>
}

export type ItemList<T> = { items: Array<T> }

export type MessagePage = {
	items: Array<Message>
	/** `null` when the page is empty; stop paging when `hasMore` is false. */
	nextCursor: string | null
	hasMore: boolean
}

export type MessageChangeKind =
	| 'message.created'
	| 'message.retracted'
	| 'message.attachment_ready'

export type MessageChange = {
	sequence: number
	kind: MessageChangeKind
	occurredAtMs: number
	/** Current projection, not a snapshot taken at change time. */
	message: Message
}

export type MessageChangePage = {
	items: Array<MessageChange>
	nextCursor: string
	hasMore: boolean
}

export type MessagesHistoryInput = {
	conversationId: string
	/** A history `nextCursor`; pages toward older messages. */
	cursor?: string
	limit?: number
}

export type MessagesUpdatesInput = {
	conversationId: string
	/** An updates `nextCursor`; omit to bootstrap a cursor at the current tail. */
	cursor?: string
	limit?: number
}

export type MessageGetInput = {
	conversationId: string
	messageId: string
}

export type MessageSendInput = {
	conversationId: string
	/** Sent as the v2 `Idempotency-Key`; one namespace with the v1 requestId. */
	requestId: string
	text: string
	requestedBy: string
}

export type ImageMessageSendInput = {
	conversationId: string
	requestId: string
	requestedBy: string
	content: { kind: 'image'; base64: string }
	text?: never
}

export type OutboundSendStatus =
	| 'queued'
	| 'processing'
	| 'accepted'
	| 'failed'
	| 'indeterminate'

export type OutboundSend = {
	id: string
	conversationId: string
	status: OutboundSendStatus
	attemptCount: number
	error: string | null
	reflectedMessageId: string | null
	createdAtMs: number
	updatedAtMs: number
}

/** A JPEG send is still submitted through /platform/v1 and only reports its queued identity. */
export type ImageSendReceipt = Pick<OutboundSend, 'id' | 'conversationId'> & {
	status: 'queued'
}

export type OutboundSendGetInput = {
	outboundSendId: string
}

export type PlatformErrorCode =
	| 'unauthorized'
	| 'invalid_request'
	| 'forbidden'
	| 'not_found'
	| 'conflict'
	| 'invalid_cursor'
	| 'unsupported_cursor_version'
	| 'rate_limited'
	| 'internal_error'

export type WebhookEndpointStatus = 'active' | 'disabled'

export type WebhookHealthStatus = 'idle' | 'healthy' | 'degraded' | 'failing'

export type WebhookDeliveryStatus =
	| 'idle'
	| 'pending'
	| 'sending'
	| 'failed'
	| 'cancelled'

export type WebhookDeliverySummary = {
	health: WebhookHealthStatus
	pendingCount: number
	failedCount: number
	lastDeliveredAtMs: number | null
	lastError: string | null
}

export type WebhookEndpointSummary = {
	id: string
	url: string
	conversationIds: Array<string> | null
	status: WebhookEndpointStatus
	createdAtMs: number
	updatedAtMs: number
	summary: WebhookDeliverySummary
}

export type WebhookDeliveryState = {
	conversationId: string
	status: WebhookDeliveryStatus
	attempts: number
	lastError: string | null
	lastDeliveredAtMs: number | null
	nextAttemptAtMs: number | null
}

export type WebhookEndpointDetail = WebhookEndpointSummary & {
	deliveries: Array<WebhookDeliveryState>
}

export type WebhookCreateInput = {
	url: string
	signingSecret: string
	conversationIds?: Array<string> | null
}

export type WebhookGetInput = {
	webhookId: string
}

export type WebhookUpdateInput = {
	webhookId: string
	url?: string
	signingSecret?: string
	conversationIds?: Array<string> | null
	status?: WebhookEndpointStatus
}

export type WebhookRetryInput = {
	webhookId: string
	conversationId?: string
}

export type WebhookDeleteInput = {
	webhookId: string
}
