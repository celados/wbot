package cc.celados.sms;

import android.content.Context;

final class RoutingCheck {
    static void run(Context context) {
        var cmcc = Routing.plan(2, 2, 5, "direct", "group");
        var air = Routing.plan(5, 2, 5, "direct", "group");
        require(cmcc.destinations().size() == 1 && cmcc.destinations().get(0).target().equals("direct"), "CMCC only direct");
        require(air.destinations().size() == 2 && air.destinations().get(0).target().equals("group") && air.destinations().get(1).kind().equals("slack"), "AIR fans out");
        require(Routing.plan(-1, 2, 5, "direct", "group").destinations().get(0).kind().equals("held"), "unknown never routed");
        require(Routing.plan(7, 2, 5, "direct", "group").destinations().get(0).kind().equals("held"), "replacement subscription never guesses");
        try { Routing.plan(2, 2, 2, "direct", "group"); throw new AssertionError("ambiguous config accepted"); }
        catch (IllegalArgumentException expected) { }
        require(SlackSender.validUrl("https://hooks.slack.com/services/T123/B123/abc123"), "valid webhook");
        for (String url : new String[]{"http://hooks.slack.com/services/T/B/x", "https://hooks.slack.com.evil.test/services/T/B/x", "https://user@hooks.slack.com/services/T/B/x", "https://hooks.slack.com/services/T/B/x?foo=bar", "https://hooks.slack.com/services/T/B/%78"})
            require(!SlackSender.validUrl(url), "reject URL redirect/credential ambiguity");
        require(SlackSender.classify(200,"ok",null).outcome() == SlackSender.Outcome.ACCEPTED, "Slack acknowledged");
        require(SlackSender.classify(200,"unexpected",null).outcome() == SlackSender.Outcome.UNKNOWN, "malformed response uncertain");
        require(SlackSender.classify(503,"error",null).outcome() == SlackSender.Outcome.UNKNOWN, "5xx not blindly retried");
        require(SlackSender.classify(403,"denied",null).outcome() == SlackSender.Outcome.REJECTED, "permanent rejection");
        require(SlackSender.classify(429,"", "120").retryAfterMs() == 120000, "Retry-After honored");
        String name = "routing-check-" + System.nanoTime();
        try {
            // Simulate the real v2 upgrade, preserving pending and uncertain work verbatim.
            try (var db = context.openOrCreateDatabase(name, Context.MODE_PRIVATE, null)) {
                db.execSQL("CREATE TABLE progress (id INTEGER PRIMARY KEY,cursor INTEGER NOT NULL)");
                db.execSQL("CREATE TABLE outbox (id INTEGER PRIMARY KEY,text TEXT NOT NULL,state TEXT NOT NULL,request_id TEXT NOT NULL,outbound_id TEXT)");
                db.execSQL("INSERT INTO progress VALUES(1,100)");
                db.execSQL("INSERT INTO outbox VALUES(99,'synthetic legacy','unknown','legacy-id',NULL)");
                db.setVersion(2);
            }
            try (var store = new Store(context, name)) {
                require(store.count()==1 && store.routedCount()==0 && store.cursor()==100, "v2 migration preserves progress and work");
                store.captureRouted(101,5,"synthetic air",air);
                require(store.cursor()==101 && store.routedCount()==2, "both jobs and cursor committed");
                try { store.captureRouted(101,5,"duplicate",air); throw new AssertionError("duplicate accepted"); }
                catch (android.database.sqlite.SQLiteConstraintException expected) { }
                require(store.routedCount()==2, "duplicate atomically rejected");
                store.getWritableDatabase().execSQL("CREATE TRIGGER fail_progress BEFORE UPDATE ON progress BEGIN SELECT RAISE(ABORT, 'injected'); END");
                try { store.captureRouted(102,5,"rollback",air); throw new AssertionError("failure ignored"); }
                catch (android.database.sqlite.SQLiteConstraintException expected) { }
                require(store.cursor()==101 && store.routedCount()==2, "cursor failure rolls back fanout");
                store.getWritableDatabase().execSQL("DROP TRIGGER fail_progress");
                store.getWritableDatabase().execSQL("DELETE FROM deliveries WHERE destination='wbot'");
                store.getWritableDatabase().execSQL("UPDATE deliveries SET state='unknown' WHERE destination='slack'");
                store.captureRouted(102,-1,"unknown SIM",Routing.plan(-1,2,5,"direct","group"));
                store.captureRouted(103,2,"cmcc",cmcc);
            }
            try (var store = new Store(context,name)) {
                require(store.cursor()==103 && store.count()==4, "restart retains independent outcomes and old queue");
                try (var row=store.getReadableDatabase().rawQuery("SELECT COUNT(*) FROM deliveries WHERE source_id=101 AND state='unknown' AND destination='slack'",null)) {
                    require(row.moveToFirst() && row.getInt(0)==1, "Slack crash retains unknown without recreating successful WeChat");
                }
                try (var row=store.getReadableDatabase().rawQuery("SELECT state,request_id FROM outbox WHERE id=99",null)) {
                    require(row.moveToFirst() && row.getString(0).equals("unknown") && row.getString(1).equals("legacy-id"), "legacy identity unchanged");
                }
            }
        } finally { context.deleteDatabase(name); }
    }
    private static void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
