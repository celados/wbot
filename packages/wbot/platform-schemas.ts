import * as v from "valibot";

const nullableString = v.nullable(v.string());

const messageContentSchema = v.variant("kind", [
  v.looseObject({ kind: v.literal("text"), text: nullableString }),
  v.looseObject({ kind: v.literal("image") }),
  v.looseObject({ kind: v.literal("audio") }),
  v.looseObject({ kind: v.literal("video") }),
  v.looseObject({
    kind: v.literal("file"),
    filename: nullableString,
    sizeBytes: nullableString,
  }),
  v.looseObject({ kind: v.literal("emoji") }),
  v.looseObject({ kind: v.literal("location") }),
  v.looseObject({
    kind: v.literal("link"),
    title: nullableString,
    description: nullableString,
    url: nullableString,
    thumbnailUrl: nullableString,
  }),
  v.looseObject({
    kind: v.literal("mini_program"),
    title: nullableString,
    appId: nullableString,
    username: nullableString,
    pagePath: nullableString,
    thumbnailUrl: nullableString,
  }),
  v.looseObject({ kind: v.literal("nudge"), suffix: nullableString }),
  v.looseObject({ kind: v.literal("unknown"), preview: v.string() }),
]);

const captureFreshnessSchema = v.looseObject({
  status: v.picklist(["unknown", "current", "delayed", "unavailable"]),
  asOfMs: nullableString,
});

const conversationAvatarSchema = v.variant("kind", [
  v.looseObject({ kind: v.literal("fallback") }),
  v.looseObject({ kind: v.literal("image"), url: v.string() }),
  v.looseObject({ kind: v.literal("composite"), urls: v.array(v.string()) }),
]);

const conversationSchema = v.looseObject({
  id: v.string(),
  channel: v.string(),
  channelConversationId: v.string(),
  kind: v.picklist(["direct", "room"]),
  title: nullableString,
  capabilities: v.array(v.picklist(["read", "send"])),
  captureFreshness: captureFreshnessSchema,
  avatar: v.optional(conversationAvatarSchema),
  latestMessage: v.nullable(
    v.looseObject({
      id: v.string(),
      direction: v.picklist(["in", "out"]),
      type: v.picklist([
        "text",
        "image",
        "audio",
        "video",
        "file",
        "emoji",
        "location",
        "link",
        "mini_program",
        "nudge",
        "unknown",
      ]),
      text: nullableString,
      content: v.nullable(messageContentSchema),
      occurredAtMs: v.string(),
    }),
  ),
});

export const conversationsPageSchema = v.looseObject({
  items: v.array(conversationSchema),
  nextCursor: v.string(),
  hasMore: v.boolean(),
});

const messageIdentitySchema = v.looseObject({
  identityId: v.string(),
  displayName: nullableString,
  avatar: v.optional(
    v.variant("status", [
      v.looseObject({ status: v.literal("pending") }),
      v.looseObject({ status: v.literal("ready"), url: v.string() }),
    ]),
  ),
});

const messageAttachmentSchema = v.variant("status", [
  v.looseObject({ status: v.literal("pending") }),
  v.looseObject({
    status: v.literal("ready"),
    url: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    descriptor: v.variant("kind", [
      v.looseObject({ kind: v.literal("image"), width: v.number(), height: v.number() }),
      v.looseObject({ kind: v.literal("file") }),
      v.looseObject({ kind: v.literal("audio"), durationMs: v.number() }),
    ]),
  }),
]);

const messageSchema = v.looseObject({
  messageId: v.string(),
  conversationId: v.string(),
  direction: v.picklist(["in", "out"]),
  content: messageContentSchema,
  sender: v.nullable(messageIdentitySchema),
  target: v.optional(v.nullable(messageIdentitySchema)),
  replyTo: v.nullable(
    v.looseObject({
      messageId: nullableString,
      sender: v.nullable(messageIdentitySchema),
      occurredAtMs: nullableString,
      content: messageContentSchema,
    }),
  ),
  occurredAtMs: v.string(),
  attachment: v.optional(messageAttachmentSchema),
});

export const messagesHistoryPageSchema = v.looseObject({
  items: v.array(messageSchema),
  nextCursor: v.string(),
  hasMore: v.boolean(),
});

export const messagesQueryResultSchema = v.looseObject({
  items: v.array(messageSchema),
  nextCursor: v.string(),
  hasMore: v.boolean(),
  captureFreshness: captureFreshnessSchema,
});

export const messageSendResultSchema = v.looseObject({
  outboundSendId: v.string(),
  conversationId: v.string(),
  status: v.literal("queued"),
});

export const outboundSendResultSchema = v.looseObject({
  outboundSendId: v.string(),
  conversationId: v.string(),
  status: v.picklist(["queued", "processing", "accepted", "failed", "indeterminate"]),
  reflectedMessageId: nullableString,
});
