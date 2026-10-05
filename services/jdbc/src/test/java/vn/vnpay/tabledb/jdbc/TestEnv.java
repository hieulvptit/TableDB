package vn.vnpay.tabledb.jdbc;

import java.io.IOException;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Test scaffolding. H2 (a real JDBC engine, test scope only) is exposed as driver type "h2test" and is loaded from a
 * copied jar through the production DriverRegistry/DriverShim path. "h2test" is NOT an allowed production type.
 */
final class TestEnv {
    static final AtomicInteger DB = new AtomicInteger();

    /** Test-only vendor: synthesized DDL, no keys quirks. */
    static final class H2Vendor extends Vendor {
        @Override public String type() { return "h2test"; }
        @Override public String url(Profile p) { return "jdbc:h2:mem:" + p.database + ";DB_CLOSE_DELAY=-1"; }
        @Override public Properties props(Profile p) {
            Properties pr = new Properties();
            pr.setProperty("user", p.username);
            pr.setProperty("password", p.password == null ? "" : p.password);
            return pr;
        }
    }

    static Path h2Jar() {
        try {
            return Paths.get(Class.forName("org.h2.Driver").getProtectionDomain().getCodeSource().getLocation().toURI());
        } catch (ClassNotFoundException | URISyntaxException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Writes drivers dir with the h2 jar + manifest; returns the dir. */
    static Path driversDir(Path tmp) throws IOException {
        Path dir = Files.createDirectories(tmp.resolve("drivers"));
        Path jar = dir.resolve("h2-test.jar");
        Files.copy(h2Jar(), jar);
        writeManifest(dir, "h2test", "h2-test.jar", Redactor.sha256Hex(Files.readAllBytes(jar)), "org.h2.Driver");
        return dir;
    }

    static void writeManifest(Path dir, String type, String file, String sha, String cls) throws IOException {
        Files.writeString(dir.resolve("manifest.json"), Json.write(Map.of("drivers", List.of(Map.of(
                "type", type, "file", file, "sha256", sha, "version", "test", "class", cls)))));
    }

    final Dispatcher d;
    final EventBus bus = new EventBus();

    TestEnv(Path tmp) throws IOException { this(tmp, Config.defaults()); }

    TestEnv(Path tmp, Config cfg) throws IOException {
        DriverRegistry reg = new DriverRegistry(driversDir(tmp), Set.of("h2test"));
        Map<String, Vendor> vendors = new LinkedHashMap<>();
        vendors.put("h2test", new H2Vendor());
        d = new Dispatcher(reg, vendors, new SessionManager(cfg), bus, "test");
    }

    static Map<String, Object> profile(String db, boolean allowWrite) {
        Map<String, Object> opts = new LinkedHashMap<>();
        opts.put("allowWrite", allowWrite);
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("driver", "h2test");
        p.put("host", "localhost");
        p.put("port", 1L);
        p.put("database", db);
        p.put("auth", new LinkedHashMap<>(Map.of("type", "password", "username", "sa", "password", "pw-Secret-123")));
        p.put("options", opts);
        return p;
    }

    static String newDb() { return "db" + DB.incrementAndGet(); }

    private final AtomicInteger ids = new AtomicInteger();

    @SuppressWarnings("unchecked")
    Map<String, Object> rpc(String method, Object... kv) {
        Map<String, Object> params = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) params.put((String) kv[i], kv[i + 1]);
        Map<String, Object> req = new LinkedHashMap<>();
        req.put("id", (long) ids.incrementAndGet());
        req.put("method", method);
        req.put("params", params);
        // round-trip through JSON text exactly like a transport would
        return d.handleRaw(Json.write(req));
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> ok(Map<String, Object> resp) {
        if (resp.containsKey("error")) throw new AssertionError("unexpected error: " + resp.get("error"));
        return (Map<String, Object>) resp.get("result");
    }

    @SuppressWarnings("unchecked")
    static String code(Map<String, Object> resp) {
        Map<String, Object> e = (Map<String, Object>) resp.get("error");
        if (e == null) throw new AssertionError("expected error, got " + resp);
        return (String) e.get("code");
    }

    String open(boolean allowWrite) {
        return (String) ok(rpc("session.open", "profile", profile(newDb(), allowWrite))).get("sessionId");
    }

    Map<String, Object> exec(String sid, String sql, String mode, boolean confirm) {
        return rpc("query.execute", "sessionId", sid, "queryId", "q" + ids.incrementAndGet(), "sql", sql, "mode", mode, "confirmWrite", confirm);
    }
}
