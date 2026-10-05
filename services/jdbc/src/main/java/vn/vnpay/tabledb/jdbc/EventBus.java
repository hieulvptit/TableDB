package vn.vnpay.tabledb.jdbc;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;

/** Sequenced event log (ring buffer) + push listeners (stdio) + long-poll (http). */
public final class EventBus {
    private static final int CAPACITY = 1000;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition changed = lock.newCondition();
    private final ArrayDeque<Map<String, Object>> ring = new ArrayDeque<>();
    private final List<Consumer<Map<String, Object>>> listeners = new CopyOnWriteArrayList<>();
    private long seq = 0;

    public void addListener(Consumer<Map<String, Object>> l) { listeners.add(l); }

    public Map<String, Object> emit(String name, Map<String, Object> data) {
        Map<String, Object> ev = new LinkedHashMap<>();
        lock.lock();
        try {
            ev.put("event", name);
            ev.put("seq", ++seq);
            ev.put("data", data);
            ring.addLast(ev);
            while (ring.size() > CAPACITY) ring.removeFirst();
            changed.signalAll();
        } finally {
            lock.unlock();
        }
        for (Consumer<Map<String, Object>> l : listeners) {
            try { l.accept(ev); } catch (RuntimeException e) { Log.warn("event listener failed: " + e.getClass().getSimpleName()); }
        }
        return ev;
    }

    public long lastSeq() {
        lock.lock();
        try { return seq; } finally { lock.unlock(); }
    }

    /** Events with seq > after; waits up to waitMs when none are available yet. */
    public List<Map<String, Object>> after(long after, long waitMs) throws InterruptedException {
        long nanos = TimeUnit.MILLISECONDS.toNanos(Math.max(0, waitMs));
        lock.lock();
        try {
            while (true) {
                List<Map<String, Object>> out = new ArrayList<>();
                for (Map<String, Object> e : ring) if ((Long) e.get("seq") > after) out.add(e);
                if (!out.isEmpty() || nanos <= 0) return out;
                nanos = changed.awaitNanos(nanos);
            }
        } finally {
            lock.unlock();
        }
    }
}
