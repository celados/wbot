package cc.celados.sms;

import android.content.*;

final class LifecycleCheck {
    static void run(Context context) {
        String name = "lifecycle-check-" + System.nanoTime();
        var prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE);
        class RecordingContext extends ContextWrapper {
            Intent started;
            RecordingContext() { super(context); }
            @Override public SharedPreferences getSharedPreferences(String ignored, int mode) { return prefs; }
            @Override public ComponentName startForegroundService(Intent intent) { started = intent; return intent.getComponent(); }
        }
        var target = new RecordingContext();
        var receiver = new ResumeReceiver();
        try {
            receiver.onReceive(target, new Intent(Intent.ACTION_BOOT_COMPLETED));
            require(target.started == null, "disabled forwarding must stay disabled on boot");
            prefs.edit().putBoolean("enabled", true).commit();
            receiver.onReceive(target, new Intent("untrusted.action"));
            require(target.started == null, "unrelated broadcasts must not start forwarding");
            receiver.onReceive(target, new Intent(Intent.ACTION_BOOT_COMPLETED));
            require(target.started != null && target.started.getComponent().getClassName().equals(ForwardService.class.getName()), "boot resumes only the forwarding service");
            target.started = null;
            receiver.onReceive(target, new Intent(Intent.ACTION_MY_PACKAGE_REPLACED));
            require(target.started != null, "APK replacement resumes enabled forwarding");
            prefs.edit().putBoolean("enabled", false).commit(); target.started = null;
            receiver.onReceive(target, new Intent(Intent.ACTION_MY_PACKAGE_REPLACED));
            require(target.started == null, "APK replacement respects the stop button");
            var sms = new SmsWakeReceiver();
            Intent arrived = new Intent(android.provider.Telephony.Sms.Intents.SMS_RECEIVED_ACTION);
            sms.onReceive(target, arrived);
            require(target.started == null, "SMS must not override the user's stop choice");
            prefs.edit().putBoolean("enabled", true).commit();
            sms.onReceive(target, arrived);
            require(target.started != null && ForwardService.DRAIN.equals(target.started.getAction()), "SMS requests only the existing scanner drain");
        } finally { context.deleteSharedPreferences(name); }
    }
    private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
