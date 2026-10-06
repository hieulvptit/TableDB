package vn.vnpay.tabledb.jdbc;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantLock;

/** One JDBC Connection per session. Access is serialized by {@link #lock}; cancel deliberately bypasses it. */
public final class Session {
    /** Session bound to the thread currently executing a request (used to attribute driver callbacks such as SSO redirects). */
    public static final ThreadLocal<String> CURRENT = new ThreadLocal<>();

    public final String id;
    public final Profile profile;
    public final Vendor vendor;
    public final Connection conn;
    public final String serverVersion;
    public final String user;
    /** SSH/proxy relay this session's connection goes through, or null (closed with the session) */
    public final Tunnel tunnel;
    public final ReentrantLock lock = new ReentrantLock();
    public final AtomicInteger active = new AtomicInteger();
    public final Map<String, Cursor> cursors = new ConcurrentHashMap<>();
    public volatile boolean closed;
    public volatile long lastUsed = System.nanoTime();
    /** false = manual-commit mode (tx.setAutoCommit); guarded by {@link #lock} */
    public boolean autoCommit = true;
    /** manual-commit mode: a write/DDL/other statement ran since the last commit or rollback */
    public boolean dirty;
    /** manual-commit mode: the connection was switched to read-write for the open transaction */
    public boolean txWritable;

    public Session(String id, Profile profile, Vendor vendor, Connection conn, String serverVersion, String user) {
        this(id, profile, vendor, conn, serverVersion, user, null);
    }

    public Session(String id, Profile profile, Vendor vendor, Connection conn, String serverVersion, String user, Tunnel tunnel) {
        this.id = id;
        this.tunnel = tunnel;
        this.profile = profile;
        this.vendor = vendor;
        this.conn = conn;
        this.serverVersion = serverVersion;
        this.user = user;
    }

    public void touch() { lastUsed = System.nanoTime(); }

    /** Session is read-only by default; a write statement flips it only for the statement's duration. */
    public boolean effectiveReadOnly() { return profile.readOnly || !profile.allowWrite; }

    public void close() {
        if (closed) return;
        closed = true;
        for (Cursor c : cursors.values()) c.close();
        cursors.clear();
        // an uncommitted manual transaction is rolled back, never committed implicitly (Oracle commits on close)
        if (!autoCommit) try { conn.rollback(); } catch (SQLException | RuntimeException e) { Log.debug("rollback on close failed: " + e.getClass().getSimpleName()); }
        try { conn.close(); } catch (SQLException | RuntimeException e) { Log.debug("connection close failed: " + e.getClass().getSimpleName()); }
        if (tunnel != null) tunnel.close();
    }
}
