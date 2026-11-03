package cc.celados.sms;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Resume only the user's previously enabled forwarding after unlock or an APK update. */
public final class ResumeReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null || (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction()))) return;
        var config = context.getSharedPreferences("config", Context.MODE_PRIVATE);
        if (!config.getBoolean("enabled", false)) return;
        try { context.startForegroundService(new Intent(context, ForwardService.class)); }
        catch (RuntimeException error) {
            config.edit().putString("status", "系统暂未允许自动恢复，请打开短信转发应用").apply();
        }
    }
}
