package cc.celados.sms;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.util.UUID;

/** One owner for both capture progress and unsent work. */
final class Store extends SQLiteOpenHelper {
    Store(Context context) { this(context, "forwarder.db"); }
    Store(Context context, String name) { super(context, name, null, 3); }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE progress (id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE outbox (id INTEGER PRIMARY KEY, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', request_id TEXT NOT NULL, outbound_id TEXT)");
        createDeliveries(db);
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion == 1) {
            db.execSQL("ALTER TABLE outbox ADD COLUMN request_id TEXT");
            db.execSQL("ALTER TABLE outbox ADD COLUMN outbound_id TEXT");
            try (Cursor rows = db.rawQuery("SELECT id FROM outbox", null)) {
                while (rows.moveToNext()) db.execSQL("UPDATE outbox SET request_id=? WHERE id=?",
                    new Object[]{"sms:" + UUID.randomUUID(), rows.getLong(0)});
            }
        }
        if (oldVersion <= 2) createDeliveries(db);
    }
    private void createDeliveries(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, sub_id INTEGER NOT NULL, destination TEXT NOT NULL, target TEXT NOT NULL, text TEXT NOT NULL, request_id TEXT NOT NULL, outbound_id TEXT, state TEXT NOT NULL DEFAULT 'pending', retry_at INTEGER NOT NULL DEFAULT 0, UNIQUE(source_id,destination))");
    }
    void captureRouted(long sourceId, int subId, String text, Routing.Plan plan) {
        var db = getWritableDatabase(); db.beginTransaction();
        try {
            for (var destination : plan.destinations()) {
                ContentValues values = new ContentValues();
                values.put("source_id", sourceId); values.put("sub_id", subId);
                values.put("destination", destination.kind()); values.put("target", destination.target());
                values.put("text", text); values.put("request_id", "sms:" + UUID.randomUUID());
                values.put("state", destination.kind().equals("held") ? "blocked" : "pending");
                db.insertOrThrow("deliveries", null, values);
            }
            db.execSQL("UPDATE progress SET cursor=? WHERE id=1", new Object[]{sourceId});
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    long routedCount() {
        try (var row = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM deliveries", null)) {
            row.moveToFirst(); return row.getLong(0);
        }
    }
    void deliveryState(long id, String state, String outboundId, long retryAt) {
        getWritableDatabase().execSQL("UPDATE deliveries SET state=?,outbound_id=?,retry_at=? WHERE id=?", new Object[]{state,outboundId,retryAt,id});
    }
    void deliverySent(long id) { getWritableDatabase().delete("deliveries", "id=?", new String[]{Long.toString(id)}); }
    long cursor() {
        try (Cursor row = getReadableDatabase().rawQuery("SELECT cursor FROM progress WHERE id=1", null)) {
            return row.moveToFirst() ? row.getLong(0) : -1;
        }
    }
    void initialize(long value) {
        getWritableDatabase().execSQL("INSERT OR IGNORE INTO progress VALUES(1, ?)", new Object[]{value});
    }
    void capture(long id, String text) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            ContentValues values = new ContentValues();
            values.put("id", id); values.put("text", text);
            values.put("request_id", "sms:" + UUID.randomUUID());
            db.insertOrThrow("outbox", null, values);
            db.execSQL("UPDATE progress SET cursor=? WHERE id=1", new Object[]{id});
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    void state(long id, String state) {
        getWritableDatabase().execSQL("UPDATE outbox SET state=? WHERE id=?", new Object[]{state, id});
    }
    void sent(long id) {
        getWritableDatabase().delete("outbox", "id=?", new String[]{Long.toString(id)});
    }
    void tracking(long id, String outboundId) {
        getWritableDatabase().execSQL("UPDATE outbox SET state='tracking',outbound_id=? WHERE id=?", new Object[]{outboundId, id});
    }
    long count() {
        try (Cursor row = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM outbox", null)) {
            row.moveToFirst(); return row.getLong(0) + routedCount();
        }
    }
}
