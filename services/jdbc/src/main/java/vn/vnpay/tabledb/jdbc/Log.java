package vn.vnpay.tabledb.jdbc;

import java.io.PrintStream;
import java.time.Instant;

/** stderr-only logger. Never pass passwords, tokens, row values or raw SQL here. */
public final class Log {
    private static final PrintStream ERR = System.err;
    private static volatile boolean debug = "debug".equalsIgnoreCase(System.getenv("TABLEDB_LOG"));

    private Log() {}

    public static void setDebug(boolean d) { debug = d; }
    public static boolean isDebug() { return debug; }

    public static void info(String m) { emit("INFO", m); }
    public static void warn(String m) { emit("WARN", m); }
    public static void debug(String m) { if (debug) emit("DEBUG", m); }

    /** DEBUG-only SQL trace: hash + first 200 chars with literals masked. */
    public static void debugSql(String label, String sql) {
        if (debug) emit("DEBUG", label + " sha256=" + Redactor.sha256Hex(sql).substring(0, 16) + " sql=" + Redactor.maskSql(sql));
    }

    private static synchronized void emit(String level, String m) {
        ERR.println(Instant.now() + " " + level + " " + Redactor.scrub(m).replace('\n', ' ').replace('\r', ' '));
        ERR.flush();
    }
}
