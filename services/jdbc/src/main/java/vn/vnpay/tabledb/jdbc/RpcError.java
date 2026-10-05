package vn.vnpay.tabledb.jdbc;

import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import java.util.LinkedHashMap;
import java.util.Map;

/** Protocol error with a stable code. Messages must never contain secrets. */
public final class RpcError extends RuntimeException {
    public final String code;
    public final String sqlState;
    public final int vendorCode;
    public final boolean retryable;
    /** optional structured, non-secret data for the client (e.g. SSH host key to confirm) */
    public final Map<String, Object> details;

    public RpcError(String code, String message) { this(code, message, null, 0, false); }

    public RpcError(String code, String message, boolean retryable, Map<String, Object> details) {
        super(message, null, false, false);
        this.code = code;
        this.sqlState = null;
        this.vendorCode = 0;
        this.retryable = retryable;
        this.details = details;
    }

    public RpcError(String code, String message, String sqlState, int vendorCode, boolean retryable) {
        super(message, null, false, false);
        this.code = code;
        this.sqlState = sqlState;
        this.vendorCode = vendorCode;
        this.retryable = retryable;
        this.details = null;
    }

    public static RpcError badRequest(String m) { return new RpcError("E_BAD_REQUEST", m); }
    public static RpcError notFound(String m) { return new RpcError("E_NOT_FOUND", m); }
    public static RpcError policy(String m) { return new RpcError("E_POLICY", m); }
    public static RpcError limit(String m) { return new RpcError("E_LIMIT", m); }
    public static RpcError internal(String m) { return new RpcError("E_INTERNAL", m); }

    /** Map a JDBC exception to a protocol error; {@code secrets} are scrubbed from the message. */
    public static RpcError fromSql(SQLException e, String... secrets) {
        String state = e.getSQLState();
        int vc = e.getErrorCode();
        String msg = Redactor.scrub(rootMessage(e), secrets);
        if (e instanceof SQLTimeoutException) return new RpcError("E_TIMEOUT", msg, state, vc, true);
        if (state != null) {
            if (state.startsWith("28")) return new RpcError("E_AUTH_FAILED", msg, state, vc, false);
            if (state.startsWith("08")) return new RpcError("E_CONN", msg, state, vc, true);
            if (state.equals("42501")) return new RpcError("E_POLICY", msg, state, vc, false);
        }
        if (vc == 1017 || vc == 28000 || vc == 28001) return new RpcError("E_AUTH_FAILED", msg, state, vc, false); // ORA-01017 etc.
        if (vc == 1031 || vc == 942 && msg.contains("insufficient")) return new RpcError("E_POLICY", msg, state, vc, false);
        if (vc == 17002 || vc == 12541 || vc == 12514 || vc == 12170) return new RpcError("E_CONN", msg, state, vc, true);
        String low = msg.toLowerCase(java.util.Locale.ROOT);
        if (low.contains("access denied") || low.contains("permission denied")) return new RpcError("E_POLICY", msg, state, vc, false);
        if (low.contains("authentication failed") || low.contains("invalid credentials") || low.contains("unauthorized"))
            return new RpcError("E_AUTH_FAILED", msg, state, vc, false);
        if (low.contains("connection refused") || low.contains("connection reset") || low.contains("unknownhost")
                || low.contains("no route to host") || low.contains("failed to connect") || low.contains("timed out"))
            return new RpcError("E_CONN", msg, state, vc, true);
        return new RpcError("E_SQL", msg, state, vc, false);
    }

    private static String rootMessage(SQLException e) {
        String m = e.getMessage();
        if (m == null || m.isBlank()) m = e.getClass().getSimpleName();
        return m.length() > 2000 ? m.substring(0, 2000) : m;
    }

    public Map<String, Object> toJson() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("code", code);
        m.put("message", getMessage());
        if (sqlState != null) m.put("sqlState", sqlState);
        m.put("vendorCode", (long) vendorCode);
        m.put("retryable", retryable);
        if (details != null) m.put("details", details);
        return m;
    }
}
