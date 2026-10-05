package vn.vnpay.tabledb.jdbc;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Phaser;
import java.util.concurrent.TimeUnit;

/** NDJSON over stdin/stdout. stdout carries protocol messages only. Requests run concurrently (cancel must overtake execute). */
public final class StdioServer {
    public static final int MAX_LINE = 8 * 1024 * 1024;

    private final Dispatcher dispatcher;
    private final InputStream in;
    private final OutputStream out;
    private final Object writeLock = new Object();
    private final ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
    private final Phaser inflight = new Phaser(1);

    public StdioServer(Dispatcher dispatcher, InputStream in, OutputStream out) {
        this.dispatcher = dispatcher;
        this.in = in;
        this.out = out;
    }

    private void write(Map<String, Object> msg) {
        String line = Json.write(msg);
        byte[] b = line.getBytes(StandardCharsets.UTF_8);
        if (b.length >= MAX_LINE) {
            Object id = msg.get("id");
            b = Json.write(errorMsg(id, RpcError.limit("response exceeds 8 MiB line limit; reduce pageSize"))).getBytes(StandardCharsets.UTF_8);
        }
        synchronized (writeLock) {
            try {
                out.write(b);
                out.write('\n');
                out.flush();
            } catch (IOException e) {
                Log.warn("stdout write failed: " + e.getClass().getSimpleName());
            }
        }
    }

    private static Map<String, Object> errorMsg(Object id, RpcError e) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("id", id);
        m.put("error", e.toJson());
        return m;
    }

    /** Blocks until stdin reaches EOF; then drains in-flight requests and closes all sessions. */
    public void run() throws IOException {
        dispatcher.events().addListener(this::write);
        write(dispatcher.readyEvent());
        ByteArrayOutputStream buf = new ByteArrayOutputStream(4096);
        boolean overflow = false;
        int b;
        java.io.BufferedInputStream bin = new java.io.BufferedInputStream(in, 64 * 1024);
        while (true) {
            b = bin.read();
            if (b < 0) {
                if (buf.size() > 0 && !overflow) submit(buf.toString(StandardCharsets.UTF_8));
                break;
            }
            if (b == '\n') {
                if (overflow) {
                    write(errorMsg(null, RpcError.badRequest("request line exceeds 8 MiB")));
                } else if (buf.size() > 0) {
                    submit(buf.toString(StandardCharsets.UTF_8));
                }
                buf.reset();
                overflow = false;
                continue;
            }
            if (overflow) continue;
            if (buf.size() >= MAX_LINE) { overflow = true; buf.reset(); continue; }
            buf.write(b);
        }
        inflight.arriveAndDeregister();
        try {
            inflight.awaitAdvanceInterruptibly(inflight.getPhase(), 15, TimeUnit.SECONDS);
        } catch (InterruptedException | java.util.concurrent.TimeoutException ignored) { }
        pool.shutdownNow();
        dispatcher.close();
    }

    private void submit(String line) {
        if (line.isBlank()) return;
        inflight.register();
        pool.execute(() -> {
            try {
                write(dispatcher.handleRaw(line));
            } finally {
                inflight.arriveAndDeregister();
            }
        });
    }
}
