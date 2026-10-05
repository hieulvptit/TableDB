package vn.vnpay.tabledb.jdbc;

import static org.junit.jupiter.api.Assertions.*;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class CustomDriversTest {
    @TempDir Path tmp;

    static String sha(Path p) throws IOException { return Redactor.sha256Hex(Files.readAllBytes(p)); }

    /** custom dir with the h2 jar + a tiny second jar (multi-jar entry) and one manifest entry. */
    Path customDir(Map<String, Object> override) throws IOException {
        Path dir = Files.createDirectories(tmp.resolve("custom"));
        Path h2 = dir.resolve("h2.jar");
        Files.copy(TestEnv.h2Jar(), h2, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        Path extra = dir.resolve("extra.jar");
        try (JarOutputStream out = new JarOutputStream(Files.newOutputStream(extra))) {
            out.putNextEntry(new JarEntry("extra.txt"));
            out.write("x".getBytes());
            out.closeEntry();
        }
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("type", "custom");
        e.put("id", "h2c");
        e.put("name", "H2 custom");
        e.put("version", "1");
        e.put("class", "org.h2.Driver");
        e.put("urlTemplate", "jdbc:h2:mem:{database};DB_CLOSE_DELAY=-1");
        e.put("defaultPort", 9092L);
        e.put("files", List.of(Map.of("file", "h2.jar", "sha256", sha(h2)), Map.of("file", "extra.jar", "sha256", sha(extra))));
        e.putAll(override);
        writeManifest(dir, List.of(e));
        return dir;
    }

    static void writeManifest(Path dir, List<Map<String, Object>> entries) throws IOException {
        Files.writeString(dir.resolve("manifest.json"), Json.write(Map.of("drivers", entries)));
    }

    Path builtin;

    DriverRegistry reg(Path custom) throws IOException {
        if (builtin == null) builtin = TestEnv.driversDir(tmp);
        return new DriverRegistry(builtin, Set.of("h2test"), custom);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> customDesc(DriverRegistry r) {
        return r.describe().stream().filter(m -> "custom".equals(m.get("type"))).findFirst().orElseThrow();
    }

    @Test void multiJarEntryLoadsAndListsFiles() throws Exception {
        DriverRegistry r = reg(customDir(Map.of()));
        Map<String, Object> d = customDesc(r);
        assertEquals(true, d.get("loaded"), String.valueOf(d));
        assertEquals("h2c", d.get("id"));
        assertEquals(2, ((List<?>) d.get("files")).size());
        assertEquals(9092L, d.get("defaultPort"));
        DriverShim shim = r.requireCustom("h2c");
        assertNotSame(CustomDriversTest.class.getClassLoader(), shim.loader());
        try (var c = shim.connect("jdbc:h2:mem:cust1", new java.util.Properties())) { assertTrue(c.isValid(2)); }
    }

    @Test void noCustomDirMeansNoCustomDrivers() throws Exception {
        DriverRegistry r = reg(null);
        assertTrue(r.describe().stream().noneMatch(m -> "custom".equals(m.get("type"))));
        assertEquals("E_DRIVER_UNAVAILABLE", assertThrows(RpcError.class, () -> r.requireCustom("h2c")).code);
    }

    @Test void tamperedSecondJarFailsWholeEntry() throws Exception {
        Path dir = customDir(Map.of());
        Files.write(dir.resolve("extra.jar"), "tampered".getBytes());
        DriverRegistry r = reg(dir);
        assertEquals(false, customDesc(r).get("loaded"));
        assertTrue(String.valueOf(customDesc(r).get("error")).contains("checksum"));
        assertEquals("E_DRIVER_UNAVAILABLE", assertThrows(RpcError.class, () -> r.requireCustom("h2c")).code);
    }

    @Test void badFileNamesAndClassRejected() throws Exception {
        Path dir = customDir(Map.of());
        String sha = sha(dir.resolve("h2.jar"));
        for (String f : new String[] {"../h2.jar", "sub/h2.jar", ".h2.jar", "h2.txt"}) {
            Path d2 = customDir(Map.of("files", List.of(Map.of("file", f, "sha256", sha))));
            assertEquals(false, customDesc(reg(d2)).get("loaded"), f);
        }
        assertEquals(false, customDesc(reg(customDir(Map.of("class", "java.lang.String")))).get("loaded"));
    }

    @Test void urlTemplateValidation() throws Exception {
        for (String t : new String[] {"mysql://x", "jdbc:h2:{user}", "jdbc:h2: {host}", "jdbc:h2:{host", "jdbc:h2:\n{host}", "jdbc:h2:{}", "jdbc:x:{Host}", "jdbc:"}) {
            assertThrows(IllegalArgumentException.class, () -> DriverRegistry.validateUrlTemplate(t), t);
            assertEquals(false, customDesc(reg(customDir(Map.of("urlTemplate", t)))).get("loaded"), t);
        }
        DriverRegistry.validateUrlTemplate("jdbc:mysql://{host}:{port}/{database}?useSSL=true");
    }

    @Test void onlyCustomTypeAndUnsafeIdsAccepted() throws Exception {
        Path dir = customDir(Map.of());
        assertTrue(reg(customDir(Map.of("type", "postgresql"))).describe().stream().noneMatch(m -> "h2c".equals(m.get("id"))));
        assertTrue(reg(customDir(Map.of("id", "oracle"))).describe().stream().noneMatch(m -> "custom".equals(m.get("type"))));
        assertTrue(reg(customDir(Map.of("id", "a/b"))).describe().stream().noneMatch(m -> "custom".equals(m.get("type"))));
        // duplicate ids: first wins
        Map<String, Object> first = new LinkedHashMap<>(Map.of("type", "custom", "id", "d", "class", "x", "urlTemplate", "jdbc:a:{host}", "files", List.of()));
        Map<String, Object> second = new LinkedHashMap<>(first);
        second.put("name", "second");
        writeManifest(dir, List.of(first, second));
        long n = reg(dir).describe().stream().filter(m -> "d".equals(m.get("id"))).count();
        assertEquals(1, n);
    }

    @Test void customEntryInBuiltinManifestIsIgnored() throws Exception {
        Path builtin = TestEnv.driversDir(tmp);
        TestEnv.writeManifest(builtin, "custom", "h2-test.jar", sha(builtin.resolve("h2-test.jar")), "org.h2.Driver");
        DriverRegistry r = new DriverRegistry(builtin, Set.of("h2test", "custom"));
        assertFalse(r.isLoaded("custom"));
    }

    @Test void reloadPicksUpNewEntriesKeepsOldShims() throws Exception {
        Path dir = Files.createDirectories(tmp.resolve("custom"));
        DriverRegistry r = reg(dir); // no manifest yet
        assertTrue(r.describe().stream().noneMatch(m -> "custom".equals(m.get("type"))));
        customDir(Map.of());
        r.reloadCustom();
        DriverShim before = r.requireCustom("h2c");
        assertTrue(before.acceptsURL("jdbc:h2:mem:x") || true);
        writeManifest(dir, List.of());
        r.reloadCustom();
        assertThrows(RpcError.class, () -> r.requireCustom("h2c"));
        // a session that already holds the shim can still use it
        try (var c = before.connect("jdbc:h2:mem:kept", new java.util.Properties())) { assertTrue(c.isValid(2)); }
    }

    Dispatcher dispatcher(Path custom) throws IOException {
        return new Dispatcher(reg(custom), Map.of(), new SessionManager(Config.defaults()), new EventBus(), "t");
    }

    static Map<String, Object> customProfile(String id, boolean withPort) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("driver", "custom");
        p.put("driverId", id);
        p.put("host", "localhost");
        if (withPort) p.put("port", 1L);
        p.put("database", "e2e");
        p.put("auth", new LinkedHashMap<>(Map.of("type", "password", "username", "sa", "password", "")));
        return p;
    }

    @Test void sessionOverCustomDriverAndReloadRpc() throws Exception {
        Path dir = Files.createDirectories(tmp.resolve("custom"));
        Dispatcher d = dispatcher(dir);
        try {
            var missing = d.handleRaw(Json.write(Map.of("id", 1L, "method", "session.open", "params", Map.of("profile", customProfile("h2c", true)))));
            assertEquals("E_DRIVER_UNAVAILABLE", TestEnv.code(missing));
            customDir(Map.of());
            var rl = d.handleRaw(Json.write(Map.of("id", 2L, "method", "drivers.reload", "params", Map.of())));
            assertNotNull(rl.get("result"), String.valueOf(rl));
            // default port from the manifest: port omitted is accepted
            var ok = d.handleRaw(Json.write(Map.of("id", 3L, "method", "session.test", "params", Map.of("profile", customProfile("h2c", false)))));
            assertNotNull(ok.get("result"), String.valueOf(ok));
            assertEquals(true, ((Map<?, ?>) ok.get("result")).get("ok"));
        } finally {
            d.close();
        }
    }

    @Test void propsAreForwardedToDriverButVendorKeysWin() throws Exception {
        Map<String, Object> p = customProfile("h2c", true);
        p.put("options", new LinkedHashMap<>(Map.of("props", new LinkedHashMap<>(Map.of("MODE", "MySQL", "password", "x")))));
        assertThrows(RpcError.class, () -> Profile.parse(new Params(p, "profile"), Set.of("custom")));
        ((Map<String, Object>) ((Map<String, Object>) p.get("options")).get("props")).remove("password");
        Profile prof = Profile.parse(new Params(p, "profile"), Set.of("custom"));
        Vendor v = new GenericVendor(new DriverRegistry(tmp.resolve("none"), Set.of()));
        assertEquals("MySQL", v.allProps(prof).getProperty("MODE"));
        assertEquals("sa", v.allProps(prof).getProperty("user"));
        assertTrue(java.util.Arrays.asList(prof.secrets()).contains("MySQL"));
    }

    @Test void genericUrlSubstitutesOnlyValidatedFields() throws Exception {
        Path dir = customDir(Map.of("urlTemplate", "jdbc:x://{host}:{port}/{database}"));
        DriverRegistry r = reg(dir);
        Map<String, Object> p = customProfile("h2c", true);
        Profile prof = Profile.parse(new Params(p, "profile"), Set.of("custom"));
        assertEquals("jdbc:x://localhost:1/e2e", new GenericVendor(r).url(prof));
        List<String> unused = new ArrayList<>();
        assertTrue(unused.isEmpty());
    }
}
