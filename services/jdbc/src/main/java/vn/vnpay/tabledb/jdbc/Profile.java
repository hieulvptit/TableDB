package vn.vnpay.tabledb.jdbc;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.regex.Pattern;

/** Validated connection profile. Anything not explicitly allowed is rejected with E_BAD_REQUEST. */
public final class Profile {
    public static final Pattern HOST = Pattern.compile("^(?:[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?|\\[[0-9A-Fa-f:.]{2,45}\\])$");
    public static final Pattern IDENT = Pattern.compile("^[A-Za-z0-9_$#.-]{1,128}$");
    static final Set<String> PROFILE_KEYS = Set.of("driver", "host", "port", "database", "schema", "auth", "options", "driverId", "ssh");
    static final Set<String> AUTH_KEYS = Set.of("type", "username", "password", "token");
    static final Set<String> OPTION_KEYS = Set.of("ssl", "readOnly", "allowWrite", "connectTimeoutSec", "proxy", "externalAuthTimeoutSec", "connectType", "props");
    static final Set<String> PROXY_KEYS = Set.of("type", "host", "port", "username", "password");
    static final Set<String> SSH_KEYS = Set.of("hops", "keepAliveSec");
    static final Set<String> HOP_KEYS = Set.of("host", "port", "username", "auth", "hostKey");
    static final Set<String> HOP_AUTH_KEYS = Set.of("type", "password", "keyId", "passphrase");
    public static final int MAX_HOPS = 4;
    /** OpenSSH-style SHA-256 host key fingerprint (unpadded base64 of the key blob digest). */
    public static final Pattern HOST_KEY = Pattern.compile("^SHA256:[A-Za-z0-9+/]{43}$");
    /** id of an SSH private key imported by the desktop into the --ssh-keys directory (never a path). */
    public static final Pattern KEY_ID = Pattern.compile("^[A-Za-z0-9_-]{1,64}$");

    public static final Pattern PROP_KEY = Pattern.compile("^[A-Za-z][A-Za-z0-9_.$-]{0,79}$");
    static final int MAX_PROPS = 20;
    static final int MAX_PROP_VALUE = 512;
    public static final Set<String> CONNECT_TYPES = Set.of("serviceName", "sid");

    public record Proxy(String type, String host, int port, String username, String password) {
        public Proxy(String type, String host, int port) { this(type, host, port, null, null); }
        public boolean hasCredentials() { return username != null; }
        @Override public String toString() { return type + "://" + host + ":" + port; }
    }

    /** One SSH server on the way to the database; the last hop forwards to host:port. */
    public record SshHop(String host, int port, String username, String authType, String password, String keyId, String passphrase, String hostKey) {
        @Override public String toString() { return username + "@" + host + ":" + port; }
    }

    /** SSH tunnel: hops in order (first is dialed directly or through {@link #proxy}). */
    public record Ssh(java.util.List<SshHop> hops, int keepAliveSec) {}

    public final String driver;
    /** manifest id of the imported driver; only for driver == "custom" */
    public final String driverId;
    public final String host;
    public final int port;
    public final String database;
    public final String schema;
    public final String authType;   // password | trino-external | trino-jwt
    public final String username;
    public final String password;
    public final String token;
    public final boolean ssl;
    public final boolean readOnly;
    public final boolean allowWrite;
    public final int connectTimeoutSec;
    public final int externalAuthTimeoutSec;
    /** Proxy towards the DB (no ssh) or towards the first SSH hop (ssh). */
    public final Proxy proxy;
    /** SSH tunnel, or null for a direct/proxied connection */
    public final Ssh ssh;
    /** true when host/port were rewritten to a local tunnel endpoint (see {@link #routedTo}) */
    public final boolean routed;
    /** the database host as configured (differs from {@link #host} only when routed) */
    public final String targetHost;
    public final int targetPort;
    /** Oracle only: "serviceName" (default) or "sid"; null for other drivers */
    public final String connectType;
    /** extra driver properties (validated); vendor-set properties always win */
    public final Map<String, String> props;

    private Profile(Params p, Params auth, Params opt, Set<String> types, Function<String, Integer> customDefaultPort) {
        driver = p.reqStr("driver");
        if (!types.contains(driver)) throw RpcError.badRequest("unsupported driver type");
        host = p.reqStr("host");
        if (!HOST.matcher(host).matches()) throw RpcError.badRequest("invalid host (characters such as / ? ; = are not allowed)");
        String did = p.str("driverId");
        if (driver.equals("custom")) {
            if (did == null || !IDENT.matcher(did).matches()) throw RpcError.badRequest("profile.driverId is required for custom drivers");
        } else if (did != null) {
            throw RpcError.badRequest("profile.driverId is only valid for custom drivers");
        }
        driverId = did;
        int defPort = switch (driver) {
            case "postgresql" -> 5432;
            case "oracle" -> 1521;
            case "custom" -> {
                Integer dp = customDefaultPort == null ? null : customDefaultPort.apply(did);
                yield dp == null ? 0 : dp;
            }
            default -> 0;
        };
        port = p.intIn("port", defPort, 1, 65535);
        if (port == 0) throw RpcError.badRequest("profile.port is required");
        database = ident(p, "database");
        schema = ident(p, "schema");

        auth.only(AUTH_KEYS);
        authType = auth.reqStr("type");
        switch (authType) {
            case "password" -> {
                username = bounded(auth.reqStr("username"), "username");
                password = auth.str("password") == null ? "" : bounded(auth.str("password"), "password");
                token = null;
            }
            case "trino-external" -> {
                requireTrino();
                username = auth.str("username") == null ? null : bounded(auth.str("username"), "username");
                password = null; token = null;
            }
            case "trino-jwt" -> {
                requireTrino();
                token = bounded(auth.reqStr("token"), "token");
                username = auth.str("username") == null ? null : bounded(auth.str("username"), "username");
                password = null;
            }
            default -> throw RpcError.badRequest("unsupported auth type");
        }

        opt.only(OPTION_KEYS);
        ssl = opt.bool("ssl", false);
        readOnly = opt.bool("readOnly", true);
        allowWrite = opt.bool("allowWrite", false);
        connectTimeoutSec = opt.intIn("connectTimeoutSec", 15, 1, 120);
        externalAuthTimeoutSec = opt.intIn("externalAuthTimeoutSec", 180, 10, 900);
        String ct = opt.str("connectType");
        if (ct != null) {
            if (!driver.equals("oracle")) throw RpcError.badRequest("options.connectType is only valid for oracle");
            if (!CONNECT_TYPES.contains(ct)) throw RpcError.badRequest("options.connectType must be serviceName or sid");
        }
        connectType = driver.equals("oracle") ? (ct == null ? "serviceName" : ct) : null;
        props = parseProps(opt.obj("props"));
        proxy = parseProxy(opt.obj("proxy"));
        ssh = parseSsh(p.obj("ssh"));
        routed = false;
        targetHost = host;
        targetPort = port;
    }

    private Profile(Profile o, String host, int port) {
        driver = o.driver; driverId = o.driverId; this.host = host; this.port = port; database = o.database; schema = o.schema;
        authType = o.authType; username = o.username; password = o.password; token = o.token;
        ssl = o.ssl; readOnly = o.readOnly; allowWrite = o.allowWrite; connectTimeoutSec = o.connectTimeoutSec;
        externalAuthTimeoutSec = o.externalAuthTimeoutSec; proxy = o.proxy; ssh = o.ssh; connectType = o.connectType; props = o.props;
        routed = true; targetHost = o.targetHost; targetPort = o.targetPort;
    }

    /** Copy that connects to a local tunnel endpoint instead of the database; {@link #targetHost} keeps the real host. */
    public Profile routedTo(String localHost, int localPort) { return new Profile(this, localHost, localPort); }

    /** Proxy (http CONNECT / socks5), optional username/password. Shared with diag.proxy. */
    static Proxy parseProxy(Params px) {
        if (px == null) return null;
        px.only(PROXY_KEYS);
        String t = px.reqStr("type");
        if (!t.equals("http") && !t.equals("socks")) throw RpcError.badRequest("proxy.type must be http or socks");
        String h = px.reqStr("host");
        if (!HOST.matcher(h).matches()) throw RpcError.badRequest("invalid proxy host");
        int pp = px.intIn("port", 0, 1, 65535);
        if (pp == 0) throw RpcError.badRequest("proxy.port is required");
        String u = px.str("username");
        String pw = px.str("password");
        if (u != null && u.isEmpty()) u = null;
        if (u == null && pw != null && !pw.isEmpty()) throw RpcError.badRequest("proxy.password requires proxy.username");
        if (u != null) {
            if (u.length() > 255 || !printable(u)) throw RpcError.badRequest("invalid proxy.username");
            if (pw == null) pw = "";
            if (pw.length() > 255 || pw.indexOf('\0') >= 0) throw RpcError.badRequest("invalid proxy.password");
        } else pw = null;
        return new Proxy(t, h, pp, u, pw);
    }

    private static boolean printable(String s) {
        for (int i = 0; i < s.length(); i++) if (Character.isISOControl(s.charAt(i))) return false;
        return true;
    }

    private static Ssh parseSsh(Params sp) {
        if (sp == null) return null;
        sp.only(SSH_KEYS);
        int keepAlive = sp.intIn("keepAliveSec", 30, 0, 600);
        Object raw = sp.raw().get("hops");
        if (!(raw instanceof java.util.List<?> list) || list.isEmpty()) throw RpcError.badRequest("ssh.hops must be a non-empty array");
        if (list.size() > MAX_HOPS) throw RpcError.badRequest("ssh.hops allows at most " + MAX_HOPS + " entries");
        java.util.List<SshHop> hops = new java.util.ArrayList<>();
        for (int i = 0; i < list.size(); i++) {
            if (!(list.get(i) instanceof Map<?, ?>)) throw RpcError.badRequest("ssh.hops[" + i + "] must be an object");
            @SuppressWarnings("unchecked") Map<String, Object> hm = (Map<String, Object>) list.get(i);
            Params h = new Params(hm, "ssh.hops[" + i + "]");
            h.only(HOP_KEYS);
            String hh = h.reqStr("host");
            if (!HOST.matcher(hh).matches()) throw RpcError.badRequest("invalid ssh.hops[" + i + "].host");
            int hp = h.intIn("port", 22, 1, 65535);
            String user = h.reqStr("username");
            if (user.length() > 128 || !printable(user)) throw RpcError.badRequest("invalid ssh.hops[" + i + "].username");
            String hk = h.str("hostKey");
            if (hk != null && hk.isEmpty()) hk = null;
            if (hk != null && !HOST_KEY.matcher(hk).matches()) throw RpcError.badRequest("ssh.hops[" + i + "].hostKey must look like SHA256:<43 base64 chars>");
            Params a = h.obj("auth");
            if (a == null) throw RpcError.badRequest("ssh.hops[" + i + "].auth is required");
            a.only(HOP_AUTH_KEYS);
            String at = a.reqStr("type");
            String pw = null, keyId = null, pass = null;
            switch (at) {
                case "password" -> {
                    pw = a.str("password") == null ? "" : bounded(a.str("password"), "ssh password");
                    if (a.has("keyId") || a.has("passphrase")) throw RpcError.badRequest("ssh password auth takes no keyId/passphrase");
                }
                case "publicKey" -> {
                    keyId = a.reqStr("keyId");
                    if (!KEY_ID.matcher(keyId).matches()) throw RpcError.badRequest("invalid ssh.hops[" + i + "].auth.keyId");
                    String ps = a.str("passphrase");
                    pass = ps == null || ps.isEmpty() ? null : bounded(ps, "ssh passphrase");
                    if (a.has("password")) throw RpcError.badRequest("ssh publicKey auth takes no password");
                }
                default -> throw RpcError.badRequest("ssh auth type must be password or publicKey");
            }
            hops.add(new SshHop(hh, hp, user, at, pw, keyId, pass, hk));
        }
        return new Ssh(java.util.List.copyOf(hops), keepAlive);
    }

    private static boolean deniedProp(String k) {
        String l = k.toLowerCase(java.util.Locale.ROOT);
        return l.equals("user") || l.equals("password") || l.startsWith("javax.net.ssl.") || l.startsWith("java.")
                || l.equals("oracle.net.wallet_location") || l.equals("oracle.jdbc.librarypath");
    }

    private static Map<String, String> parseProps(Params pp) {
        if (pp == null) return Map.of();
        if (pp.raw().size() > MAX_PROPS) throw RpcError.badRequest("options.props allows at most " + MAX_PROPS + " entries");
        Map<String, String> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : pp.raw().entrySet()) {
            String k = e.getKey();
            if (!PROP_KEY.matcher(k).matches()) throw RpcError.badRequest("invalid options.props key");
            if (deniedProp(k)) throw RpcError.badRequest("options.props key is not allowed");
            if (!(e.getValue() instanceof String v)) throw RpcError.badRequest("options.props values must be strings");
            if (v.length() > MAX_PROP_VALUE || v.indexOf('\0') >= 0) throw RpcError.badRequest("invalid options.props value");
            out.put(k, v);
        }
        return java.util.Collections.unmodifiableMap(out);
    }

    private void requireTrino() {
        if (!driver.equals("trino")) throw RpcError.badRequest("auth type only valid for trino");
    }

    private static String bounded(String s, String what) {
        if (s.length() > 4096 || s.indexOf('\0') >= 0) throw RpcError.badRequest(what + " is invalid");
        return s;
    }

    private static String ident(Params p, String k) {
        String v = p.str(k);
        if (v == null || v.isEmpty()) return null;
        if (!IDENT.matcher(v).matches()) throw RpcError.badRequest("invalid " + k);
        return v;
    }

    public static Profile parse(Params profile, Set<String> allowedTypes) {
        return parse(profile, allowedTypes, null);
    }

    /** @param customDefaultPort manifest defaultPort for a custom driver id (may return null) */
    public static Profile parse(Params profile, Set<String> allowedTypes, Function<String, Integer> customDefaultPort) {
        if (profile == null) throw RpcError.badRequest("profile is required");
        profile.only(PROFILE_KEYS);
        Params auth = profile.obj("auth");
        if (auth == null) throw RpcError.badRequest("profile.auth is required");
        Params opt = profile.obj("options");
        if (opt == null) opt = new Params(java.util.Map.of(), "profile.options");
        return new Profile(profile, auth, opt, allowedTypes, customDefaultPort);
    }

    /** Values that must never appear in logs/errors. */
    public String[] secrets() {
        java.util.List<String> l = new java.util.ArrayList<>();
        l.add(password);
        l.add(token);
        l.addAll(props.values());
        if (proxy != null) l.add(proxy.password());
        if (ssh != null) for (SshHop h : ssh.hops()) { l.add(h.password()); l.add(h.passphrase()); }
        return l.toArray(new String[0]);
    }
}
