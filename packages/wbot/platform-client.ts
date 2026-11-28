import type * as v from 'valibot'

import { safeParse } from 'valibot'

import type {
	Account,
	Conversation,
	ImageMessageSendInput,
	ImageSendReceipt,
	ItemList,
	Message,
	MessageChangePage,
	MessageGetInput,
	MessagePage,
	MessageSendInput,
	MessagesHistoryInput,
	MessagesUpdatesInput,
	OutboundSend,
	OutboundSendGetInput,
	PlatformErrorCode,
	WebhookConfigureInput,
	WebhookIdentityInput,
	WebhookResult,
} from './platform-types'

import {
	accountListSchema,
	conversationListSchema,
	imageSendReceiptSchema,
	messageChangePageSchema,
	messagePageSchema,
	messageResultSchema,
	outboundSendSchema,
	webhookListResultSchema,
	webhookRemoveResultSchema,
	webhookResultSchema,
} from './platform-schemas'

const v2 = '/platform/v2'

/**
 * The only operations still served by the frozen `/platform/v1` major, because
 * `/platform/v2` does not cover them yet: JPEG image send and webhook management.
 * Everything else uses `/platform/v2`; there is no v1 fallback.
 */
const platformV1Routes = {
	imageSend: '/platform/v1/messages/send',
	webhooksConfigure: '/platform/v1/webhooks/configure',
	webhooksList: '/platform/v1/webhooks/list',
	webhooksRemove: '/platform/v1/webhooks/remove',
	webhooksRetry: '/platform/v1/webhooks/retry',
} as const

export type PlatformClient = {
	listAccounts: () => Promise<ItemList<Account>>
	listConversations: () => Promise<ItemList<Conversation>>
	listMessages: (input: MessagesHistoryInput) => Promise<MessagePage>
	listChanges: (input: MessagesUpdatesInput) => Promise<MessageChangePage>
	getMessage: (input: MessageGetInput) => Promise<Message>
	sendText: (input: MessageSendInput) => Promise<OutboundSend>
	sendImage: (input: ImageMessageSendInput) => Promise<ImageSendReceipt>
	getOutboundSend: (input: OutboundSendGetInput) => Promise<OutboundSend>
}

export type WebhookClient = {
	configureWebhook: (input: WebhookConfigureInput) => Promise<WebhookResult>
	listWebhooks: () => Promise<{ items: WebhookResult[] }>
	removeWebhook: (input: WebhookIdentityInput) => Promise<{ removed: boolean }>
	retryWebhook: (input: WebhookIdentityInput) => Promise<WebhookResult>
}
export type WbotClient = PlatformClient & WebhookClient

type PlatformClientConfig = {
	baseUrl: string
	tenantApiKey: string
	fetch?: (
		input: string | URL | Request,
		init?: RequestInit,
	) => Promise<Response>
	onDeprecationWarning?: (warning: string) => void
	/** Injectable delay used before the single 429 retry; defaults to setTimeout. */
	sleep?: (ms: number) => Promise<void>
}

/** Upper bound on one honoured Retry-After wait so a bad header cannot hang a caller. */
export const maxRateLimitRetryWaitMs = 60_000

export class PlatformRequestError extends Error {
	readonly status: number
	readonly code: PlatformErrorCode
	/** Present on `rate_limited`: how long the Platform asked the caller to wait. */
	readonly retryAfterMs: number | null

	constructor(
		message: string,
		status: number,
		code: PlatformErrorCode,
		retryAfterMs: number | null = null,
	) {
		super(message)
		this.name = 'PlatformRequestError'
		this.status = status
		this.code = code
		this.retryAfterMs = retryAfterMs
	}
}

export class PlatformContractError extends Error {
	readonly code = 'invalid_platform_response' as const
	readonly endpoint: string
	readonly issuePaths: readonly string[]

	constructor(endpoint: string, issuePaths: readonly string[]) {
		const location = issuePaths.length > 0 ? issuePaths.join(', ') : '<root>'
		super(
			`Platform returned an invalid response for ${endpoint} at ${location}.`,
		)
		this.name = 'PlatformContractError'
		this.endpoint = endpoint
		this.issuePaths = issuePaths
	}
}

export const createPlatformClient = (
	config: PlatformClientConfig,
): WbotClient => {
	const baseUrl = normalizeBaseUrl(config.baseUrl)
	if (config.tenantApiKey.length === 0) {
		throw new Error('SWITCHBOARD_TENANT_API_KEY must be non-empty')
	}
	const platformFetch = config.fetch ?? fetch
	const sleep =
		config.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	let reportedDeprecation = false
	type PlatformRequest = {
		method: 'GET' | 'POST'
		path: string
		/** Path template used in diagnostics when `path` embeds resource IDs. */
		route?: string
		query?: Record<string, string | number | undefined>
		headers?: Record<string, string>
		body?: object | FormData
	}
	const send = (request: PlatformRequest) => {
		const url = new URL(request.path, baseUrl)
		for (const [name, value] of Object.entries(request.query ?? {})) {
			if (value !== undefined) url.searchParams.set(name, String(value))
		}
		const { body } = request
		return platformFetch(url, {
			method: request.method,
			headers: {
				Authorization: `Bearer ${config.tenantApiKey}`,
				...(body === undefined || body instanceof FormData
					? {}
					: { 'Content-Type': 'application/json' }),
				...request.headers,
			},
			body:
				body === undefined || body instanceof FormData
					? body
					: JSON.stringify(body),
		})
	}
	const request = async <Result>(
		platformRequest: PlatformRequest,
		schema: v.GenericSchema<unknown, Result>,
	): Promise<Result> => {
		// Diagnostics name the route template, never IDs, query values or payloads.
		const endpoint = `${platformRequest.method} ${platformRequest.route ?? platformRequest.path}`
		let response = await send(platformRequest)
		if (response.status === 429) {
			// A 429 is rejected before any work, so one retry of the same request is safe,
			// including sends that carry the same caller-owned requestId.
			const payload = await response.json().catch(() => null)
			await sleep(rateLimitWaitMs(response, payload))
			response = await send(platformRequest)
		}
		if (response.ok && !reportedDeprecation) {
			const warning = readDeprecationWarning(response.headers)
			if (warning) {
				reportedDeprecation = true
				config.onDeprecationWarning?.(warning)
			}
		}
		const payload = await readResponseBody(response, endpoint)
		if (!response.ok) {
			const error = readError(payload)
			if (response.status === 429) {
				const retryAfterMs = rateLimitWaitMs(
					response,
					payload,
					Number.POSITIVE_INFINITY,
				)
				throw new PlatformRequestError(
					`${error?.message ?? 'Platform rate limit exceeded'} (rate_limited; retry after ${Math.ceil(retryAfterMs / 1000)}s)`,
					429,
					'rate_limited',
					retryAfterMs,
				)
			}
			throw new PlatformRequestError(
				error?.message ?? `Platform request failed (${response.status})`,
				response.status,
				error?.code ?? 'internal_error',
			)
		}
		const result = safeParse(schema, payload)
		if (!result.success) {
			const issuePaths = result.issues.flatMap((issue) => {
				const path = issue.path?.map((item) => String(item.key)).join('.')
				return path ? [path] : []
			})
			throw new PlatformContractError(endpoint, issuePaths)
		}
		return result.output
	}
	const conversationPath = (conversationId: string, rest: string) =>
		`${v2}/conversations/${encodeURIComponent(conversationId)}/${rest}`

	return {
		listAccounts: () =>
			request({ method: 'GET', path: `${v2}/accounts` }, accountListSchema),
		listConversations: () =>
			request(
				{ method: 'GET', path: `${v2}/conversations` },
				conversationListSchema,
			),
		listMessages: (input) =>
			request(
				{
					method: 'GET',
					path: conversationPath(input.conversationId, 'messages'),
					route: `${v2}/conversations/{id}/messages`,
					query: { before: input.cursor, limit: input.limit },
				},
				messagePageSchema,
			),
		listChanges: (input) =>
			request(
				{
					method: 'GET',
					path: conversationPath(input.conversationId, 'changes'),
					route: `${v2}/conversations/{id}/changes`,
					query: { cursor: input.cursor, limit: input.limit },
				},
				messageChangePageSchema,
			),
		getMessage: (input) =>
			request(
				{
					method: 'GET',
					path: conversationPath(
						input.conversationId,
						`messages/${encodeURIComponent(input.messageId)}`,
					),
					route: `${v2}/conversations/{id}/messages/{messageId}`,
				},
				messageResultSchema,
			),
		sendText: (input) =>
			request(
				{
					method: 'POST',
					path: conversationPath(input.conversationId, 'messages'),
					route: `${v2}/conversations/{id}/messages`,
					headers: { 'Idempotency-Key': input.requestId },
					body: {
						content: { kind: 'text', text: input.text },
						requestedBy: input.requestedBy,
					},
				},
				outboundSendSchema,
			),
		sendImage: (input) =>
			request(
				{
					method: 'POST',
					path: platformV1Routes.imageSend,
					body: encodeImageSend(input),
				},
				imageSendReceiptSchema,
			),
		getOutboundSend: (input) =>
			request(
				{
					method: 'GET',
					path: `${v2}/outbound-sends/${encodeURIComponent(input.outboundSendId)}`,
					route: `${v2}/outbound-sends/{id}`,
				},
				outboundSendSchema,
			),
		configureWebhook: (input) =>
			request(
				{
					method: 'POST',
					path: platformV1Routes.webhooksConfigure,
					body: input,
				},
				webhookResultSchema,
			),
		listWebhooks: () =>
			request(
				{ method: 'POST', path: platformV1Routes.webhooksList, body: {} },
				webhookListResultSchema,
			),
		removeWebhook: (input) =>
			request(
				{ method: 'POST', path: platformV1Routes.webhooksRemove, body: input },
				webhookRemoveResultSchema,
			),
		retryWebhook: (input) =>
			request(
				{ method: 'POST', path: platformV1Routes.webhooksRetry, body: input },
				webhookResultSchema,
			),
	}
}

const readDeprecationWarning = (headers: Headers): string | null => {
	const deprecation = headers.get('Deprecation')
	const sunset = headers.get('Sunset')
	const link = headers.get('Link')
	if (!deprecation && !sunset) return null
	return [
		'Platform API deprecation',
		deprecation ? `deprecated=${deprecation}` : null,
		sunset ? `sunset=${sunset}` : null,
		link ? `migration=${link}` : null,
	]
		.filter((part) => part !== null)
		.join('; ')
}

const normalizeBaseUrl = (value: string) => {
	const url = new URL(value)
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('SWITCHBOARD_PLATFORM_URL must use http or https')
	}
	url.pathname = '/'
	url.search = ''
	url.hash = ''
	return url
}

const readResponseBody = async (
	response: Response,
	endpoint: string,
): Promise<unknown> => {
	try {
		return await response.json()
	} catch {
		if (response.ok) throw new PlatformContractError(endpoint, ['<json>'])
		throw new PlatformRequestError(
			`Platform returned invalid JSON (${response.status})`,
			response.status,
			'internal_error',
		)
	}
}

const rateLimitWaitMs = (
	response: Response,
	payload: unknown,
	maxWaitMs: number = maxRateLimitRetryWaitMs,
) => {
	const header = Number(response.headers.get('Retry-After') ?? Number.NaN)
	const fromHeader =
		Number.isFinite(header) && header > 0 ? header * 1000 : null
	const fromBody = readRetryAfterMs(payload)
	return Math.min(fromHeader ?? fromBody ?? 1000, maxWaitMs)
}

const readRetryAfterMs = (payload: unknown): number | null => {
	if (typeof payload !== 'object' || payload === null || !('error' in payload))
		return null
	const error = payload.error
	if (typeof error !== 'object' || error === null || !('retryAfterMs' in error))
		return null
	const value = error.retryAfterMs
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? value
		: null
}

const readError = (
	payload: unknown,
): { code: PlatformErrorCode; message: string } | null => {
	if (
		typeof payload !== 'object' ||
		payload === null ||
		!('error' in payload)
	) {
		return null
	}
	if (typeof payload.error === 'string') {
		return { code: 'internal_error', message: payload.error }
	}
	if (
		typeof payload.error === 'object' &&
		payload.error !== null &&
		'code' in payload.error &&
		isPlatformErrorCode(payload.error.code) &&
		'message' in payload.error &&
		typeof payload.error.message === 'string'
	) {
		return { code: payload.error.code, message: payload.error.message }
	}
	return null
}

const isPlatformErrorCode = (value: unknown): value is PlatformErrorCode =>
	typeof value === 'string' &&
	[
		'unauthorized',
		'invalid_request',
		'forbidden',
		'not_found',
		'conflict',
		'invalid_cursor',
		'unsupported_cursor_version',
		'rate_limited',
		'internal_error',
	].includes(value)

export const MAX_SEND_IMAGE_BYTES = 5 * 1024 * 1024

const encodeImageSend = (input: ImageMessageSendInput): FormData => {
	if (input.text !== undefined || input.content?.kind !== 'image') {
		throw new Error('Specify exactly one text or image content')
	}
	const encoded = input.content.base64
	if (
		typeof encoded !== 'string' ||
		!encoded.length ||
		encoded.length > 4 * Math.ceil(MAX_SEND_IMAGE_BYTES / 3) ||
		encoded.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
	) {
		throw new Error('Expected bounded JPEG base64 bytes')
	}
	const bytes = Uint8Array.from(atob(encoded), (character) =>
		character.charCodeAt(0),
	)
	if (
		bytes.length > MAX_SEND_IMAGE_BYTES ||
		bytes.length < 4 ||
		bytes[0] !== 255 ||
		bytes[1] !== 216 ||
		bytes.at(-2) !== 255 ||
		bytes.at(-1) !== 217
	) {
		throw new Error('Expected one JPEG image within 5 MiB')
	}
	const form = new FormData()
	form.set(
		'metadata',
		JSON.stringify({
			conversationId: input.conversationId,
			requestId: input.requestId,
			requestedBy: input.requestedBy,
			content: { kind: 'image' },
		}),
	)
	form.set('image', new Blob([bytes], { type: 'image/jpeg' }), 'image.jpg')
	return form
}
