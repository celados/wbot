package cc.celados.sms;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.ContentObserver;
import android.net.*;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Telephony;
import java.text.DateFormat;
import java.util.Date;
import java.util.concurrent.*;

public final class ForwardService extends Service {
    static final String DRAIN = "cc.celados.sms.DRAIN";
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private volatile boolean stopping;
    private ContentObserver observer;
    private volatile PowerManager.WakeLock signalLock;
    private final java.util.concurrent.atomic.AtomicBoolean hinted = new java.util.concurrent.atomic.AtomicBoolean();
    @Override public void onCreate() {
        super.onCreate();
        getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel("forwarding", "短信转发状态", NotificationManager.IMPORTANCE_LOW));
        startForeground(1, new Notification.Builder(this, "forwarding")
            .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("短信转发已开启")
            .setContentText("正在检查新短信；点此查看状态")
            .setContentIntent(PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
            .setOngoing(true).build());
        observer = new ContentObserver(new Handler(Looper.getMainLooper())) {
            @Override public void onChange(boolean selfChange) { hint(); }
        };
        if (checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED) {
            getContentResolver().registerContentObserver(Telephony.Sms.CONTENT_URI, true, observer);
        }
        worker.scheduleWithFixedDelay(this::awakeTick, 0, 15, TimeUnit.SECONDS);
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && DRAIN.equals(intent.getAction())) hint();
        return START_STICKY;
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() {
        stopping = true;
        if (observer != null) getContentResolver().unregisterContentObserver(observer);
        PowerManager.WakeLock pending = signalLock;
        if (pending != null && pending.isHeld()) pending.release();
        worker.shutdownNow(); super.onDestroy();
    }
    private void hint() {
        if (stopping || !hinted.compareAndSet(false, true)) return;
        PowerManager.WakeLock bridge = getSystemService(PowerManager.class).newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK, "sms-forwarder:signal");
        bridge.setReferenceCounted(false); bridge.acquire(5000); signalLock = bridge;
        // Give the SMS provider time to commit its row; coalesce bursts into one drain.
        try { worker.schedule(() -> {
            hinted.set(false);
            try { awakeTick(); }
            finally { if (bridge.isHeld()) bridge.release(); }
        }, 300, TimeUnit.MILLISECONDS); }
        catch (RejectedExecutionException error) {
            hinted.set(false); if (bridge.isHeld()) bridge.release();
        }
    }
    private void awakeTick() {
        if (stopping) return;
        PowerManager.WakeLock lock = getSystemService(PowerManager.class).newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK, "sms-forwarder:delivery");
        lock.setReferenceCounted(false);
        // Keep only the CPU awake during work. Never turn on the display or hold a permanent lock.
        lock.acquire(45000);
        try { tick(); }
        finally { if (lock.isHeld()) lock.release(); }
    }
    private void status(String text) {
        getSharedPreferences("config", MODE_PRIVATE).edit().putString("status", text).apply();
    }
    private boolean online() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(manager.getActiveNetwork());
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }
    private void tick() {
        if (stopping) return;
        var config = getSharedPreferences("config", MODE_PRIVATE);
        if (!config.getBoolean("enabled", false)) { stopSelf(); return; }
        if (checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            status("缺少短信读取权限"); return;
        }
        try (Store store = new Store(this)) {
            boolean routed = config.getBoolean("routing_enabled", false);
            if (store.cursor() < 0) {
                try (Cursor rows = getContentResolver().query(Telephony.Sms.Inbox.CONTENT_URI,
                        new String[]{"_id"}, null, null, "_id DESC LIMIT 1")) {
                    if (rows == null) throw new IllegalStateException();
                    store.initialize(rows.moveToFirst() ? rows.getLong(0) : 0);
                }
                status("已启用，只转发之后的新短信");
            }
            // Capture and delivery have one serialized owner; bound retained sensitive data.
            if (store.count() < 999) {
                try (Cursor rows = getContentResolver().query(Telephony.Sms.Inbox.CONTENT_URI,
                        routed ? new String[]{"_id", "address", "date", "body", "sub_id"} : new String[]{"_id", "address", "date", "body"}, "_id > ?",
                        new String[]{Long.toString(store.cursor())}, "_id ASC LIMIT 50")) {
                    if (rows == null) throw new IllegalStateException();
                    while (!stopping && rows.moveToNext()) {
                        if (store.count() >= 999) break;
                        String text = "短信转发\n来源：" + rows.getString(1) + "\n时间："
                            + DateFormat.getDateTimeInstance().format(new Date(rows.getLong(2)))
                            + "\n" + rows.getString(3);
                        if (routed) {
                            int subId = rows.isNull(4) ? -1 : rows.getInt(4);
                            var plan = Routing.plan(subId, config.getInt("cmcc_sub_id", -1), config.getInt("air_sub_id", -1),
                                config.getString("conversation", ""), config.getString("air_conversation", ""));
                            store.captureRouted(rows.getLong(0), subId, "卡：" + plan.label() + "\n" + text, plan);
                        } else store.capture(rows.getLong(0), text);
                    }
                }
            } else { status("积压已达到 1000 条，暂停采集；请处理发送异常"); }
            config.edit().putLong("last_scan_ms", System.currentTimeMillis()).apply();
            if (!online()) { status("离线，待发送 " + store.count() + " 条"); return; }
            String url = config.getString("url", "");
            boolean wbot = config.getString("sender", "feishu").equals("wbot");
            WbotSender.Transport api = wbot ? WbotSender.https(config.getString("origin", ""), config.getString("key", "")) : null;
            String conversation = config.getString("conversation", "");
            // Drain both destinations independently, including when old legacy work is blocked.
            if (store.routedCount() > 0) RoutedDelivery.drain(store, config, () -> stopping);
            if (!wbot && !FeishuSender.validUrl(url)) { status("需要配置飞书 Webhook"); return; }
            try (Cursor rows = store.getReadableDatabase().rawQuery(
                    "SELECT id,text,request_id,outbound_id FROM outbox WHERE state IN ('pending','tracking') ORDER BY id LIMIT 10", null)) {
                while (!stopping && rows.moveToNext()) {
                    if (!config.getBoolean("enabled", false)) return;
                    long id = rows.getLong(0);
                    if (wbot) {
                        WbotSender.Result result = WbotSender.advance(api, conversation, rows.getString(2), rows.getString(1), rows.getString(3));
                        switch (result.phase()) {
                            case TRACKING -> { store.tracking(id, result.outboundId()); status("wbot 正在处理，待确认 " + store.count() + " 条"); }
                            case ACCEPTED -> { store.sent(id); status("微信发送路径已接受，剩余 " + store.count() + " 条"); }
                            case FAILED -> { store.state(id, "failed"); status("wbot 发送失败，请核对配置与权限"); }
                            case INDETERMINATE -> { store.state(id, "indeterminate"); status("wbot 发送结果不确定，停止该条自动重发"); }
                            case BLOCKED -> { store.state(id, "blocked"); status("wbot 权限或响应异常，暂停该条发送"); return; }
                            case RETRY -> { status("wbot 暂不可用，保留原请求稍后继续"); return; }
                        }
                        continue;
                    }
                    // Persist before the network call. A crash may have sent the SMS already.
                    store.state(id, "unknown");
                    FeishuSender.Outcome outcome = FeishuSender.send(url, rows.getString(1));
                    switch (outcome) {
                        case ACCEPTED -> { store.sent(id); status("飞书已接收，剩余 " + store.count() + " 条"); }
                        case REJECTED -> { store.state(id, "rejected"); status("飞书拒绝发送，请检查机器人设置"); return; }
                        case UNKNOWN -> { status("发送结果不确定，已暂停该条自动重发"); return; }
                    }
                    TimeUnit.SECONDS.sleep(1);
                }
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        } catch (Exception error) {
            status("读取或保存失败，请检查权限与存储；稍后再次检查");
        }
    }
}
