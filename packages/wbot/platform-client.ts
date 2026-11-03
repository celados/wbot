import type {
  WebhookConfigureInput,
  WebhookIdentityInput,
  WebhookResult,
  ConversationResult,
  ConversationsQueryInput,
  MessageResult,
  MessagesHistoryInput,
  MessagesQueryResult,
  MessageSendInput,
  ImageMessageSendInput,
  MessageSendResult,
  MessagesQueryInput,
  OutboundSendGetInput,
  OutboundSendResult,
  Page,
  PlatformErrorCode,
} from "./platform-types";
import type * as v from "valibot";

import { safeParse } from "valibot";

import {
  webhookResultSchema,
  webhookListResultSchema,
  webhookRemoveResultSchema,
  conversationsPageSchema,
  messagesHistoryPageSchema,
  messagesQueryResultSchema,
  messageSendResultSchema,
  outboundSendResultSchema,
} from "./platform-schemas";

export type PlatformClient = {
  queryConversations: (input?: ConversationsQueryInput) => Promise<Page<ConversationResult>>;
  queryMessages: (input: MessagesQueryInput) => Promise<MessagesQueryResult>;
  queryMessageHistory: (input: MessagesHistoryInput) => Promise<Page<MessageResult>>;
  sendMessage: (input: MessageSendInput | ImageMessageSendInput) => Promise<MessageSendResult>;
  getOutboundSend: (input: OutboundSendGetInput) => Promise<OutboundSendResult>;
};

// Keep PlatformClient's existing structural contract compatible for existing implementations.
export type WebhookClient = {
  configureWebhook: (input: WebhookConfigureInput) => Promise<WebhookResult>;
  listWebhooks: () => Promise<{ items: WebhookResult[] }>;
  removeWebhook: (input: WebhookIdentityInput) => Promise<{ removed: boolean }>;
  retryWebhook: (input: WebhookIdentityInput) => Promise<WebhookResult>;
};
export type WbotClient = PlatformClient & WebhookClient;

type PlatformClientConfig = {
  baseUrl: string;
  tenantApiKey: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  onDeprecationWarning?: (warning: string) => void;
  /** Injectable delay used before the single 429 retry; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
};

/** Upper bound on one honoured Retry-After wait so a bad header cannot hang a caller. */
export const maxRateLimitRetryWaitMs = 60_000;

type PlatformEnvironment = Record<string, string | undefined>;

export class PlatformRequestError extends Error {
  readonly status: number;
  readonly code: PlatformErrorCode;
  /** Present on `rate_limited`: how long the Platform asked the caller to wait. */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    status: number,
    code: PlatformErrorCode,
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "PlatformRequestError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export class PlatformContractError extends Error {
  readonly code = "invalid_platform_response" as const;
  readonly endpoint: string;
  readonly issuePaths: readonly string[];

  constructor(endpoint: string, issuePaths: readonly string[]) {
    const location = issuePaths.length > 0 ? issuePaths.join(", ") : "<root>";
    super(`Platform returned an invalid response for ${endpoint} at ${location}.`);
    this.name = "PlatformContractError";
    this.endpoint = endpoint;
    this.issuePaths = issuePaths;
  }
}

export const createPlatformClientFromEnv = (environment: PlatformEnvironment): WbotClient => {
  const baseUrl = environment.SWITCHBOARD_PLATFORM_URL;
  const tenantApiKey = environment.SWITCHBOARD_TENANT_API_KEY;
  const missing = [
    baseUrl === undefined ? "SWITCHBOARD_PLATFORM_URL" : null,
    tenantApiKey === undefined ? "SWITCHBOARD_TENANT_API_KEY" : null,
  ].filter((name) => name !== null);
  if (missing.length > 0) {
    throw new Error(`Missing configuration: ${missing.join(", ")}`);
  }
  if (baseUrl === undefined || tenantApiKey === undefined) {
    throw new Error("Missing Platform configuration");
  }
  return createPlatformClient({ baseUrl, tenantApiKey });
};

export const createPlatformClient = (config: PlatformClientConfig): WbotClient => {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (config.tenantApiKey.length === 0) {
    throw new Error("SWITCHBOARD_TENANT_API_KEY must be non-empty");
  }
  const platformFetch = config.fetch ?? fetch;
  const sleep =
    config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let reportedDeprecation = false;
  const send = (path: string, body: object | FormData) =>
    platformFetch(new URL(path, baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.tenantApiKey}`,
        ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      },
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
  const request = async <Result>(
    path: string,
    body: object | FormData,
    schema?: v.GenericSchema<unknown, Result>,
  ) => {
    let response = await send(path, body);
    if (response.status === 429) {
      // A 429 is rejected before any work, so one retry of the same request is safe,
      // including sends that carry the same caller-owned requestId.
      const payload = await response.json().catch(() => null);
      await sleep(rateLimitWaitMs(response, payload));
      response = await send(path, body);
    }
    if (response.ok && !reportedDeprecation) {
      const warning = readDeprecationWarning(response.headers);
      if (warning) {
        reportedDeprecation = true;
        config.onDeprecationWarning?.(warning);
      }
    }
    const payload = await readResponseBody(response, path);
    if (!response.ok) {
      const error = readError(payload);
      if (response.status === 429) {
        const retryAfterMs = rateLimitWaitMs(response, payload, Number.POSITIVE_INFINITY);
        throw new PlatformRequestError(
          `${error?.message ?? "Platform rate limit exceeded"} (rate_limited; retry after ${Math.ceil(retryAfterMs / 1000)}s)`,
          429,
          "rate_limited",
          retryAfterMs,
        );
      }
      throw new PlatformRequestError(
        error?.message ?? `Platform request failed (${response.status})`,
        response.status,
        error?.code ?? "internal_error",
      );
    }
    if (!schema) return payload as Result;
    const result = safeParse(schema, payload);
    if (!result.success) {
      const issuePaths = result.issues.flatMap((issue) => {
        const path = issue.path?.map((item) => String(item.key)).join(".");
        return path ? [path] : [];
      });
      throw new PlatformContractError(path, issuePaths);
    }
    return result.output;
  };

  return {
    configureWebhook: (input) =>
      request("/platform/v1/webhooks/configure", input, webhookResultSchema),
    listWebhooks: () => request("/platform/v1/webhooks/list", {}, webhookListResultSchema),
    removeWebhook: (input) =>
      request("/platform/v1/webhooks/remove", input, webhookRemoveResultSchema),
    retryWebhook: (input) => request("/platform/v1/webhooks/retry", input, webhookResultSchema),
    queryConversations: (input = {}) =>
      request<Page<ConversationResult>>(
        "/platform/v1/conversations/query",
        input,
        conversationsPageSchema,
      ),
    queryMessages: (input) =>
      request<MessagesQueryResult>("/platform/v1/messages/query", input, messagesQueryResultSchema),
    queryMessageHistory: (input) =>
      request<Page<MessageResult>>(
        "/platform/v1/messages/history",
        input,
        messagesHistoryPageSchema,
      ),
    sendMessage: (input) =>
      request<MessageSendResult>(
        "/platform/v1/messages/send",
        encodeSendInput(input),
        messageSendResultSchema,
      ),
    getOutboundSend: (input) =>
      request<OutboundSendResult>(
        "/platform/v1/outbound-sends/get",
        input,
        outboundSendResultSchema,
      ),
  };
};

const readDeprecationWarning = (headers: Headers): string | null => {
  const deprecation = headers.get("Deprecation");
  const sunset = headers.get("Sunset");
  const link = headers.get("Link");
  if (!deprecation && !sunset) return null;
  return [
    "Platform API deprecation",
    deprecation ? `deprecated=${deprecation}` : null,
    sunset ? `sunset=${sunset}` : null,
    link ? `migration=${link}` : null,
  ]
    .filter((part) => part !== null)
    .join("; ");
};

const normalizeBaseUrl = (value: string) => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SWITCHBOARD_PLATFORM_URL must use http or https");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
};

const readResponseBody = async (response: Response, endpoint: string): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    if (response.ok) throw new PlatformContractError(endpoint, ["<json>"]);
    throw new PlatformRequestError(
      `Platform returned invalid JSON (${response.status})`,
      response.status,
      "internal_error",
    );
  }
};

const rateLimitWaitMs = (
  response: Response,
  payload: unknown,
  maxWaitMs: number = maxRateLimitRetryWaitMs,
) => {
  const header = Number(response.headers.get("Retry-After") ?? Number.NaN);
  const fromHeader = Number.isFinite(header) && header > 0 ? header * 1000 : null;
  const fromBody = readRetryAfterMs(payload);
  return Math.min(fromHeader ?? fromBody ?? 1000, maxWaitMs);
};

const readRetryAfterMs = (payload: unknown): number | null => {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return null;
  const error = payload.error;
  if (typeof error !== "object" || error === null || !("retryAfterMs" in error)) return null;
  const value = error.retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
};

const readError = (payload: unknown): { code: PlatformErrorCode; message: string } | null => {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) {
    return null;
  }
  if (typeof payload.error === "string") {
    return { code: "internal_error", message: payload.error };
  }
  if (
    typeof payload.error === "object" &&
    payload.error !== null &&
    "code" in payload.error &&
    isPlatformErrorCode(payload.error.code) &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return { code: payload.error.code, message: payload.error.message };
  }
  return null;
};

const isPlatformErrorCode = (value: unknown): value is PlatformErrorCode =>
  typeof value === "string" &&
  [
    "unauthorized",
    "invalid_request",
    "forbidden",
    "not_found",
    "conflict",
    "invalid_cursor",
    "unsupported_cursor_version",
    "rate_limited",
    "internal_error",
  ].includes(value);

export const MAX_SEND_IMAGE_BYTES = 5 * 1024 * 1024;

const encodeSendInput = (input: MessageSendInput | ImageMessageSendInput): object | FormData => {
  if (!("content" in input)) return input;
  if (input.text !== undefined || input.content?.kind !== "image") {
    throw new Error("Specify exactly one text or image content");
  }
  const encoded = input.content.base64;
  if (
    typeof encoded !== "string" ||
    !encoded.length ||
    encoded.length > 4 * Math.ceil(MAX_SEND_IMAGE_BYTES / 3) ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new Error("Expected bounded JPEG base64 bytes");
  }
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  if (
    bytes.length > MAX_SEND_IMAGE_BYTES ||
    bytes.length < 4 ||
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes.at(-2) !== 255 ||
    bytes.at(-1) !== 217
  ) {
    throw new Error("Expected one JPEG image within 5 MiB");
  }
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      conversationId: input.conversationId,
      requestId: input.requestId,
      requestedBy: input.requestedBy,
      content: { kind: "image" },
    }),
  );
  form.set("image", new Blob([bytes], { type: "image/jpeg" }), "image.jpg");
  return form;
};
