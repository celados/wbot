package cc.celados.sms;

import android.content.Context;

/** Explicit opt-in live acceptance: sends a synthetic test to the configured destination. */
final class LiveSendCheck {
    static String run(Context context) throws Exception {
        var config = context.getSharedPreferences("config", Context.MODE_PRIVATE);
        if (!config.getString("sender", "").equals("wbot")) throw new IllegalStateException("wbot not configured");
        var transport = WbotSender.https(config.getString("origin", ""), config.getString("key", ""));
        String conversation = config.getString("conversation", "");
        try (Store store = new Store(context, "wbot-live-check.db")) {
            if (store.cursor() < 0) {
                store.initialize(0);
                store.capture(1, "短信转发测试\n手机直接调用 wbot HTTPS 接口，发送到 Deniffer。此消息为连接测试。" );
            }
            for (int i = 0; i < 20; i++) {
                try (var row = store.getReadableDatabase().rawQuery("SELECT text,request_id,outbound_id,state FROM outbox WHERE id=1", null)) {
                    if (!row.moveToFirst()) throw new IllegalStateException("Missing live test record");
                    if (row.getString(3).equals("accepted")) return "accepted (retained previous test; no resend)";
                    if (row.getString(3).equals("indeterminate") || row.getString(3).equals("failed") || row.getString(3).equals("blocked")) {
                        return row.getString(3) + " (retained terminal state; no resend)";
                    }
                    var result = WbotSender.advance(transport, conversation, row.getString(1), row.getString(0), row.getString(2));
                    switch (result.phase()) {
                        case TRACKING -> store.tracking(1, result.outboundId());
                        case RETRY -> { return "retryable transport failure; stable request retained"; }
                        default -> {
                            store.state(1, result.phase().name().toLowerCase(java.util.Locale.ROOT));
                            return result.phase().name() + " outboundSendId=" + result.outboundId();
                        }
                    }
                }
                Thread.sleep(2000);
            }
            return "tracking; awaiting channel execution (lookup progress retained)";
        }
    }
}
