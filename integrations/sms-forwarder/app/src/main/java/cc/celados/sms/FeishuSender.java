package cc.celados.sms;

import org.json.JSONObject;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;

/** Feishu webhooks have no idempotency key: an unknown outcome must stay unknown. */
final class FeishuSender {
    enum Outcome { ACCEPTED, REJECTED, UNKNOWN }
    static boolean validUrl(String value) {
        try {
            URI uri = URI.create(value);
            return "https".equals(uri.getScheme()) && "open.feishu.cn".equals(uri.getHost())
                && uri.getPort() == -1 && uri.getRawUserInfo() == null
                && uri.getRawQuery() == null && uri.getRawFragment() == null
                && uri.getPath().matches("/open-apis/bot/v2/hook/[a-zA-Z0-9-]+");
        } catch (IllegalArgumentException error) { return false; }
    }
    static Outcome send(String url, String text) {
        HttpURLConnection connection = null;
        try {
            if (!validUrl(url)) return Outcome.REJECTED;
            byte[] body = new JSONObject().put("msg_type", "text")
                .put("content", new JSONObject().put("text", text)).toString().getBytes(StandardCharsets.UTF_8);
            connection = (HttpURLConnection) URI.create(url).toURL().openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10000); connection.setReadTimeout(10000);
            connection.setRequestMethod("POST"); connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setFixedLengthStreamingMode(body.length);
            try (var output = connection.getOutputStream()) { output.write(body); }
            int code = connection.getResponseCode();
            if (code != 200) return Outcome.UNKNOWN;
            try (InputStream input = connection.getInputStream()) {
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] chunk = new byte[1024];
                int length;
                while (buffer.size() <= 16384 && (length = input.read(chunk)) != -1) buffer.write(chunk, 0, length);
                byte[] response = buffer.toByteArray();
                if (response.length > 16384) return Outcome.UNKNOWN;
                JSONObject result = new JSONObject(new String(response, StandardCharsets.UTF_8));
                if (!result.has("code")) return Outcome.UNKNOWN;
                return result.getInt("code") == 0 ? Outcome.ACCEPTED : Outcome.REJECTED;
            }
        } catch (Exception error) { return Outcome.UNKNOWN; }
        finally { if (connection != null) connection.disconnect(); }
    }
}
