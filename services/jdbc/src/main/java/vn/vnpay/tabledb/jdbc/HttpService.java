package vn.vnpay.tabledb.jdbc;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

/** POST /rpc and GET /events (long-poll) behind a constant-time Bearer token check. */
public final class HttpService implements AutoCloseable {
    public static final int MAX_BODY = StdioServer.MAX_LINE;
    private final HttpServer server;
    private final Dispatcher dispatcher;
    private final byte[] tokenDigest;

    public HttpService(Dispatcher dispatcher, String token, String bind, int port, javax.net.ssl.SSLContext tls) throws IOException {
        if (token == null || token.isEmpty()) throw new IllegalArgumentException("service token is required");
        this.dispatcher = dispatcher;
        this.tokenDigest = digest(token);
        InetSocketAddress addr = new InetSocketAddress(bind, port);
        if (tls != null) {
            HttpsServer s = HttpsServer.create(addr, 64);
            s.setHttpsConfigurator(new HttpsConfigurator(tls));
            server = s;
        } else {
            server = HttpServer.create(addr, 64);
        }
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/rpc", guarded(this::rpc));
        server.createContext("/events", guarded(this::events));
        server.createContext("/", ex -> send(ex, 404, errorBody(RpcError.notFound("no such endpoint"))));
    }

    public void start() { server.start(); }
    public int port() { return server.getAddress().getPort(); }

    @Override public void close() {
        server.stop(0);
        dispatcher.close();
    }

    private static byte[] digest(String s) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Constant-time comparison: both sides are hashed to equal length first, then compared with isEqual. */
    boolean authorized(String header) {
        if (header == null) return false;
        String h = header.strip();
        if (h.length() < 7 || !h.regionMatches(true, 0, "Bearer ", 0, 7)) return false;
        return MessageDigest.isEqual(digest(h.substring(7).strip()), tokenDigest);
    }

    private HttpHandler guarded(HttpHandler inner) {
        return ex -> {
            try {
                if (!authorized(ex.getRequestHeaders().getFirst("Authorization"))) {
                    ex.getResponseHeaders().set("WWW-Authenticate", "Bearer");
                    send(ex, 401, "{\"error\":{\"code\":\"E_AUTH_FAILED\",\"message\":\"missing or invalid bearer token\",\"vendorCode\":0,\"retryable\":false}}");
                    return;
                }
                inner.handle(ex);
            } catch (RuntimeException e) {
                Log.warn("http handler error: " + e.getClass().getName());
                send(ex, 500, errorBody(RpcError.internal("internal error")));
            } finally {
                ex.close();
            }
        };
    }

    private void rpc(HttpExchange ex) throws IOException {
        if (!ex.getRequestMethod().equals("POST")) { send(ex, 405, errorBody(RpcError.badRequest("POST required"))); return; }
        byte[] body = readLimited(ex.getRequestBody(), MAX_BODY);
        if (body == null) { send(ex, 413, errorBody(RpcError.badRequest("request body exceeds 8 MiB"))); return; }
        Map<String, Object> resp = dispatcher.handleRaw(new String(body, StandardCharsets.UTF_8));
        String json = Json.write(resp);
        if (json.length() >= MAX_BODY) json = errorBody(RpcError.limit("response exceeds 8 MiB; reduce pageSize"));
        send(ex, 200, json);
    }

    private void events(HttpExchange ex) throws IOException {
        if (!ex.getRequestMethod().equals("GET")) { send(ex, 405, errorBody(RpcError.badRequest("GET required"))); return; }
        Map<String, String> q = query(ex.getRequestURI().getRawQuery());
        long after;
        long wait;
        try {
            after = Long.parseLong(q.getOrDefault("after", "0"));
            wait = Math.min(60, Math.max(0, Long.parseLong(q.getOrDefault("wait", "25"))));
        } catch (NumberFormatException e) {
            send(ex, 400, errorBody(RpcError.badRequest("after/wait must be integers")));
            return;
        }
        List<Map<String, Object>> evs;
        try {
            evs = dispatcher.events().after(after, wait * 1000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            evs = List.of();
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("events", evs);
        send(ex, 200, Json.write(out));
    }

    private static Map<String, String> query(String raw) {
        Map<String, String> m = new LinkedHashMap<>();
        if (raw == null) return m;
        for (String kv : raw.split("&")) {
            int i = kv.indexOf('=');
            if (i > 0) m.put(java.net.URLDecoder.decode(kv.substring(0, i), StandardCharsets.UTF_8),
                    java.net.URLDecoder.decode(kv.substring(i + 1), StandardCharsets.UTF_8));
        }
        return m;
    }

    private static byte[] readLimited(InputStream in, int max) throws IOException {
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            if (bo.size() + n > max) return null;
            bo.write(buf, 0, n);
        }
        return bo.toByteArray();
    }

    private static String errorBody(RpcError e) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", null);
        m.put("error", e.toJson());
        return Json.write(m);
    }

    private static void send(HttpExchange ex, int status, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        ex.sendResponseHeaders(status, b.length);
        try (OutputStream o = ex.getResponseBody()) { o.write(b); }
    }
}
