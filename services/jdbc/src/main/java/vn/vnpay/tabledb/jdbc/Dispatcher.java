package vn.vnpay.tabledb.jdbc;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLWarning;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/** Transport-independent method dispatcher: one instance serves stdio and http. */
public final class Dispatcher implements AutoCloseable {
    public static final int PROTOCOL = 1;
    static final Set<String> METHODS = Set.of("hello", "session.open", "session.test", "session.close", "session.closeAll",
            "meta.catalogs", "meta.schemas", "meta.tables", "meta.columns", "meta.ddl", "meta.fingerprint",
            "query.execute", "query.fetch", "query.cancel", "query.closeCursor", "query.plan", "diag.proxy", "drivers.reload",
            "session.setSchema", "tx.setAutoCommit", "tx.commit", "tx.rollback");
    static final Set<String> BIND_TYPES = Set.of("string", "number", "boolean", "date", "timestamp", "null");
    static final int MAX_BINDS = 200;
    static final int MAX_MESSAGES = 200;
    static final int MAX_MORE_RESULTS = 16;
    static final java.util.regex.Pattern QUERY_ID = java.util.regex.Pattern.compile("^[A-Za-z0-9_.:-]{1,128}$");
    static final java.util.regex.Pattern TYPE_NAME = java.util.regex.Pattern.compile("^[A-Za-z ]{1,32}$");

    private final DriverRegistry registry;
    private final Map<String, Vendor> vendors;
    private final GenericVendor generic;
    private final SessionManager sessions;
    private final EventBus bus;
    private final String version;
    private final SshKeys sshKeys;
    private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "tabledb-watchdog");
        t.setDaemon(true);
        return t;
    });
    private final Map<String, Running> running = new ConcurrentHashMap<>();

    private static final class Running {
        volatile Statement stmt;
        volatile boolean cancelled;
        volatile boolean timedOut;
    }

    public Dispatcher(DriverRegistry registry, Map<String, Vendor> vendors, SessionManager sessions, EventBus bus, String version) {
        this(registry, vendors, sessions, bus, version, SshKeys.none());
    }

    public Dispatcher(DriverRegistry registry, Map<String, Vendor> vendors, SessionManager sessions, EventBus bus, String version, SshKeys sshKeys) {
        this.sshKeys = sshKeys;
        this.registry = registry;
        this.vendors = vendors;
        this.generic = new GenericVendor(registry);
        this.sessions = sessions;
        this.bus = bus;
        this.version = version;
    }

    public EventBus events() { return bus; }
    public SessionManager sessions() { return sessions; }
    public DriverRegistry registry() { return registry; }

    public Map<String, Object> readyEvent() {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("protocol", (long) PROTOCOL);
        data.put("version", version);
        data.put("drivers", registry.describe());
        Map<String, Object> ev = new LinkedHashMap<>();
        ev.put("event", "ready");
        ev.put("seq", 0L);
        ev.put("data", data);
        return ev;
    }

    /** Handle a raw request line/body. Never throws; always returns a response envelope. */
    public Map<String, Object> handleRaw(String text) {
        Map<String, Object> req;
        try {
            req = Json.parseObject(text);
        } catch (RuntimeException e) {
            return error(null, RpcError.badRequest("malformed JSON request"));
        }
        return handle(req);
    }

    public Map<String, Object> handle(Map<String, Object> req) {
        Object id = req.get("id");
        if (id != null && !(id instanceof Long) && !(id instanceof String)) return error(null, RpcError.badRequest("id must be a number or string"));
        // Bound the echoed envelope before any cursor advances; an oversized error id is omitted too.
        if (id instanceof String sid && sid.length() > 256) return error(null, RpcError.badRequest("id string must be at most 256 characters"));
        try {
            if (id == null) throw RpcError.badRequest("id is required");
            Object m = req.get("method");
            if (!(m instanceof String method) || !METHODS.contains(method)) throw RpcError.badRequest("unknown method");
            Object p = req.get("params");
            if (p != null && !(p instanceof Map)) throw RpcError.badRequest("params must be an object");
            @SuppressWarnings("unchecked") Map<String, Object> pm = (Map<String, Object>) p;
            Map<String, Object> result = call(method, new Params(pm, "params"));
            Map<String, Object> resp = new LinkedHashMap<>();
            resp.put("id", id);
            resp.put("result", result);
            if (Json.write(resp).getBytes(java.nio.charset.StandardCharsets.UTF_8).length >= StdioServer.MAX_LINE) {
                Object cid = result.get("cursorId");
                if (cid instanceof String cursorId) {
                    Cursor c = sessions.cursor(cursorId);
                    c.session.lock.lock();
                    try { c.close(); sessions.dropCursor(cursorId); } finally { c.session.lock.unlock(); }
                }
                throw RpcError.limit("response exceeds 8 MiB; reduce selected columns or lobLimit");
            }
            return resp;
        } catch (RpcError e) {
            return error(id, e);
        } catch (RuntimeException | Error e) {
            Log.warn("internal error in request: " + e.getClass().getName());
            return error(id, RpcError.internal("internal error"));
        }
    }

    private static Map<String, Object> error(Object id, RpcError e) {
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("id", id);
        resp.put("error", e.toJson());
        return resp;
    }

    @FunctionalInterface
    interface SqlFn<T> { T apply(Session s) throws SQLException; }

    Map<String, Object> call(String method, Params p) {
        switch (method) {
            case "hello": {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("protocol", (long) PROTOCOL);
                m.put("version", version);
                m.put("drivers", registry.describe());
                return m;
            }
            case "drivers.reload": {
                registry.reloadCustom();
                return Map.of("drivers", registry.describe());
            }
            case "session.open": return openSession(p);
            case "session.test": return testSession(p);
            case "session.close": {
                String sid = p.reqStr("sessionId");
                if (!sessions.close(sid)) throw RpcError.notFound("unknown session");
                return Map.of();
            }
            case "session.closeAll": return Map.of("closed", (long) sessions.closeAll());
            case "session.setSchema": {
                String schema = p.reqStr("schema");
                if (schema.length() > 128 || schema.indexOf('\0') >= 0) throw RpcError.badRequest("invalid schema");
                return withSession(p, s -> {
                    s.conn.setSchema(schema);
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("schema", currentSchema(s.conn));
                    return m;
                });
            }
            case "tx.setAutoCommit": {
                Boolean on = p.bool("autoCommit");
                if (on == null) throw RpcError.badRequest("params.autoCommit is required");
                return withSession(p, s -> setAutoCommit(s, on));
            }
            case "tx.commit": return withSession(p, s -> endTx(s, true));
            case "tx.rollback": return withSession(p, s -> endTx(s, false));
            case "query.plan": return plan(p);
            case "meta.catalogs": return withSession(p, s -> Meta.catalogs(s));
            case "meta.schemas": { String c = p.str("catalog"); return withSession(p, s -> Meta.schemas(s, c)); }
            case "meta.tables": {
                String c = p.str("catalog"), sc = p.reqStr("schema");
                List<String> types = p.strList("types");
                if (types != null) for (String t : types) if (!TYPE_NAME.matcher(t).matches()) throw RpcError.badRequest("invalid table type");
                return withSession(p, s -> Meta.tables(s, c, sc, types));
            }
            case "meta.columns": {
                String c = p.str("catalog"), sc = p.reqStr("schema"), t = p.reqStr("table");
                return withSession(p, s -> Meta.columns(s, c, sc, t));
            }
            case "meta.ddl": {
                String c = p.str("catalog"), sc = p.reqStr("schema"), t = p.reqStr("table");
                return withSession(p, s -> Meta.ddl(s, c, sc, t));
            }
            case "meta.fingerprint": {
                String c = p.str("catalog"), sc = p.reqStr("schema");
                return withSession(p, s -> Meta.fingerprint(s, c, sc));
            }
            case "query.execute": return execute(p);
            case "query.fetch": return fetch(p);
            case "query.cancel": return cancel(p);
            case "query.closeCursor": {
                Cursor c = sessions.cursor(p.reqStr("cursorId"));
                Session s = c.session;
                s.lock.lock();
                try { c.close(); } finally { s.lock.unlock(); }
                sessions.dropCursor(c.id);
                return Map.of();
            }
            case "diag.proxy": return diagProxy(p);
            default: throw RpcError.badRequest("unknown method");
        }
    }

    // ------------------------------------------------------------------ sessions

    private Session connect(Profile prof, String sid) {
        Vendor v = prof.driver.equals("custom") ? generic : vendors.get(prof.driver);
        if (v == null) throw RpcError.badRequest("unsupported driver type");
        DriverShim shim = shimFor(prof);
        long t0 = System.nanoTime();
        String prev = Session.CURRENT.get();
        Session.CURRENT.set(sid);
        Connection c = null;
        Tunnel tunnel = null;
        try {
            Profile eff = prof;
            if (Tunnel.needed(prof)) {
                tunnel = Tunnel.open(prof, sshKeys);
                eff = prof.routedTo(tunnel.host, tunnel.port);
            }
            c = v.connect(shim, eff);
            c.setAutoCommit(true);
            v.afterConnect(c, eff);
            try {
                c.setReadOnly(true);
            } catch (SQLException | RuntimeException e) {
                Log.warn("setReadOnly(true) not honoured by driver: " + e.getClass().getSimpleName() + " (classifier still enforced)");
            }
            DatabaseMetaData md = c.getMetaData();
            String ver = null;
            String user = null;
            try { ver = md.getDatabaseProductVersion(); } catch (SQLException | RuntimeException e) { Log.warn("server version unavailable: " + e.getClass().getSimpleName()); }
            try { user = md.getUserName(); } catch (SQLException | RuntimeException e) { Log.warn("user name unavailable: " + e.getClass().getSimpleName()); }
            if (ver != null && ver.indexOf('\n') > 0) ver = ver.substring(0, ver.indexOf('\n'));
            return new Session(sid, eff, v, c, ver, user != null ? user : prof.username, tunnel);
        } catch (SQLException e) {
            closeQuietly(c);
            throw closeTunnel(tunnel, mapConnectError(e, prof, t0));
        } catch (RpcError e) {
            closeQuietly(c);
            throw closeTunnel(tunnel, e);
        } catch (RuntimeException e) {
            closeQuietly(c);
            throw closeTunnel(tunnel, mapConnectError(new SQLException(String.valueOf(e.getMessage())), prof, t0));
        } finally {
            if (prev == null) Session.CURRENT.remove(); else Session.CURRENT.set(prev);
        }
    }

    /** Closes the tunnel of a failed connect; a connection error caused by the route itself is reported as such. */
    private static RpcError closeTunnel(Tunnel t, RpcError e) {
        if (t == null) return e;
        String why = t.lastError();
        boolean auth = t.lastErrorIsAuth();
        t.close();
        if (why != null && (e.code.equals("E_CONN") || e.code.equals("E_TIMEOUT") || e.code.equals("E_SQL")))
            return auth ? new RpcError("E_PROXY_AUTH", why, false, null) : new RpcError("E_CONN", why, null, 0, true);
        return e;
    }

    private static void closeQuietly(Connection c) {
        if (c != null) try { c.close(); } catch (SQLException | RuntimeException ignored) { }
    }

    private static RpcError mapConnectError(SQLException e, Profile prof, long t0) {
        RpcError base = RpcError.fromSql(e, prof.secrets());
        if (prof.authType.equals("trino-external")) {
            // The Trino driver surfaces the exhausted external-auth wait as a generic failure (observed message: "delay must be <
            // the maxDuration"), so identify it by timing: a non-auth, non-policy failure after ~the whole timeout window.
            long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0);
            boolean generic = base.code.equals("E_SQL") || base.code.equals("E_CONN") || base.code.equals("E_INTERNAL") || base.code.equals("E_TIMEOUT");
            if (generic && elapsedMs >= prof.externalAuthTimeoutSec * 900L)
                return new RpcError("E_AUTH_INTERACTIVE_TIMEOUT", "interactive authentication timed out", null, 0, true);
        }
        if (base.code.equals("E_SQL") || base.code.equals("E_INTERNAL")) {
            // connect-phase failures that are not clearly auth/policy are connection errors
            return new RpcError("E_CONN", base.getMessage(), base.sqlState, base.vendorCode, true);
        }
        return base;
    }

    private Profile parseProfile(Params p) {
        Set<String> types = new java.util.HashSet<>(vendors.keySet());
        types.add("custom");
        return Profile.parse(p.obj("profile"), types, id -> {
            DriverRegistry.CustomInfo i = registry.customInfo(id);
            return i == null ? null : i.defaultPort();
        });
    }

    private DriverShim shimFor(Profile prof) {
        return prof.driver.equals("custom") ? registry.requireCustom(prof.driverId) : registry.require(prof.driver);
    }

    private Map<String, Object> openSession(Params p) {
        Profile prof = parseProfile(p);
        shimFor(prof);
        sessions.reserve();
        String sid = sessions.newId("s_");
        Session s;
        try {
            s = connect(prof, sid);
        } catch (RuntimeException e) {
            sessions.release();
            throw e;
        }
        sessions.register(s);
        Log.info("session opened driver=" + prof.driver + " readOnly=" + s.effectiveReadOnly() + " route=" + (s.tunnel == null ? (prof.proxy != null ? "proxy(native)" : "direct") : s.tunnel.describe()));
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("sessionId", sid);
        m.put("serverVersion", s.serverVersion);
        m.put("user", s.user);
        m.put("readOnly", s.effectiveReadOnly());
        m.put("schema", currentSchema(s.conn));
        m.put("autoCommit", true);
        return m;
    }

    private static String currentSchema(Connection c) {
        try { return c.getSchema(); } catch (SQLException | RuntimeException | AbstractMethodError e) { return null; }
    }

    // ------------------------------------------------------------------ transactions (manual-commit mode)

    private static Map<String, Object> txState(Session s) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("autoCommit", s.autoCommit);
        m.put("txPending", s.dirty);
        return m;
    }

    /** Leaves the read-write state a manual transaction switched to (after commit/rollback). */
    private static void restoreReadOnly(Session s) {
        if (!s.txWritable) return;
        try { s.conn.setReadOnly(true); } catch (SQLException | RuntimeException e) { Log.debug("setReadOnly(true) failed"); }
        s.txWritable = false;
    }

    private static Map<String, Object> setAutoCommit(Session s, boolean on) throws SQLException {
        if (on == s.autoCommit) return txState(s);
        if (on) {
            // JDBC commits pending work when auto-commit is switched back on: never let that happen implicitly
            if (s.dirty) throw RpcError.policy("uncommitted changes: commit or roll back first");
            try { s.conn.rollback(); } catch (SQLException | RuntimeException e) { Log.debug("rollback before auto-commit failed"); }
            s.conn.setAutoCommit(true);
            restoreReadOnly(s);
        } else {
            if (!s.profile.allowWrite) throw RpcError.policy("manual commit requires a write-enabled session");
            s.conn.setAutoCommit(false);
        }
        s.autoCommit = on;
        s.dirty = false;
        return txState(s);
    }

    private static Map<String, Object> endTx(Session s, boolean commit) throws SQLException {
        if (s.autoCommit) throw RpcError.policy("session is in auto-commit mode");
        if (commit) s.conn.commit(); else s.conn.rollback();
        s.dirty = false;
        restoreReadOnly(s);
        Log.info(commit ? "transaction committed" : "transaction rolled back");
        return txState(s);
    }

    private Map<String, Object> testSession(Params p) {
        Profile prof = parseProfile(p);
        shimFor(prof);
        long t0 = System.nanoTime();
        Session s = connect(prof, sessions.newId("t_"));
        long ms = (System.nanoTime() - t0) / 1_000_000L;
        try {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("ok", true);
            m.put("latencyMs", ms);
            m.put("serverVersion", s.serverVersion);
            m.put("user", s.user);
            return m;
        } finally {
            s.close();
        }
    }

    private Map<String, Object> withSession(Params p, SqlFn<Map<String, Object>> fn) {
        Session s = sessions.get(p.reqStr("sessionId"));
        return runOn(s, fn);
    }

    private <T> T runOn(Session s, SqlFn<T> fn) {
        s.active.incrementAndGet();
        try {
            s.lock.lock();
            try {
                if (s.closed) throw RpcError.notFound("unknown session");
                s.touch();
                Session.CURRENT.set(s.id);
                return fn.apply(s);
            } catch (SQLException e) {
                throw RpcError.fromSql(e, s.profile.secrets());
            } finally {
                Session.CURRENT.remove();
                s.touch();
                s.lock.unlock();
            }
        } finally {
            s.active.decrementAndGet();
        }
    }

    // ------------------------------------------------------------------ queries

    private Map<String, Object> execute(Params p) {
        String queryId = p.reqStr("queryId");
        if (!QUERY_ID.matcher(queryId).matches()) throw RpcError.badRequest("invalid queryId");
        String sql = p.reqStr("sql");
        if (sql.length() > 1_000_000) throw RpcError.badRequest("sql too long");
        String mode = p.reqStr("mode");
        if (!mode.equals("read") && !mode.equals("write")) throw RpcError.badRequest("mode must be read or write");
        boolean confirm = p.bool("confirmWrite", false);
        int maxRows = p.intCapped("maxRows", 1000, 1, 100_000);
        int timeoutSec = p.intCapped("timeoutSec", 60, 1, 600);
        int pageSize = p.intCapped("pageSize", 500, 1, 5000);
        boolean serverOutput = p.bool("serverOutput", false);
        ValueEncoder.Limits limits = ValueEncoder.Limits.of(p.intIn("lobLimit", 0, 0, ValueEncoder.MAX_LOB_LIMIT));
        List<Bind> binds = parseBinds(p);
        Session s = sessions.get(p.reqStr("sessionId"));

        SqlClassifier.Result cls = SqlClassifier.classify(sql);
        if (cls.malformed()) throw RpcError.badRequest("unterminated string, comment or quoted identifier");
        if (cls.statements() == 0) throw RpcError.badRequest("empty statement");
        if (cls.multi()) throw RpcError.badRequest("multiple statements are not allowed");
        boolean write = mode.equals("write");
        if (!write) {
            if (cls.kind() != SqlClassifier.Kind.READ) throw new RpcError("E_READONLY_VIOLATION", "statement is not read-only (" + cls.kindName() + ")");
        } else {
            if (!s.profile.allowWrite) throw RpcError.policy("write mode is not enabled for this session");
            if (!confirm) throw RpcError.policy("write requires confirmWrite=true");
        }

        Running rq = new Running();
        if (running.putIfAbsent(queryId, rq) != null) throw RpcError.badRequest("queryId already in use");
        Log.debugSql("execute mode=" + mode, sql);
        long t0 = System.nanoTime();
        try {
            Exec x = new Exec(cls, write, rq, queryId, maxRows, timeoutSec, pageSize, t0, binds, serverOutput, limits);
            return runOn(s, sess -> doExecute(sess, x));
        } finally {
            running.remove(queryId);
        }
    }

    record Bind(String type, String value) {}

    /** One query.execute request, validated. */
    private record Exec(SqlClassifier.Result cls, boolean write, Running rq, String queryId, int maxRows, int timeoutSec, int pageSize,
                        long t0, List<Bind> binds, boolean serverOutput, ValueEncoder.Limits limits) {}

    /** Positional bind values for `?` placeholders: [{type, value}], values are strings (never logged). */
    static List<Bind> parseBinds(Params p) {
        List<Params> raw = p.objList("params");
        if (raw == null || raw.isEmpty()) return List.of();
        if (raw.size() > MAX_BINDS) throw RpcError.badRequest("too many bind parameters (max " + MAX_BINDS + ")");
        List<Bind> out = new ArrayList<>();
        long total = 0;
        for (Params b : raw) {
            b.only(Set.of("type", "value"));
            String type = b.reqStr("type");
            if (!BIND_TYPES.contains(type)) throw RpcError.badRequest("invalid bind parameter type");
            String v = b.str("value");
            if (!type.equals("null") && v == null) throw RpcError.badRequest("bind parameter value is required");
            if (v != null && v.indexOf('\0') >= 0) throw RpcError.badRequest("bind parameter contains NUL");
            total += v == null ? 0 : v.length();
            if (total > 1_000_000) throw RpcError.badRequest("bind parameters too long");
            out.add(new Bind(type, v));
        }
        return out;
    }

    static void bind(PreparedStatement ps, List<Bind> binds) throws SQLException {
        for (int i = 0; i < binds.size(); i++) {
            Bind b = binds.get(i);
            int idx = i + 1;
            String v = b.value() == null ? null : b.value().trim();
            try {
                switch (b.type()) {
                    case "null" -> ps.setNull(idx, Types.VARCHAR);
                    case "number" -> ps.setBigDecimal(idx, new BigDecimal(v));
                    case "boolean" -> {
                        if (!v.equalsIgnoreCase("true") && !v.equalsIgnoreCase("false")) throw new IllegalArgumentException();
                        ps.setBoolean(idx, Boolean.parseBoolean(v));
                    }
                    case "date" -> ps.setDate(idx, java.sql.Date.valueOf(java.time.LocalDate.parse(v)));
                    case "timestamp" -> ps.setTimestamp(idx, java.sql.Timestamp.valueOf(java.time.LocalDateTime.parse(v.replace(' ', 'T'))));
                    default -> ps.setString(idx, b.value());
                }
            } catch (IllegalArgumentException | java.time.DateTimeException e) {
                throw RpcError.badRequest("bind parameter " + idx + " is not a valid " + b.type());
            }
        }
    }

    /** SQLWarning chain (PostgreSQL RAISE NOTICE, Oracle warnings, ...) as text lines, bounded. */
    static List<String> warnings(SQLWarning w) {
        List<String> out = new ArrayList<>();
        for (int n = 0; w != null && n < MAX_MESSAGES; n++, w = w.getNextWarning()) {
            String m = w.getMessage();
            if (m != null) out.add(m.length() > 2000 ? m.substring(0, 2000) + "…" : m);
        }
        return out;
    }

    private Map<String, Object> doExecute(Session s, Exec x) throws SQLException {
        SqlClassifier.Result cls = x.cls();
        boolean write = x.write();
        Running rq = x.rq();
        int timeoutSec = x.timeoutSec(), pageSize = x.pageSize(), maxRows = x.maxRows();
        sessions.checkCursorLimit(s);
        boolean flipped = false;
        Statement st = null;
        Cursor cursor = null;
        boolean handedOff = false;
        ScheduledFuture<?> timer = null;
        try {
            if (write) {
                if (s.autoCommit) {
                    try { s.conn.setReadOnly(false); flipped = true; } catch (SQLException | RuntimeException e) { Log.debug("setReadOnly(false) failed"); }
                } else if (!s.txWritable) {
                    // manual commit: the transaction stays read-write until commit/rollback. A transaction holding only reads
                    // (possibly started READ ONLY) is ended first so the flag can change.
                    if (!s.dirty) try { s.conn.rollback(); } catch (SQLException | RuntimeException e) { Log.debug("rollback of read transaction failed"); }
                    try { s.conn.setReadOnly(false); } catch (SQLException | RuntimeException e) { Log.debug("setReadOnly(false) failed"); }
                    s.txWritable = true;
                }
            }
            PreparedStatement ps = null;
            if (x.binds().isEmpty()) st = s.conn.createStatement();
            else st = ps = s.conn.prepareStatement(cls.executableSql());
            rq.stmt = st;
            if (rq.cancelled) throw new RpcError("E_CANCELLED", "query cancelled");
            try { st.setFetchSize(pageSize); } catch (SQLException | RuntimeException ignored) { }
            try { st.setMaxRows(maxRows + 1); } catch (SQLException | RuntimeException ignored) { }
            try { st.setQueryTimeout(timeoutSec); } catch (SQLException | RuntimeException ignored) { }
            final Statement fst = st;
            timer = watchdog.schedule(() -> {
                rq.timedOut = true;
                try { fst.cancel(); } catch (SQLException | RuntimeException ignored) { }
            }, timeoutSec, TimeUnit.SECONDS);
            if (x.serverOutput()) s.vendor.enableServerOutput(s.conn);
            if (write && !s.autoCommit) s.dirty = true; // partial effects are possible even when the statement fails

            boolean hasRs;
            if (ps != null) { bind(ps, x.binds()); hasRs = ps.execute(); }
            else hasRs = st.execute(cls.executableSql());
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("queryId", x.queryId());
            out.put("kind", cls.kind() == SqlClassifier.Kind.READ ? "read" : cls.kind() == SqlClassifier.Kind.DDL ? "ddl" : "write");
            if (hasRs) {
                ResultSet rs = st.getResultSet();
                cursor = new Cursor(sessions.newId("c_"), s, st, rs, maxRows, pageSize, x.limits()).keepStatement();
                out.put("columns", cursor.columns());
                Cursor.Page page = cursor.fetch(pageSize);
                out.put("rows", page.rows());
                out.put("hasMore", page.hasMore());
                out.put("truncated", page.truncated());
                if (page.hasMore()) {
                    out.put("cursorId", cursor.id);
                    cursor.ownStatement();
                    sessions.registerCursor(cursor);
                    handedOff = true; // statement/result set now owned by the cursor
                } else {
                    out.put("rowCount", (long) cursor.delivered());
                }
            } else {
                long uc = st.getUpdateCount();
                out.put("columns", List.of());
                out.put("rows", List.of());
                out.put("hasMore", false);
                out.put("truncated", false);
                out.put("updateCount", uc);
            }
            List<String> msgs = warnings(st.getWarnings());
            // further results (procedure calls, Oracle implicit results) — only when the first one is fully delivered,
            // since moving on would close its result set
            if (!handedOff) {
                List<Map<String, Object>> more = moreResults(s, st, Math.min(maxRows, 1000), pageSize, x.limits(), Cursor.PAGE_BYTE_BUDGET - Json.write(out).getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
                if (!more.isEmpty()) out.put("moreResults", more);
                msgs.addAll(warnings(st.getWarnings()).stream().filter(m -> !msgs.contains(m)).toList());
            }
            if (!msgs.isEmpty()) out.put("messages", msgs.size() > MAX_MESSAGES ? msgs.subList(0, MAX_MESSAGES) : msgs);
            if (x.serverOutput()) out.put("serverOutput", s.vendor.readServerOutput(s.conn, 5000, 512 * 1024));
            out.put("autoCommit", s.autoCommit);
            out.put("txPending", s.dirty);
            out.put("elapsedMs", (System.nanoTime() - x.t0()) / 1_000_000L);
            return out;
        } catch (SQLException | RuntimeException e) {
            if (handedOff && cursor != null) {
                cursor.close();
                sessions.dropCursor(cursor.id);
                handedOff = false;
            }
            if (rq.cancelled) throw new RpcError("E_CANCELLED", "query cancelled");
            if (rq.timedOut) throw new RpcError("E_TIMEOUT", "query exceeded timeout of " + timeoutSec + "s", null, 0, true);
            throw e;
        } finally {
            if (timer != null) timer.cancel(false);
            if (!handedOff) {
                if (cursor != null) cursor.close();
                if (st != null) try { st.close(); } catch (SQLException | RuntimeException ignored) { }
            }
            if (flipped) {
                try { s.conn.setReadOnly(true); } catch (SQLException | RuntimeException ignored) { }
            }
        }
    }

    /** Remaining results of a statement, each read eagerly (bounded rows and bytes). */
    private List<Map<String, Object>> moreResults(Session s, Statement st, int maxRows, int pageSize, ValueEncoder.Limits lim, long budget) {
        List<Map<String, Object>> out = new ArrayList<>();
        long bytes = 0;
        for (int k = 0; k < MAX_MORE_RESULTS; k++) {
            boolean isRs;
            long uc;
            try {
                isRs = st.getMoreResults();
                uc = isRs ? -1 : st.getUpdateCount();
            } catch (SQLException | RuntimeException e) {
                Log.debug("getMoreResults unsupported: " + e.getClass().getSimpleName());
                break;
            }
            if (!isRs && uc == -1) break;
            Map<String, Object> r = new LinkedHashMap<>();
            if (isRs) {
                try {
                    Cursor c = new Cursor("more", s, st, st.getResultSet(), maxRows, pageSize, lim).keepStatement();
                    r.put("columns", c.columns());
                    Cursor.Page pg = c.fetch(maxRows);
                    r.put("rows", pg.rows());
                    r.put("truncated", pg.hasMore() || pg.truncated());
                    c.close();
                } catch (SQLException e) {
                    Log.debug("reading a further result failed: " + e.getClass().getSimpleName());
                    break;
                }
            } else {
                r.put("columns", List.of());
                r.put("rows", List.of());
                r.put("updateCount", uc);
            }
            long resultBytes = Json.write(r).getBytes(java.nio.charset.StandardCharsets.UTF_8).length + 1;
            if (bytes + resultBytes > budget) throw RpcError.limit("additional results exceed response byte budget");
            bytes += resultBytes;
            out.add(r);
        }
        return out;
    }

    /** query.plan: execution plan of one query/DML statement (never executes it). */
    private Map<String, Object> plan(Params p) {
        String sql = p.reqStr("sql");
        if (sql.length() > 1_000_000) throw RpcError.badRequest("sql too long");
        int timeoutSec = p.intCapped("timeoutSec", 60, 1, 600);
        Session s = sessions.get(p.reqStr("sessionId"));
        SqlClassifier.Result cls = SqlClassifier.classify(sql);
        if (cls.malformed()) throw RpcError.badRequest("unterminated string, comment or quoted identifier");
        if (cls.statements() == 0) throw RpcError.badRequest("empty statement");
        if (cls.multi()) throw RpcError.badRequest("multiple statements are not allowed");
        String head = SqlClassifier.firstKeyword(cls.executableSql());
        boolean dml = cls.kind() == SqlClassifier.Kind.WRITE && s.vendor.explainsDml();
        if ((cls.kind() != SqlClassifier.Kind.READ && !dml) || "EXPLAIN".equals(head) || "SHOW".equals(head) || "DESCRIBE".equals(head) || "DESC".equals(head))
            throw RpcError.badRequest("only a query or a DML statement can be explained");
        Log.debugSql("plan", sql);
        long t0 = System.nanoTime();
        return runOn(s, sess -> {
            Map<String, Object> m = new LinkedHashMap<>(sess.vendor.explain(sess.conn, cls.executableSql(), timeoutSec));
            m.put("elapsedMs", (System.nanoTime() - t0) / 1_000_000L);
            return m;
        });
    }

    private Map<String, Object> fetch(Params p) {
        Cursor c = sessions.cursor(p.reqStr("cursorId"));
        int count = p.intCapped("count", c.pageSize, 1, 5000);
        Running rq = new Running();
        rq.stmt = c.statement();
        if (running.putIfAbsent(c.id, rq) != null) throw RpcError.limit("cursor fetch already in progress");
        ScheduledFuture<?> timer = watchdog.schedule(() -> {
            rq.timedOut = true;
            try { rq.stmt.cancel(); } catch (SQLException | RuntimeException ignored) { }
        }, 105, TimeUnit.SECONDS);
        try {
            return runOn(c.session, s -> {
                if (c.isClosed()) throw RpcError.notFound("unknown cursor");
                try {
                    if (rq.cancelled) throw new RpcError("E_CANCELLED", "fetch cancelled");
                    if (rq.timedOut) throw new RpcError("E_TIMEOUT", "fetch exceeded timeout", null, 0, true);
                    Cursor.Page page = c.fetch(count);
                    if (rq.cancelled) throw new RpcError("E_CANCELLED", "fetch cancelled");
                    if (rq.timedOut) throw new RpcError("E_TIMEOUT", "fetch exceeded timeout", null, 0, true);
                    return Map.of("rows", page.rows(), "hasMore", page.hasMore(), "truncated", page.truncated());
                } catch (SQLException | RuntimeException e) {
                    c.close();
                    if (rq.cancelled) throw new RpcError("E_CANCELLED", "fetch cancelled");
                    if (rq.timedOut) throw new RpcError("E_TIMEOUT", "fetch exceeded timeout", null, 0, true);
                    throw e;
                }
            });
        } finally {
            timer.cancel(false);
            running.remove(c.id, rq);
            if (c.isClosed()) sessions.dropCursor(c.id);
        }
    }

    private Map<String, Object> cancel(Params p) {
        String cursorId = p.str("cursorId");
        Running rq = running.get(cursorId != null ? cursorId : p.reqStr("queryId"));
        if (rq == null) return Map.of("cancelled", false);
        rq.cancelled = true;
        Statement st = rq.stmt;
        if (st != null) {
            try { st.cancel(); } catch (SQLException | RuntimeException e) { Log.debug("cancel failed: " + e.getClass().getSimpleName()); }
        }
        return Map.of("cancelled", true);
    }

    private Map<String, Object> diagProxy(Params p) {
        String host = p.reqStr("host");
        if (!Profile.HOST.matcher(host).matches()) throw RpcError.badRequest("invalid host");
        int port = p.intIn("port", 0, 1, 65535);
        if (port == 0) throw RpcError.badRequest("port is required");
        return Diag.proxyCheck(host, port, Profile.parseProxy(p.obj("proxy")), 5000);
    }

    @Override public void close() {
        watchdog.shutdownNow();
        sessions.close();
    }
}
