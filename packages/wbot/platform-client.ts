import type {
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

type PlatformClientConfig = {
  baseUrl: string;
  tenantApiKey: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  onDeprecationWarning?: (warning: string) => void;
};

type PlatformEnvironment = Record<string, string | undefined>;

export class PlatformRequestError extends Error {
  readonly status: number;
  readonly code: PlatformErrorCode;

  constructor(message: string, status: number, code: PlatformErrorCode) {
    super(message);
    this.name = "PlatformRequestError";
    this.status = status;
    this.code = code;
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

export const createPlatformClientFromEnv = (environment: PlatformEnvironment): PlatformClient => {
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

export const createPlatformClient = (config: PlatformClientConfig): PlatformClient => {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (config.tenantApiKey.length === 0) {
    throw new Error("SWITCHBOARD_TENANT_API_KEY must be non-empty");
  }
  const platformFetch = config.fetch ?? fetch;
  let reportedDeprecation = false;
  const request = async <Result>(
    path: string,
    body: object | FormData,
    schema?: v.GenericSchema<unknown, Result>,
  ) => {
    const response = await platformFetch(new URL(path, baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.tenantApiKey}`,
        ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      },
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
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
