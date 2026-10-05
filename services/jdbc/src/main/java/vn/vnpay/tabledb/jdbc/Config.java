package vn.vnpay.tabledb.jdbc;

/** Runtime limits. Environment overrides: TABLEDB_MAX_SESSIONS, TABLEDB_MAX_CURSORS, TABLEDB_IDLE_SEC. */
public record Config(int maxSessions, int maxCursorsPerSession, int maxCursorsTotal, long idleTimeoutSec, long cursorIdleSec, long reapIntervalSec) {
    public static Config defaults() { return new Config(20, 10, 100, 1800, 600, 30); }

    public static Config fromEnv() {
        Config d = defaults();
        return new Config(env("TABLEDB_MAX_SESSIONS", d.maxSessions), env("TABLEDB_MAX_CURSORS", d.maxCursorsPerSession),
                d.maxCursorsTotal, env("TABLEDB_IDLE_SEC", d.idleTimeoutSec), d.cursorIdleSec, d.reapIntervalSec);
    }

    private static int env(String k, int def) { return (int) env(k, (long) def); }

    private static long env(String k, long def) {
        String v = System.getenv(k);
        if (v == null || v.isBlank()) return def;
        try {
            long l = Long.parseLong(v.trim());
            return l > 0 ? l : def;
        } catch (NumberFormatException e) {
            return def;
        }
    }
}
