package vn.vnpay.tabledb.jdbc;

import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Session/cursor registry with limits and an idle reaper. */
public final class SessionManager implements AutoCloseable {
    private final Config cfg;
    private final Map<String, Session> sessions = new ConcurrentHashMap<>();
    private final Map<String, Cursor> cursors = new ConcurrentHashMap<>();
    private final AtomicInteger pending = new AtomicInteger();
    private final SecureRandom rnd = new SecureRandom();
    private final ScheduledExecutorService reaper;

    public SessionManager(Config cfg) {
        this.cfg = cfg;
        this.reaper = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "tabledb-reaper");
            t.setDaemon(true);
            return t;
        });
        reaper.scheduleWithFixedDelay(this::reapSafe, cfg.reapIntervalSec(), cfg.reapIntervalSec(), TimeUnit.SECONDS);
    }

    public Config config() { return cfg; }

    public String newId(String prefix) {
        byte[] b = new byte[12];
        rnd.nextBytes(b);
        return prefix + HexFormat.of().formatHex(b);
    }

    /** Reserve a slot before connecting; must be paired with register() or release(). */
    public void reserve() {
        if (sessions.size() + pending.incrementAndGet() > cfg.maxSessions()) {
            pending.decrementAndGet();
            throw RpcError.limit("maximum number of sessions reached");
        }
    }

    public void release() { pending.decrementAndGet(); }

    public void register(Session s) {
        sessions.put(s.id, s);
        pending.decrementAndGet();
    }

    public Session get(String id) {
        Session s = id == null ? null : sessions.get(id);
        if (s == null) throw RpcError.notFound("unknown session");
        return s;
    }

    public boolean close(String id) {
        Session s = sessions.remove(id);
        if (s == null) return false;
        s.lock.lock();
        try {
            for (String cid : s.cursors.keySet()) cursors.remove(cid);
            s.close();
        } finally { s.lock.unlock(); }
        return true;
    }

    /** Close every session (the WebView reloaded: sessions it had opened are orphaned). Returns how many were closed. */
    public int closeAll() {
        int n = 0;
        for (String id : sessions.keySet().toArray(new String[0])) if (close(id)) n++;
        return n;
    }

    public void checkCursorLimit(Session s) {
        if (s.cursors.size() >= cfg.maxCursorsPerSession() || cursors.size() >= cfg.maxCursorsTotal())
            throw RpcError.limit("maximum number of open cursors reached");
    }

    public void registerCursor(Cursor c) {
        c.session.cursors.put(c.id, c);
        cursors.put(c.id, c);
    }

    public Cursor cursor(String id) {
        Cursor c = id == null ? null : cursors.get(id);
        if (c == null || c.isClosed()) throw RpcError.notFound("unknown cursor");
        return c;
    }

    public void dropCursor(String id) { cursors.remove(id); }

    public int sessionCount() { return sessions.size(); }

    private void reapSafe() {
        try { reapOnce(System.nanoTime()); } catch (RuntimeException e) { Log.warn("reaper error: " + e.getClass().getSimpleName()); }
    }

    /** Visible for tests. */
    public void reapOnce(long nowNanos) {
        long idle = TimeUnit.SECONDS.toNanos(cfg.idleTimeoutSec());
        long cidle = TimeUnit.SECONDS.toNanos(cfg.cursorIdleSec());
        for (Session s : sessions.values()) {
            if (!s.lock.tryLock()) continue;
            try {
                if (s.active.get() == 0 && nowNanos - s.lastUsed > idle) {
                    Log.info("closing idle session");
                    close(s.id);
                    continue;
                }
                for (Cursor c : s.cursors.values()) {
                    if (nowNanos - c.lastUsed > cidle) { c.close(); cursors.remove(c.id); }
                }
            } finally { s.lock.unlock(); }
        }
        cursors.values().removeIf(Cursor::isClosed);
    }

    @Override public void close() {
        reaper.shutdownNow();
        closeAll();
    }
}
