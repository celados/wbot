package cc.celados.sms;

import java.util.List;

/** Subscription IDs belong to source records, not the default SMS SIM or slot number. */
final class Routing {
    record Destination(String kind, String target) { }
    record Plan(String label, List<Destination> destinations) { }
    static Plan plan(int subId, int cmcc, int air, String direct, String group) {
        if (cmcc < 0 || air < 0 || cmcc == air || direct.isBlank() || group.isBlank())
            throw new IllegalArgumentException("Invalid routing configuration");
        if (subId == cmcc) return new Plan("CMCC", List.of(new Destination("wbot", direct)));
        if (subId == air) return new Plan("AIR MOBILE", List.of(new Destination("wbot", group), new Destination("slack", "sms-channel")));
        return new Plan("未识别 SIM", List.of(new Destination("held", "")));
    }
}
