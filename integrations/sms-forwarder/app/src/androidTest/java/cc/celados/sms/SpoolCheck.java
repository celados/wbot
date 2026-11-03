package cc.celados.sms;

import android.app.Instrumentation;
import android.content.Context;
import android.os.Bundle;

/** Checks crash and transaction behavior on Android SQLite using an isolated database. */
public final class SpoolCheck extends Instrumentation {
    private boolean live;
    private boolean routedLive;
    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments); live = arguments != null && "true".equals(arguments.getString("live"));
        routedLive = arguments != null && "true".equals(arguments.getString("routed_live")); start();
    }
    @Override public void onStart() {
        Bundle result = new Bundle();
        String name = "spool-check-" + System.nanoTime() + ".db";
        String migrationName = name + "-migration";
        String capturedRequestId = null;
        try {
            if (routedLive) {
                result.putString("live_result", RoutingLiveCheck.run(getTargetContext())); finish(-1, result); return;
            }
            if (live) {
                result.putString("live_result", LiveSendCheck.run(getTargetContext())); finish(-1, result); return;
            }
            WbotCheck.run();
            RoutingCheck.run(getTargetContext());
            LifecycleCheck.run(getTargetContext());
            try (var rows = getTargetContext().getContentResolver().query(android.provider.Telephony.Sms.Inbox.CONTENT_URI,
                    new String[]{"_id"}, "_id=-1", null, "_id DESC LIMIT 1")) {
                require(rows != null && rows.getCount() == 0, "phone grants provider access and supports bounded queries");
            }
            try (Store store = new Store(getTargetContext(), name)) {
                store.initialize(100);
                store.initialize(999);
                require(store.cursor() == 100, "reenabling must preserve progress");
                store.capture(101, "synthetic test");
                String requestId;
                try (var rows = store.getReadableDatabase().rawQuery("SELECT request_id FROM outbox WHERE id=101", null)) {
                    rows.moveToFirst(); requestId = rows.getString(0); require(requestId.startsWith("sms:"), "capture has a request ID");
                    capturedRequestId = requestId;
                }
                require(store.cursor() == 101 && store.count() == 1, "capture persists work and progress");
                try { store.capture(101, "duplicate"); throw new AssertionError("duplicate accepted"); }
                catch (android.database.sqlite.SQLiteConstraintException expected) { }
                require(store.cursor() == 101 && store.count() == 1, "failed capture rolls back");
                store.getWritableDatabase().execSQL("CREATE TRIGGER fail_progress BEFORE UPDATE ON progress BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
                try { store.capture(102, "must roll back"); throw new AssertionError("injected failure ignored"); }
                catch (android.database.sqlite.SQLiteConstraintException expected) { }
                require(store.cursor() == 101 && store.count() == 1, "progress failure rolls back the inserted SMS");
                store.getWritableDatabase().execSQL("DROP TRIGGER fail_progress");
                store.state(101, "unknown");
            }
            try (Store store = new Store(getTargetContext(), name)) {
                require(store.cursor() == 101 && store.count() == 1, "restart preserves retained work");
                try (var row = store.getReadableDatabase().rawQuery("SELECT request_id FROM outbox WHERE id=101", null)) {
                    require(row.moveToFirst() && row.getString(0).equals(capturedRequestId), "restart preserves exact request ID");
                }
                try (var rows = store.getReadableDatabase().rawQuery("SELECT COUNT(*) FROM outbox WHERE state='pending'", null)) {
                    rows.moveToFirst(); require(rows.getInt(0) == 0, "uncertain sends must not be retried");
                }
                store.sent(101);
                require(store.count() == 0 && store.cursor() == 101, "acceptance deletes content but retains progress");
            }
            try (Store store = new Store(getTargetContext(), name)) {
                store.capture(102, "synthetic tracking"); store.tracking(102, "send-1");
            }
            try (Store store = new Store(getTargetContext(), name)) {
                try (var rows = store.getReadableDatabase().rawQuery("SELECT request_id,outbound_id,state FROM outbox WHERE id=102", null)) {
                    require(rows.moveToFirst() && rows.getString(0).startsWith("sms:") && rows.getString(1).equals("send-1")
                        && rows.getString(2).equals("tracking"), "restart retains request identity and lookup progress");
                }
                store.sent(102);
            }
            try (var old = getTargetContext().openOrCreateDatabase(migrationName, Context.MODE_PRIVATE, null)) {
                old.execSQL("CREATE TABLE progress (id INTEGER PRIMARY KEY,cursor INTEGER NOT NULL)");
                old.execSQL("CREATE TABLE outbox (id INTEGER PRIMARY KEY,text TEXT NOT NULL,state TEXT NOT NULL)");
                old.execSQL("INSERT INTO progress VALUES(1,7)");
                old.execSQL("INSERT INTO outbox VALUES(7,'synthetic legacy SMS','unknown')");
                old.setVersion(1);
            }
            try (Store migrated = new Store(getTargetContext(), migrationName)) {
                require(migrated.cursor() == 7 && migrated.count() == 1, "migration retains progress and pending data");
                try (var row = migrated.getReadableDatabase().rawQuery("SELECT request_id,state FROM outbox WHERE id=7", null)) {
                    require(row.moveToFirst() && row.getString(0).startsWith("sms:") && row.getString(1).equals("unknown"), "migration does not retry uncertain legacy sends");
                }
            }
            result.putString("result", "PASS: capture transactions, stable requests, send tracking, migration, enabled-only boot/update recovery");
            finish(-1, result);
        } catch (Throwable error) {
            result.putString("result", "FAIL: " + error.getClass().getSimpleName() + ": " + error.getMessage());
            finish(0, result);
        } finally { getTargetContext().deleteDatabase(name); getTargetContext().deleteDatabase(migrationName); }
    }
    private static void require(boolean value, String description) {
        if (!value) throw new AssertionError(description);
    }
}
