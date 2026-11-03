package cc.celados.sms;

import android.content.*;
import android.provider.Telephony;

/** SMS is a wake-up hint only. The single inbox scanner still owns capture and deduplication. */
public final class SmsWakeReceiver extends android.content.BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null || !Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) return;
        var config = context.getSharedPreferences("config", Context.MODE_PRIVATE);
        if (!config.getBoolean("enabled", false)) return;
        try {
            context.startForegroundService(new Intent(context, ForwardService.class).setAction(ForwardService.DRAIN));
        } catch (RuntimeException error) {
            config.edit().putString("status", "短信唤醒暂受系统限制，将在恢复运行后补发").apply();
        }
    }
}
