package vn.vnpay.tabledb.jdbc;

import java.net.URI;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.function.Consumer;

/**
 * Trino. Verified against trino-jdbc 483 with javap: connection properties externalAuthentication,
 * externalAuthenticationTimeout, httpProxy, socksProxy, SSL, accessToken, user, password, validateConnection;
 * public static io.trino.jdbc.TestingRedirectHandlerInjector.setRedirectHandler(Consumer&lt;URI&gt;) installs a
 * JVM(class-loader)-wide redirect handler that the driver captures when it builds the HTTP client.
 */
public final class TrinoVendor extends Vendor {
    private final EventBus bus;
    private final java.util.Set<ClassLoader> hooked = java.util.Collections.newSetFromMap(new java.util.WeakHashMap<>());

    public TrinoVendor(EventBus bus) { this.bus = bus; }

    @Override public String type() { return "trino"; }

    @Override public String url(Profile p) {
        StringBuilder sb = new StringBuilder("jdbc:trino://").append(p.host).append(':').append(p.port);
        if (p.database != null) {
            sb.append('/').append(p.database);
            if (p.schema != null) sb.append('/').append(p.schema);
        }
        return sb.toString();
    }

    @Override public Properties props(Profile p) {
        Properties pr = new Properties();
        pr.setProperty("user", p.username != null ? p.username : "tabledb");
        pr.setProperty("SSL", Boolean.toString(p.ssl));
        pr.setProperty("validateConnection", "true"); // run a probe at open so auth happens in session.open
        // Driver logs request URL, HTTP response status and timing to sidecar stderr.
        // BASIC omits headers, SQL request bodies and result data.
        pr.setProperty("httpLoggingLevel", "BASIC");
        switch (p.authType) {
            case "password" -> pr.setProperty("password", p.password == null ? "" : p.password);
            case "trino-jwt" -> pr.setProperty("accessToken", p.token);
            case "trino-external" -> {
                pr.setProperty("externalAuthentication", "true");
                pr.setProperty("externalAuthenticationTimeout", p.externalAuthTimeoutSec + "s");
            }
            default -> throw RpcError.badRequest("unsupported auth type");
        }
        // through a tunnel the URL host is 127.0.0.1: verify the certificate against the real coordinator name
        if (p.routed && p.ssl) pr.setProperty("hostnameInCertificate", ProxyDialer.unbracket(p.targetHost));
        if (p.proxy != null && !p.routed) {
            String hp = p.proxy.host() + ":" + p.proxy.port();
            pr.setProperty(p.proxy.type().equals("http") ? "httpProxy" : "socksProxy", hp);
        }
        return pr;
    }

    @Override public Connection connect(DriverShim driver, Profile p) throws SQLException {
        if (p.authType.equals("trino-external")) installRedirectHook(driver.loader());
        return super.connect(driver, p);
    }

    /** Route the driver's SSO redirect to an auth.openUrl event for the session bound to the calling thread. */
    private synchronized void installRedirectHook(ClassLoader loader) {
        if (hooked.contains(loader)) return;
        try {
            Class<?> c = Class.forName("io.trino.jdbc.TestingRedirectHandlerInjector", true, loader);
            Consumer<URI> handler = this::onRedirect;
            c.getMethod("setRedirectHandler", Consumer.class).invoke(null, handler);
            hooked.add(loader);
        } catch (ReflectiveOperationException | LinkageError e) {
            throw new RpcError("E_DRIVER_UNAVAILABLE", "Trino driver does not expose the redirect hook required for SSO");
        }
    }

    private void onRedirect(URI uri) {
        String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("https") || scheme.equalsIgnoreCase("http")))
            throw new IllegalArgumentException("refusing non-http redirect");
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("sessionId", Session.CURRENT.get());
        data.put("url", uri.toString());
        data.put("purpose", "trino-sso");
        Profile.Proxy proxy = Session.CURRENT_PROXY.get();
        if (proxy != null && proxy.type().equals("http")) data.put("proxyUrl", "http://" + proxy.host() + ":" + proxy.port() + "/");
        bus.emit("auth.openUrl", data);
        Log.info("auth.openUrl emitted");
    }

    @Override public boolean supportsKeys() { return false; }

    @Override public boolean explainsDml() { return true; }

    @Override public Map<String, Object> explain(Connection c, String sql, int timeoutSec) throws SQLException {
        return textPlan(c, "EXPLAIN (TYPE DISTRIBUTED, FORMAT TEXT) " + sql, timeoutSec);
    }

    @Override public String nativeDdl(Connection c, String catalog, String schema, String table, String objType) throws SQLException {
        String cat = catalog != null ? catalog : c.getCatalog();
        if (cat == null) throw RpcError.badRequest("catalog is required for Trino");
        String kw = "VIEW".equals(objType) ? "VIEW" : "TABLE";
        String sql = "SHOW CREATE " + kw + " " + quote(cat) + "." + quote(schema) + "." + quote(table);
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            if (rs.next()) return rs.getString(1).strip() + "\n";
        }
        return null;
    }

}
