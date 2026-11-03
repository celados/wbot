package cc.celados.sms;

import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;

/** The phone consumes the same public tenant API as the wbot CLI. */
final class WbotSender {
    enum Phase { RETRY, TRACKING, ACCEPTED, FAILED, INDETERMINATE, BLOCKED }
    record Result(Phase phase, String outboundId) { }
    interface Transport { JSONObject post(String path, JSONObject body) throws Exception; }
    static final class HttpFailure extends IOException {
        final int code;
        HttpFailure(int code) { super("HTTP " + code); this.code = code; }
    }
    static boolean validOrigin(String value) {
        try {
            URI uri = URI.create(value);
            return "https".equals(uri.getScheme()) && uri.getHost() != null
                && uri.getRawUserInfo() == null && uri.getRawQuery() == null && uri.getRawFragment() == null
                && (uri.getPath().isEmpty() || uri.getPath().equals("/"));
        } catch (IllegalArgumentException error) { return false; }
    }
    static Transport https(String origin, String key) {
        if (!validOrigin(origin) || key.isBlank() || key.contains("\n") || key.contains("\r")) {
            throw new IllegalArgumentException("Invalid wbot configuration");
        }
        return (path, payload) -> {
            HttpURLConnection connection = (HttpURLConnection) URI.create(origin).resolve(path).toURL().openConnection();
            try {
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(10000); connection.setReadTimeout(10000);
                connection.setRequestMethod("POST"); connection.setDoOutput(true);
                connection.setRequestProperty("Authorization", "Bearer " + key);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(body.length);
                try (var output = connection.getOutputStream()) { output.write(body); }
                int code = connection.getResponseCode();
                if (code < 200 || code >= 300) throw new HttpFailure(code);
                try (InputStream input = connection.getInputStream()) {
                    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                    byte[] chunk = new byte[1024]; int length;
                    while (buffer.size() <= 16384 && (length = input.read(chunk)) != -1) buffer.write(chunk, 0, length);
                    if (buffer.size() > 16384) throw new org.json.JSONException("Oversized response");
                    return new JSONObject(buffer.toString(StandardCharsets.UTF_8));
                }
            } finally { connection.disconnect(); }
        };
    }
    static Result advance(Transport transport, String conversation, String requestId, String text, String outboundId) {
        try {
            boolean submitting = outboundId == null;
            JSONObject response = submitting
                ? transport.post("/platform/v1/messages/send", new JSONObject()
                    .put("conversationId", conversation).put("requestId", requestId).put("text", text)
                    .put("requestedBy", "device:sms-forwarder"))
                : transport.post("/platform/v1/outbound-sends/get", new JSONObject().put("outboundSendId", outboundId));
            String id = string(response, "outboundSendId");
            if (id.isBlank() || !string(response, "conversationId").equals(conversation)
                    || (!submitting && !id.equals(outboundId))) return new Result(Phase.BLOCKED, outboundId);
            String state = string(response, "status");
            if (submitting) return state.equals("queued")
                ? new Result(Phase.TRACKING, id) : new Result(Phase.BLOCKED, outboundId);
            if (!response.has("reflectedMessageId") || (!response.isNull("reflectedMessageId")
                    && !(response.get("reflectedMessageId") instanceof String))) return new Result(Phase.BLOCKED, outboundId);
            return new Result(switch (state) {
                case "queued", "processing" -> Phase.TRACKING;
                case "accepted" -> Phase.ACCEPTED;
                case "failed" -> Phase.FAILED;
                case "indeterminate" -> Phase.INDETERMINATE;
                default -> Phase.BLOCKED;
            }, id);
        } catch (HttpFailure error) {
            return new Result(error.code == 408 || error.code == 429 || error.code >= 500 ? Phase.RETRY : Phase.BLOCKED, outboundId);
        } catch (IOException error) {
            return new Result(Phase.RETRY, outboundId);
        } catch (Exception error) {
            return new Result(Phase.BLOCKED, outboundId);
        }
    }
    private static String string(JSONObject object, String field) throws Exception {
        Object value = object.get(field);
        if (!(value instanceof String)) throw new org.json.JSONException("Invalid response field");
        return (String) value;
    }
}
