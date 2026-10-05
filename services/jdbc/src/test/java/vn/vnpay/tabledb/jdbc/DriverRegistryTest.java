package vn.vnpay.tabledb.jdbc;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class DriverRegistryTest {
    @TempDir Path tmp;

    @Test void goodManifestLoadsThroughShim() throws Exception {
        Path dir = TestEnv.driversDir(tmp);
        DriverRegistry r = new DriverRegistry(dir, Set.of("h2test"));
        assertTrue(r.isLoaded("h2test"));
        DriverShim shim = r.require("h2test");
        // driver lives in its own class loader, not the application loader
        assertNotSame(DriverRegistryTest.class.getClassLoader(), shim.loader());
        assertTrue(shim.acceptsURL("jdbc:h2:mem:x"));
        try (var c = shim.connect("jdbc:h2:mem:regtest", new java.util.Properties())) {
            assertTrue(c.isValid(2));
        }
    }

    @Test void tamperedJarIsNotLoaded() throws Exception {
        Path dir = TestEnv.driversDir(tmp);
        byte[] b = Files.readAllBytes(dir.resolve("h2-test.jar"));
        b[b.length / 2] ^= 0x01; // flip a bit after the manifest recorded the hash
        Files.write(dir.resolve("h2-test.jar"), b);
        DriverRegistry r = new DriverRegistry(dir, Set.of("h2test"));
        assertFalse(r.isLoaded("h2test"));
        RpcError e = assertThrows(RpcError.class, () -> r.require("h2test"));
        assertEquals("E_DRIVER_UNAVAILABLE", e.code);
        assertTrue(e.getMessage().contains("checksum"));
        assertEquals(false, r.describe().get(0).get("loaded"));
    }

    @Test void wrongDeclaredChecksum() throws Exception {
        Path dir = TestEnv.driversDir(tmp);
        TestEnv.writeManifest(dir, "h2test", "h2-test.jar", "0".repeat(64), "org.h2.Driver");
        assertFalse(new DriverRegistry(dir, Set.of("h2test")).isLoaded("h2test"));
    }

    @Test void missingManifestOrFile() throws Exception {
        DriverRegistry none = new DriverRegistry(tmp.resolve("nodir"), Set.of("h2test"));
        assertEquals("E_DRIVER_UNAVAILABLE", assertThrows(RpcError.class, () -> none.require("h2test")).code);
        Path dir = TestEnv.driversDir(tmp);
        Files.delete(dir.resolve("h2-test.jar"));
        assertFalse(new DriverRegistry(dir, Set.of("h2test")).isLoaded("h2test"));
    }

    @Test void pathTraversalAndBadNamesRejected() throws Exception {
        Path dir = TestEnv.driversDir(tmp);
        Path outside = tmp.resolve("evil.jar");
        Files.copy(dir.resolve("h2-test.jar"), outside);
        String sha = Redactor.sha256Hex(Files.readAllBytes(outside));
        for (String f : new String[] {"../evil.jar", "sub/evil.jar", "..\\evil.jar", ".hidden.jar", "x.txt", outside.toString()}) {
            TestEnv.writeManifest(dir, "h2test", f, sha, "org.h2.Driver");
            assertFalse(new DriverRegistry(dir, Set.of("h2test")).isLoaded("h2test"), f);
        }
    }

    @Test void disallowedTypeAndNonDriverClassIgnored() throws Exception {
        Path dir = TestEnv.driversDir(tmp);
        // type not in the allowed set -> ignored
        assertFalse(new DriverRegistry(dir, Set.of("postgresql")).isLoaded("h2test"));
        // class that is not a java.sql.Driver
        String sha = Redactor.sha256Hex(Files.readAllBytes(dir.resolve("h2-test.jar")));
        TestEnv.writeManifest(dir, "h2test", "h2-test.jar", sha, "java.lang.String");
        assertFalse(new DriverRegistry(dir, Set.of("h2test")).isLoaded("h2test"));
    }

    @Test void productionAllowedTypesAreExactlyThree() {
        assertEquals(Set.of("postgresql", "oracle", "trino"), Main.DRIVER_TYPES);
        assertEquals(Main.DRIVER_TYPES, Main.productionVendors(new EventBus()).keySet());
    }

    @Test void missingDriverYieldsErrorOnOpen() throws Exception {
        Path dir = TestEnv.driversDir(tmp);
        Files.delete(dir.resolve("h2-test.jar"));
        // rebuild a dispatcher by hand over the broken dir
        DriverRegistry reg = new DriverRegistry(dir, Set.of("h2test"));
        Dispatcher d = new Dispatcher(reg, Map.of("h2test", new TestEnv.H2Vendor()), new SessionManager(Config.defaults()), new EventBus(), "t");
        try {
            var resp = d.handleRaw(Json.write(Map.of("id", 1L, "method", "session.open", "params", Map.of("profile", TestEnv.profile("x", false)))));
            assertEquals("E_DRIVER_UNAVAILABLE", TestEnv.code(resp));
        } finally {
            d.close();
        }
    }
}
