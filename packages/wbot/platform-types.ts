export type Page<T> = {
  items: Array<T>;
  nextCursor: string;
  hasMore: boolean;
};

export type MessageContent =
  | { kind: "text"; text: string | null }
  | { kind: "image" }
  | { kind: "audio" }
  | { kind: "video" }
  | { kind: "file"; filename: string | null; sizeBytes: string | null }
  | { kind: "emoji" }
  | { kind: "location" }
  | {
      kind: "link";
      title: string | null;
      description: string | null;
      url: string | null;
      thumbnailUrl: string | null;
    }
  | {
      kind: "mini_program";
      title: string | null;
      appId: string | null;
      username: string | null;
      pagePath: string | null;
      thumbnailUrl: string | null;
    }
  | { kind: "nudge"; suffix: string | null }
  | { kind: "unknown"; preview: string };

export type ConversationsQueryInput = {
  cursor?: string;
  limit?: number;
};

export type ConversationAvatar =
  | { kind: "fallback" }
  | { kind: "image"; url: string }
  | { kind: "composite"; urls: Array<string> };

export type ConversationCapability = "read" | "send";

export type CaptureFreshness = {
  status: "unknown" | "current" | "delayed" | "unavailable";
  asOfMs: string | null;
};

export type ConversationResult = {
  id: string;
  channel: string;
  channelConversationId: string;
  kind: "direct" | "room";
  title: string | null;
  capabilities: Array<ConversationCapability>;
  captureFreshness: CaptureFreshness;
  avatar?: ConversationAvatar;
  latestMessage: {
    id: string;
    direction: "in" | "out";
    type: MessageContent["kind"];
    text: string | null;
    content: MessageContent | null;
    occurredAtMs: string;
  } | null;
};

export type MessagesQueryInput = {
  conversationId: string;
  cursor?: string;
  limit?: number;
};

export type MessagesHistoryInput = {
  conversationId: string;
  cursor?: string;
  limit?: number;
};

export type MessageIdentity = {
  identityId: string;
  displayName: string | null;
  avatar?:
    | { status: "pending" }
    | {
        status: "ready";
        url: string;
      };
};

export type MessageAttachment =
  | { status: "pending" }
  | {
      status: "ready";
      url: string;
      mimeType: string;
      sizeBytes: number;
      descriptor:
        | { kind: "image"; width: number; height: number }
        | { kind: "file" }
        | { kind: "audio"; durationMs: number };
    };

export type MessageResult = {
  messageId: string;
  conversationId: string;
  direction: "in" | "out";
  content: MessageContent;
  sender: MessageIdentity | null;
  target?: MessageIdentity | null;
  replyTo: {
    messageId: string | null;
    sender: MessageIdentity | null;
    occurredAtMs: string | null;
    content: MessageContent;
  } | null;
  occurredAtMs: string;
  attachment?: MessageAttachment;
};

export type MessagesQueryResult = Page<MessageResult> & {
  captureFreshness: CaptureFreshness;
};

export type MessageSendInput = {
  conversationId: string;
  requestId: string;
  text: string;
  requestedBy: string;
};

export type MessageSendResult = {
  outboundSendId: string;
  conversationId: string;
  status: "queued";
};

export type OutboundSendGetInput = {
  outboundSendId: string;
};

export type OutboundSendResult = {
  outboundSendId: string;
  conversationId: string;
  status: "queued" | "processing" | "accepted" | "failed" | "indeterminate";
  reflectedMessageId: string | null;
};

export type PlatformErrorCode =
  | "unauthorized"
  | "invalid_request"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_cursor"
  | "unsupported_cursor_version"
  | "internal_error";
