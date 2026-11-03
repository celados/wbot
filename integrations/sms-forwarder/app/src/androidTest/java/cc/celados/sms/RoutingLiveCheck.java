package cc.celados.sms;

import android.content.Context;

/** Explicit opt-in. Independent durable test database prevents repeat sends on rerun. */
final class RoutingLiveCheck {
    static String run(Context context) throws Exception {
        var config = context.getSharedPreferences("config", Context.MODE_PRIVATE);
        if (!config.getBoolean("routing_enabled", false) || !config.getBoolean("enabled", false)) throw new IllegalStateException("Routing not enabled");
        try (Store store = new Store(context, "routing-live-check-v05.db")) {
            int cmcc = config.getInt("cmcc_sub_id", -1), air = config.getInt("air_sub_id", -1);
            String direct = config.getString("conversation", ""), group = config.getString("air_conversation", "");
            if (store.cursor() < 0) store.initialize(0);
            if (store.cursor() == 0) store.captureRouted(1, cmcc,
                "【短信分卡转发测试】CMCC 路由验证：本条为手机生成的合成测试，不是真实短信。应仅出现在 Deniffer 私聊。", Routing.plan(cmcc,cmcc,air,direct,group));
            if (store.cursor() == 1) store.captureRouted(2, air,
                "【短信分卡转发测试】AIR MOBILE 路由验证：本条为手机生成的合成测试，不含真实短信或验证码。应同时出现在 Celados 微信群和 Slack 短信频道。", Routing.plan(air,cmcc,air,direct,group));
            for (int i=0; i<12 && store.routedCount()>0; i++) {
                RoutedDelivery.drain(store,config,()->false);
                Thread.sleep(2000);
            }
            if (store.routedCount()==0) return "PASS: CMCC WeChat accepted; AIR WeChat accepted and Slack webhook acknowledged. No recipient-read claim.";
            StringBuilder result = new StringBuilder("Retained outcomes:");
            try (var rows=store.getReadableDatabase().rawQuery("SELECT destination,state,COUNT(*) FROM deliveries GROUP BY destination,state",null)) {
                while(rows.moveToNext()) result.append(" ").append(rows.getString(0)).append("/").append(rows.getString(1)).append("=").append(rows.getInt(2));
            }
            return result.toString();
        }
    }
}
