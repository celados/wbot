package cc.celados.sms;

import java.net.URI;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** No webhook idempotency: caller persists unknown BEFORE invoking send. */
final class SlackSender {
    enum Outcome { ACCEPTED, REJECTED, RETRY, UNKNOWN }
    record Result(Outcome outcome, long retryAfterMs) { }
    static boolean validUrl(String value) {
        try {
            URI u = URI.create(value);
            return "https".equals(u.getScheme()) && "hooks.slack.com".equals(u.getHost())
                && u.getPort() == -1 && u.getRawUserInfo() == null && u.getRawQuery() == null
                && u.getRawFragment() == null && u.getPath().matches("/services/[A-Za-z0-9]+/[A-Za-z0-9]+/[A-Za-z0-9]+")
                && u.getRawPath().equals(u.getPath());
        } catch (IllegalArgumentException e) { return false; }
    }
    static Result classify(int code, String body, String retryAfter) {
        if (code == 200 && body.trim().equals("ok")) return new Result(Outcome.ACCEPTED, 0);
        if (code == 429) {
            long seconds = 60;
            try { seconds = Math.max(1, Math.min(86400, Long.parseLong(retryAfter))); }
            catch (Exception ignored) { }
            return new Result(Outcome.RETRY, seconds * 1000);
        }
        if (code >= 400 && code < 500 && code != 408) return new Result(Outcome.REJECTED, 0);
        return new Result(Outcome.UNKNOWN, 0);
    }
    static Result send(String url, String text) {
        if (!validUrl(url)) return new Result(Outcome.REJECTED, 0);
        HttpURLConnection c = null;
        try {
            // Literal text: received SMS must never invoke Slack mentions or formatting.
            byte[] data = new JSONObject().put("text", text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
                .put("mrkdwn", false).put("unfurl_links", false).put("unfurl_media", false)
                .toString().getBytes(StandardCharsets.UTF_8);
            c = (HttpURLConnection) URI.create(url).toURL().openConnection();
            c.setInstanceFollowRedirects(false); c.setConnectTimeout(10000); c.setReadTimeout(10000);
            c.setRequestMethod("POST"); c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            c.setFixedLengthStreamingMode(data.length);
            try (var out = c.getOutputStream()) { out.write(data); }
            int code = c.getResponseCode();
            String body = "";
            if (code == 200) try (var in = c.getInputStream()) { body = new String(in.readNBytes(16385), StandardCharsets.UTF_8); }
            return classify(code, body, c.getHeaderField("Retry-After"));
        } catch (Exception e) { return new Result(Outcome.UNKNOWN, 0); }
        finally { if (c != null) c.disconnect(); }
    }
}
