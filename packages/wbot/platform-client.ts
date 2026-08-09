import type {
  ConversationResult,
  ConversationsQueryInput,
  MessageResult,
  MessagesHistoryInput,
  MessageSendInput,
  MessageSendResult,
  MessagesQueryInput,
  OutboundSendGetInput,
  OutboundSendResult,
  Page,
  PlatformErrorCode,
} from "./platform-types";

export type PlatformClient = {
  queryConversations: (input?: ConversationsQueryInput) => Promise<Page<ConversationResult>>;
  queryMessages: (input: MessagesQueryInput) => Promise<Page<MessageResult>>;
  queryMessageHistory: (input: MessagesHistoryInput) => Promise<Page<MessageResult>>;
  sendMessage: (input: MessageSendInput) => Promise<MessageSendResult>;
  getOutboundSend: (input: OutboundSendGetInput) => Promise<OutboundSendResult>;
};

type PlatformClientConfig = {
  baseUrl: string;
  tenantApiKey: string;
  fetch?: typeof fetch;
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
  const request = async <Result>(path: string, body: object) => {
    const response = await platformFetch(new URL(path, baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.tenantApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = await readResponseBody(response);
    if (!response.ok) {
      const error = readError(payload);
      throw new PlatformRequestError(
        error?.message ?? `Platform request failed (${response.status})`,
        response.status,
        error?.code ?? "internal_error",
      );
    }
    return payload as Result;
  };

  return {
    queryConversations: (input = {}) =>
      request<Page<ConversationResult>>("/platform/v1/conversations/query", input),
    queryMessages: (input) => request<Page<MessageResult>>("/platform/v1/messages/query", input),
    queryMessageHistory: (input) =>
      request<Page<MessageResult>>("/platform/v1/messages/history", input),
    sendMessage: (input) => request<MessageSendResult>("/platform/v1/messages/send", input),
    getOutboundSend: (input) =>
      request<OutboundSendResult>("/platform/v1/outbound-sends/get", input),
  };
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

const readResponseBody = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
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
