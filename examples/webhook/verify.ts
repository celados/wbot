import { createHmac, timingSafeEqual } from "node:crypto";

export type Notification = {
  version: 1;
  type: "messages.available";
  eventId: string;
  conversationId: string;
  createdAtMs: number;
};

export function verifyNotification(
  body: string,
  headers: Headers,
  secret: string,
  nowMs = Date.now(),
): Notification | null {
  const timestamp = headers.get("Switchboard-Timestamp") ?? "";
  const signature = headers.get("Switchboard-Signature") ?? "";
  if (
    Buffer.byteLength(body) > 4096 ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(nowMs / 1000 - Number(timestamp)) > 300 ||
    !/^v1=[a-f0-9]{64}$/.test(signature)
  )
    return null;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex"))) return null;
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;
  const value = event as Record<string, unknown>;
  if (
    value.version !== 1 ||
    value.type !== "messages.available" ||
    typeof value.eventId !== "string" ||
    value.eventId.length < 1 ||
    value.eventId.length > 256 ||
    value.eventId !== headers.get("Switchboard-Event-Id") ||
    typeof value.conversationId !== "string" ||
    value.conversationId.length < 1 ||
    !Number.isSafeInteger(value.createdAtMs) ||
    (value.createdAtMs as number) < 0
  )
    return null;
  return value as Notification;
}
