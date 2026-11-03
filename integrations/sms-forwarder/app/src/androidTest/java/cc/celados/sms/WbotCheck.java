package cc.celados.sms;

import java.io.IOException;
import java.util.ArrayList;
import org.json.JSONObject;

/** Exercise protocol decisions with synthetic replies; no live messages or credentials. */
final class WbotCheck {
    static void run() throws Exception {
        var payloads = new ArrayList<String>();
        var paths = new ArrayList<String>();
        WbotSender.Transport losesReply = (path, body) -> {
            paths.add(path); payloads.add(body.toString()); throw new IOException("lost reply");
        };
        for (int i = 0; i < 2; i++) require(WbotSender.advance(losesReply, "room", "sms:fixed", "测试\nhello", null).phase() == WbotSender.Phase.RETRY);
        require(payloads.size() == 2 && payloads.get(0).equals(payloads.get(1)));
        JSONObject submitted = new JSONObject(payloads.get(0));
        require(submitted.getString("requestId").equals("sms:fixed") && submitted.getString("text").equals("测试\nhello"));
        var queued = new JSONObject().put("outboundSendId", "send-1").put("conversationId", "room").put("status", "queued");
        var first = WbotSender.advance((path, body) -> queued, "room", "sms:fixed", "text", null);
        require(first.phase() == WbotSender.Phase.TRACKING && first.outboundId().equals("send-1"));
        for (String state : new String[]{"queued", "processing", "accepted", "failed", "indeterminate"}) {
            WbotSender.Transport lookup = (path, body) -> {
                require(path.equals("/platform/v1/outbound-sends/get"));
                require(body.length() == 1 && body.getString("outboundSendId").equals("send-1"));
                return new JSONObject(queued.toString()).put("status", state).put("reflectedMessageId", JSONObject.NULL);
            };
            var result = WbotSender.advance(lookup, "room", "sms:fixed", "text", "send-1");
            require(result.phase() == switch (state) {
                case "accepted" -> WbotSender.Phase.ACCEPTED;
                case "failed" -> WbotSender.Phase.FAILED;
                case "indeterminate" -> WbotSender.Phase.INDETERMINATE;
                default -> WbotSender.Phase.TRACKING;
            });
        }
        require(WbotSender.advance((path, body) -> new JSONObject(queued.toString()).put("conversationId", "wrong"),
            "room", "sms:fixed", "text", null).phase() == WbotSender.Phase.BLOCKED);
        require(WbotSender.advance((path, body) -> new JSONObject(queued.toString()).put("outboundSendId", 42),
            "room", "sms:fixed", "text", null).phase() == WbotSender.Phase.BLOCKED);
        require(WbotSender.advance((path, body) -> { throw new WbotSender.HttpFailure(403); },
            "room", "sms:fixed", "text", null).phase() == WbotSender.Phase.BLOCKED);
        require(WbotSender.advance((path, body) -> { throw new WbotSender.HttpFailure(503); },
            "room", "sms:fixed", "text", "send-1").outboundId().equals("send-1"));
        require(!WbotSender.validOrigin("http://example.com") && !WbotSender.validOrigin("https://key@example.com")
            && !WbotSender.validOrigin("https://example.com/path"));
    }
    private static void require(boolean value) { if (!value) throw new AssertionError("wbot protocol check failed"); }
}
