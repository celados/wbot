package cc.celados.sms;

import android.content.SharedPreferences;
import java.util.function.BooleanSupplier;

final class RoutedDelivery {
    static void drain(Store store, SharedPreferences config, BooleanSupplier stopping) throws InterruptedException {
        var api = WbotSender.https(config.getString("origin", ""), config.getString("key", ""));
        // Separate bounded pages prevent a backlog at one destination from starving the other.
        for (String destination : new String[]{"wbot", "slack"}) {
            if (destination.equals("slack") && config.getLong("slack_retry_at", 0) > System.currentTimeMillis()) continue;
            try (var rows = store.getReadableDatabase().rawQuery(
                    "SELECT id,text,request_id,outbound_id,target FROM deliveries WHERE destination=? AND state IN ('pending','tracking') AND retry_at<=? ORDER BY id LIMIT 5",
                    new String[]{destination, Long.toString(System.currentTimeMillis())})) {
                while (rows.moveToNext()) {
                    if (stopping.getAsBoolean() || !config.getBoolean("enabled", false)) return;
                    long id = rows.getLong(0);
                    if (destination.equals("wbot")) {
                        var result = WbotSender.advance(api, rows.getString(4), rows.getString(2), rows.getString(1), rows.getString(3));
                        switch (result.phase()) {
                            case ACCEPTED -> store.deliverySent(id);
                            case TRACKING -> store.deliveryState(id, "tracking", result.outboundId(), 0);
                            case RETRY -> store.deliveryState(id, rows.isNull(3) ? "pending" : "tracking", rows.getString(3), System.currentTimeMillis() + 15000);
                            default -> store.deliveryState(id, result.phase().name().toLowerCase(java.util.Locale.ROOT), result.outboundId(), 0);
                        }
                    } else {
                        String webhook = config.getString("slack_webhook", "");
                        if (!SlackSender.validUrl(webhook)) {
                            store.deliveryState(id, "blocked", null, 0); continue;
                        }
                        store.deliveryState(id, "unknown", null, 0);
                        var result = SlackSender.send(webhook, rows.getString(1));
                        switch (result.outcome()) {
                            case ACCEPTED -> store.deliverySent(id);
                            case RETRY -> {
                                long at = System.currentTimeMillis() + result.retryAfterMs();
                                // Persist the channel-wide cooldown before making this job eligible again.
                                if (config.edit().putLong("slack_retry_at", at).commit()) store.deliveryState(id, "pending", null, at);
                            }
                            case REJECTED -> store.deliveryState(id, "rejected", null, 0);
                            case UNKNOWN -> { /* Preserved before dispatch; never automatically resent. */ }
                        }
                        if (result.outcome() == SlackSender.Outcome.RETRY) break;
                        Thread.sleep(1100);
                    }
                }
            }
        }
    }
}
