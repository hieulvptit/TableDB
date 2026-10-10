package vn.vnpay.tabledb.jdbc;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static vn.vnpay.tabledb.jdbc.TestEnv.code;
import static vn.vnpay.tabledb.jdbc.TestEnv.ok;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Runs only when target/drivers exists (scripts/fetch-drivers.sh). Uses the REAL postgresql/trino/ojdbc11 jars with the
 * production vendors, but NO real database: it proves the drivers load through checksum verification, accept our URL and
 * property names, and (for Trino SSO) that the redirect hook emits auth.openUrl against a minimal fake coordinator.
 */
class RealDriversTest {
    @org.junit.jupiter.api.io.TempDir Path tmp;
    Path drivers;
    Dispatcher d;
    EventBus bus;
    int ids;

    @BeforeEach void setUp() {
        drivers = Path.of("target", "drivers").toAbsolutePath();
        assumeTrue(Files.isRegularFile(drivers.resolve("manifest.json")), "run scripts/fetch-drivers.sh to enable");
        bus = new EventBus();
        DriverRegistry reg = new DriverRegistry(drivers, Main.DRIVER_TYPES);
        d = new Dispatcher(reg, Main.productionVendors(bus), new SessionManager(Config.defaults()), bus, "test");
    }

    @AfterEach void tearDown() { if (d != null) d.close(); }

    Map<String, Object> rpc(String m, Object... kv) {
        Map<String, Object> params = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) params.put((String) kv[i], kv[i + 1]);
        return d.handleRaw(Json.write(Map.of("id", (long) ++ids, "method", m, "params", params)));
    }

    static int closedPort() throws IOException {
        try (var s = new java.net.ServerSocket(0, 1, InetAddress.getLoopbackAddress())) { return s.getLocalPort(); }
    }

    static Map<String, Object> profile(String driver, int port, Map<String, Object> auth, Map<String, Object> opts) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("driver", driver);
        p.put("host", "127.0.0.1");
        p.put("port", (long) port);
        if (driver.equals("oracle")) p.put("database", "SVC");
        p.put("auth", auth);
        p.put("options", opts);
        return p;
    }

    @Test void allThreeRealDriversLoadWithVerifiedChecksums() {
        List<?> ds = (List<?>) ok(rpc("hello")).get("drivers");
        assertEquals(3, ds.size());
        for (Object o : ds) {
            Map<?, ?> m = (Map<?, ?>) o;
            assertEquals(true, m.get("loaded"), m.toString());
            assertEquals(64, ((String) m.get("sha256")).length());
        }
    }

    @Test void realDriversAcceptOurUrlsAndPropertiesAndFailWithConnError() throws Exception {
        int port = closedPort();
        Map<String, Object> pw = Map.of("type", "password", "username", "u", "password", "pw");
        for (String drv : new String[] {"postgresql", "oracle", "trino"}) {
            Map<String, Object> opts = new LinkedHashMap<>(Map.of("connectTimeoutSec", 3L));
            Map<String, Object> r = rpc("session.test", "profile", profile(drv, port, new LinkedHashMap<>(pw), opts));
            // Nothing listens on that port: the ONLY acceptable outcome is a connection-level error, which shows the
            // driver parsed our URL/properties (a bad property would be E_SQL/E_INTERNAL/E_BAD_REQUEST instead).
            assertEquals("E_CONN", code(r), drv + " -> " + r);
            assertFalse(Json.write(r).contains("\"pw\""));
        }
    }

    @Test void trinoJwtAndProxyPropertiesAreAccepted() throws Exception {
        int port = closedPort();
        Map<String, Object> opts = new LinkedHashMap<>();
        opts.put("ssl", false);
        opts.put("proxy", new LinkedHashMap<>(Map.of("type", "http", "host", "127.0.0.1", "port", (long) closedPort())));
        Map<String, Object> r = rpc("session.test", "profile", profile("trino", port, new LinkedHashMap<>(Map.of("type", "trino-jwt", "token", "a.b.c")), opts));
        // jwt over plain HTTP is refused by the driver itself, or the proxy is unreachable: either way not a property error
        assertTrue(List.of("E_CONN", "E_AUTH_FAILED", "E_SQL").contains(code(r)), r.toString());
        assertFalse(Json.write(r).contains("a.b.c"));
    }

    // ---------------------------------------------------------------- Trino SSO against a minimal fake coordinator

    static final class FakeCoordinator implements AutoCloseable {
        final HttpsServer server;
        final AtomicInteger tokenPolls = new AtomicInteger();
        volatile boolean grantToken = true;

        FakeCoordinator(Path dir) throws Exception {
            // Self-signed cert for 127.0.0.1 generated with the JDK's keytool; trusted via the JVM default trust store.
            Path ks = dir.resolve("fake.p12");
            Process kt = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "keytool").toString(), "-genkeypair", "-alias", "fake",
                    "-keyalg", "RSA", "-keysize", "2048", "-validity", "2", "-storetype", "PKCS12", "-keystore", ks.toString(),
                    "-storepass", "changeit", "-dname", "CN=127.0.0.1", "-ext", "san=ip:127.0.0.1").redirectErrorStream(true).start();
            kt.getInputStream().readAllBytes();
            assertEquals(0, kt.waitFor());
            System.setProperty("javax.net.ssl.trustStore", ks.toString());
            System.setProperty("javax.net.ssl.trustStorePassword", "changeit");
            System.setProperty("javax.net.ssl.trustStoreType", "PKCS12");
            java.security.KeyStore k = java.security.KeyStore.getInstance("PKCS12");
            try (var in = Files.newInputStream(ks)) { k.load(in, "changeit".toCharArray()); }
            var kmf = javax.net.ssl.KeyManagerFactory.getInstance(javax.net.ssl.KeyManagerFactory.getDefaultAlgorithm());
            kmf.init(k, "changeit".toCharArray());
            var ctx = javax.net.ssl.SSLContext.getInstance("TLS");
            ctx.init(kmf.getKeyManagers(), null, null);
            server = HttpsServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
            server.setHttpsConfigurator(new HttpsConfigurator(ctx));
            server.createContext("/v1/statement", this::statement);
            server.createContext("/token", this::token);
            server.start();
        }

        int port() { return server.getAddress().getPort(); }

        final java.util.concurrent.atomic.AtomicInteger headRequests = new java.util.concurrent.atomic.AtomicInteger();
        final java.util.concurrent.atomic.AtomicInteger postRequests = new java.util.concurrent.atomic.AtomicInteger();
        volatile boolean rejectQueries;

        void statement(HttpExchange ex) throws IOException {
            ex.getRequestBody().readAllBytes();
            if (ex.getRequestMethod().equals("HEAD")) {
                headRequests.incrementAndGet();
                ex.sendResponseHeaders(405, -1);
                ex.close();
                return;
            }
            postRequests.incrementAndGet();
            if (rejectQueries) {
                ex.sendResponseHeaders(403, -1);
                ex.close();
                return;
            }
            String auth = ex.getRequestHeaders().getFirst("Authorization");
            if (auth == null || !auth.equals("Bearer tok-123")) {
                ex.getResponseHeaders().add("WWW-Authenticate", "Bearer x_redirect_server=\"https://127.0.0.1:" + port() + "/redirect/abc\", x_token_server=\"https://127.0.0.1:" + port() + "/token/abc\"");
                ex.sendResponseHeaders(401, -1);
                ex.close();
                return;
            }
            String body = "{\"id\":\"q1\",\"infoUri\":\"https://127.0.0.1:" + port() + "/ui/q1\",\"columns\":[{\"name\":\"_col0\",\"type\":\"bigint\","
                    + "\"typeSignature\":{\"rawType\":\"bigint\",\"arguments\":[]}}],\"data\":[[1]],"
                    + "\"stats\":{\"state\":\"FINISHED\",\"queued\":false,\"scheduled\":true,\"nodes\":1,\"totalSplits\":1,\"queuedSplits\":0,\"runningSplits\":0,"
                    + "\"completedSplits\":1,\"cpuTimeMillis\":0,\"wallTimeMillis\":0,\"queuedTimeMillis\":0,\"elapsedTimeMillis\":0,\"processedRows\":1,"
                    + "\"processedBytes\":1,\"physicalInputBytes\":1,\"peakMemoryBytes\":1,\"spilledBytes\":0},\"warnings\":[]}";
            send(ex, 200, body);
        }

        void token(HttpExchange ex) throws IOException {
            tokenPolls.incrementAndGet();
            if (grantToken) send(ex, 200, "{\"token\":\"tok-123\"}");
            else send(ex, 200, "{\"nextUri\":\"https://127.0.0.1:" + port() + "/token/abc\"}");
        }

        static void send(HttpExchange ex, int status, String body) throws IOException {
            byte[] b = body.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", "application/json");
            ex.sendResponseHeaders(status, b.length);
            ex.getResponseBody().write(b);
            ex.close();
        }

        @Override public void close() { server.stop(0); }
    }

    @Test void trinoSsoConnectsWithTlsThroughAuthenticatedHttpProxy() throws Exception {
        try (FakeCoordinator fc = new FakeCoordinator(tmp);
             TestProxies.Proxy proxy = new TestProxies.Proxy(false, "de_team", "test-proxy-password")) {
            Map<String, Object> opts = new LinkedHashMap<>(Map.of("ssl", false, "externalAuthTimeoutSec", 30L));
            opts.put("proxy", Map.of("type", "http", "host", "127.0.0.1", "port", (long) proxy.port(), "username", "de_team", "password", "test-proxy-password"));
            Map<String, Object> result = ok(rpc("session.open", "profile", profile("trino", fc.port(), new LinkedHashMap<>(Map.of("type", "trino-external")), opts)));
            assertNotNull(result.get("sessionId"));
            assertTrue(proxy.connects.get() > 0);
            assertEquals("127.0.0.1:" + fc.port(), proxy.lastTarget);
            assertTrue(fc.tokenPolls.get() > 0);
            Map<?, ?> event = bus.after(0, 0).getFirst();
            Map<?, ?> data = (Map<?, ?>) event.get("data");
            assertEquals("http://127.0.0.1:" + proxy.port() + "/", data.get("proxyUrl"));
            assertFalse(Json.write(data).contains("test-proxy-password"));
            assertNull(Session.CURRENT_PROXY.get());
        }
    }

    @Test void trinoSsoEmitsAuthOpenUrlEventAndCompletesOpen() throws Exception {
        try (FakeCoordinator fc = new FakeCoordinator(tmp)) {
            // Legacy profiles can store ssl=false; SSO must still use HTTPS.
            Map<String, Object> opts = new LinkedHashMap<>(Map.of("ssl", false, "externalAuthTimeoutSec", 30L));
            Map<String, Object> r = rpc("session.open", "profile", profile("trino", fc.port(), new LinkedHashMap<>(Map.of("type", "trino-external")), opts));
            Map<String, Object> res = ok(r);
            String sid = (String) res.get("sessionId");
            List<Map<String, Object>> evs = bus.after(0, 0);
            assertEquals(1, evs.size(), evs.toString());
            Map<?, ?> ev = evs.get(0);
            assertEquals("auth.openUrl", ev.get("event"));
            Map<?, ?> data = (Map<?, ?>) ev.get("data");
            assertEquals(sid, data.get("sessionId"));
            assertEquals("trino-sso", data.get("purpose"));
            assertEquals("https://127.0.0.1:" + fc.port() + "/redirect/abc", data.get("url"));
            assertTrue(fc.tokenPolls.get() >= 1);
            assertEquals(0, fc.headRequests.get(), "HEAD must not be used on coordinators returning 405");
            assertTrue(fc.postRequests.get() >= 2, "the open probe must authenticate and execute through POST");
        }
    }

    @Test void trinoOpenRejectsFailedPostProbeWithoutRegisteringSession() throws Exception {
        try (FakeCoordinator fc = new FakeCoordinator(tmp)) {
            fc.rejectQueries = true;
            var result = rpc("session.open", "profile", profile("trino", fc.port(),
                    new LinkedHashMap<>(Map.of("type", "trino-external")),
                    new LinkedHashMap<>(Map.of("ssl", true, "externalAuthTimeoutSec", 10L))));
            assertTrue(result.containsKey("error"), result.toString());
            assertEquals(0, fc.headRequests.get());
            assertTrue(fc.postRequests.get() > 0);
            assertEquals(0, d.sessions().sessionCount());
        }
    }

    @Test void trinoSsoTimeoutMapsToInteractiveTimeout() throws Exception {
        try (FakeCoordinator fc = new FakeCoordinator(tmp)) {
            fc.grantToken = false; // user never completes login
            Map<String, Object> opts = new LinkedHashMap<>(Map.of("ssl", true, "externalAuthTimeoutSec", 10L));
            long t0 = System.nanoTime();
            Map<String, Object> r = rpc("session.open", "profile", profile("trino", fc.port(), new LinkedHashMap<>(Map.of("type", "trino-external")), opts));
            assertEquals("E_AUTH_INTERACTIVE_TIMEOUT", code(r), r.toString());
            assertTrue((System.nanoTime() - t0) / 1_000_000_000L >= 8);
            assertEquals(1, bus.after(0, 0).size());
            assertEquals(0, d.sessions().sessionCount());
        }
    }
}
