package vn.vnpay.tabledb.jdbc;

import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.Map;

/** Connection diagnostics at INFO/WARN, including nested transport failures, without credentials. */
final class ConnectDiagnostics {
    private ConnectDiagnostics() {}

    static Map<String, Object> fields(Profile p, String id, String stage, long started) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("connection_id", id);
        m.put("driver", p.driver);
        m.put("stage", stage);
        m.put("host", p.targetHost);
        m.put("port", p.targetPort);
        m.put("ssl", p.ssl);
        m.put("auth_type", p.authType);
        m.put("route", p.ssh != null ? "ssh" : p.proxy != null ? "proxy" : "direct");
        if (p.proxy != null) {
            m.put("proxy", p.proxy.toString());
            m.put("proxy_auth_configured", p.proxy.hasCredentials());
        }
        if (p.ssh != null) m.put("ssh_hops", p.ssh.hops().stream().map(h -> h.host() + ":" + h.port()).toList());
        m.put("connect_timeout_seconds", p.connectTimeoutSec);
        m.put("elapsed_ms", (System.nanoTime() - started) / 1_000_000L);
        return m;
    }

    static void event(String event, Profile p, String id, String stage, long started) {
        Log.info(event + " " + Json.write(fields(p, id, stage, started)));
    }

    static void failure(Profile p, String id, String stage, long started, Throwable error, Tunnel tunnel) {
        Map<String, Object> m = fields(p, id, stage, started);
        m.put("causes", causes(error, p.secrets()));
        if (tunnel != null && tunnel.lastError() != null) m.put("tunnel_error", Redactor.scrub(tunnel.lastError(), p.secrets()));
        Log.warn("db.connect failed " + Json.write(m));
    }

    static java.util.List<Map<String, Object>> causes(Throwable error, String... secrets) {
        var out = new ArrayList<Map<String, Object>>();
        var seen = Collections.newSetFromMap(new IdentityHashMap<Throwable, Boolean>());
        var pending = new java.util.ArrayDeque<Throwable>();
        pending.add(error);
        while (!pending.isEmpty() && out.size() < 8) {
            Throwable e = pending.removeFirst();
            if (!seen.add(e)) continue;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("type", e.getClass().getName());
            String message = Redactor.scrub(e.getMessage(), secrets);
            if (message != null) m.put("message", message.length() > 400 ? message.substring(0, 400) : message);
            if (e instanceof SQLException sql) {
                m.put("sql_state", sql.getSQLState());
                m.put("vendor_code", sql.getErrorCode());
                if (sql.getNextException() != null) pending.add(sql.getNextException());
            }
            if (e.getCause() != null) pending.add(e.getCause());
            out.add(m);
        }
        return out;
    }
}
