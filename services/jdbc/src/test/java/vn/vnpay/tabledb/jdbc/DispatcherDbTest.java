package vn.vnpay.tabledb.jdbc;

import static org.junit.jupiter.api.Assertions.*;
import static vn.vnpay.tabledb.jdbc.TestEnv.code;
import static vn.vnpay.tabledb.jdbc.TestEnv.ok;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** DB-facing logic exercised against H2 (test-scope stand-in loaded through the production DriverRegistry path). */
class DispatcherDbTest {
    @TempDir Path tmp;
    TestEnv env;

    @BeforeEach void setUp() throws Exception { env = new TestEnv(tmp); }
    @AfterEach void tearDown() { env.d.close(); }

    @SuppressWarnings("unchecked")
    static List<List<Object>> rows(Map<String, Object> r) { return (List<List<Object>>) r.get("rows"); }

    String seeded() {
        String s = env.open(true);
        ok(env.exec(s, "CREATE TABLE PARENT (ID INT PRIMARY KEY, NAME VARCHAR(50) NOT NULL)", "write", true));
        ok(env.exec(s, "CREATE TABLE CHILD (ID BIGINT PRIMARY KEY, PARENT_ID INT NOT NULL, AMT DECIMAL(12,2), "
                + "CREATED TIMESTAMP, DATA VARBINARY(1000), CONSTRAINT FK_CP FOREIGN KEY (PARENT_ID) REFERENCES PARENT(ID))", "write", true));
        ok(env.exec(s, "INSERT INTO PARENT VALUES (1,'a'),(2,'b')", "write", true));
        return s;
    }

    @Test void openTestClose() {
        Map<String, Object> r = ok(env.rpc("session.open", "profile", TestEnv.profile(TestEnv.newDb(), false)));
        assertTrue(((String) r.get("sessionId")).startsWith("s_"));
        assertNotNull(r.get("serverVersion"));
        assertEquals("SA", r.get("user"));
        assertEquals(true, r.get("readOnly"));
        Map<String, Object> t = ok(env.rpc("session.test", "profile", TestEnv.profile(TestEnv.newDb(), false)));
        assertEquals(true, t.get("ok"));
        assertNotNull(t.get("latencyMs"));
        assertEquals(0, env.d.sessions().sessionCount() - 1);
        ok(env.rpc("session.close", "sessionId", r.get("sessionId")));
        assertEquals("E_NOT_FOUND", code(env.rpc("meta.catalogs", "sessionId", r.get("sessionId"))));
    }

    @Test void closeAllDropsOrphanedSessions() {
        int before = env.d.sessions().sessionCount();
        Map<String, Object> a = ok(env.rpc("session.open", "profile", TestEnv.profile(TestEnv.newDb(), false)));
        ok(env.rpc("session.open", "profile", TestEnv.profile(TestEnv.newDb(), false)));
        assertEquals(before + 2, env.d.sessions().sessionCount());
        assertEquals((long) before + 2, ok(env.rpc("session.closeAll")).get("closed"));
        assertEquals(0, env.d.sessions().sessionCount());
        assertEquals("E_NOT_FOUND", code(env.rpc("meta.catalogs", "sessionId", a.get("sessionId"))));
    }

    @Test void badPasswordIsAuthFailedAndNeverLeaksPassword() {
        String db = TestEnv.newDb();
        ok(env.rpc("session.open", "profile", TestEnv.profile(db, false)));
        Map<String, Object> p = TestEnv.profile(db, false);
        ((Map<String, Object>) p.get("auth")).put("password", "wrong-Password-999");
        Map<String, Object> r = env.rpc("session.open", "profile", p);
        assertEquals("E_AUTH_FAILED", code(r));
        assertFalse(Json.write(r).contains("wrong-Password-999"));
    }

    @Test void readModeEnforcement() {
        String s = seeded();
        assertEquals(List.of(List.of(2L)), rows(ok(env.exec(s, "SELECT COUNT(*) FROM PARENT", "read", false))));
        assertEquals("E_READONLY_VIOLATION", code(env.exec(s, "INSERT INTO PARENT VALUES (3,'c')", "read", true)));
        assertEquals("E_READONLY_VIOLATION", code(env.exec(s, "DROP TABLE PARENT", "read", true)));
        assertEquals("E_READONLY_VIOLATION", code(env.exec(s, "WITH x AS (SELECT 1) DELETE FROM PARENT", "read", false)));
        assertEquals("E_READONLY_VIOLATION", code(env.exec(s, "CALL 1", "read", false)));
        assertEquals("E_BAD_REQUEST", code(env.exec(s, "SELECT 1; DROP TABLE PARENT", "read", false)));
        assertEquals("E_BAD_REQUEST", code(env.exec(s, "SELECT 1; SELECT 2", "write", true)));
        assertEquals("E_BAD_REQUEST", code(env.exec(s, "SELECT 'oops", "read", false)));
        assertEquals("E_BAD_REQUEST", code(env.exec(s, " ; ", "read", false)));
        // table still there
        assertEquals(List.of(List.of(2L)), rows(ok(env.exec(s, "SELECT COUNT(*) FROM PARENT", "read", false))));
    }

    @Test void writeRequiresSessionAllowWriteAndConfirm() {
        String ro = env.open(false);
        assertEquals("E_POLICY", code(env.exec(ro, "CREATE TABLE T1 (A INT)", "write", true)));
        String rw = env.open(true);
        assertEquals("E_POLICY", code(env.exec(rw, "CREATE TABLE T1 (A INT)", "write", false)));
        Map<String, Object> ddl = ok(env.exec(rw, "CREATE TABLE T1 (A INT)", "write", true));
        assertEquals("ddl", ddl.get("kind"));
        assertEquals(0L, ddl.get("updateCount"));
        Map<String, Object> ins = ok(env.exec(rw, "INSERT INTO T1 VALUES (1),(2),(3);", "write", true));
        assertEquals("write", ins.get("kind"));
        assertEquals(3L, ins.get("updateCount"));
        // write-capable session still refuses writes in read mode
        assertEquals("E_READONLY_VIOLATION", code(env.exec(rw, "DELETE FROM T1", "read", true)));
    }

    @Test void valuesAndColumnsEncoding() {
        String s = seeded();
        ok(env.exec(s, "INSERT INTO CHILD VALUES (9007199254740993, 1, 12.50, TIMESTAMP '2024-02-29 10:15:30', X'010203')", "write", true));
        Map<String, Object> r = ok(env.exec(s, "SELECT ID, PARENT_ID, AMT, CREATED, DATA, NULL AS N FROM CHILD", "read", false));
        List<Object> row = rows(r).get(0);
        assertEquals("9007199254740993", row.get(0));
        assertEquals(1L, row.get(1));
        assertEquals("12.50", row.get(2));
        assertEquals("2024-02-29T10:15:30", row.get(3));
        assertEquals(Map.of("$binary", "AQID", "length", 3L), row.get(4));
        assertNull(row.get(5));
        @SuppressWarnings("unchecked") List<Map<String, Object>> cols = (List<Map<String, Object>>) r.get("columns");
        assertEquals("ID", cols.get(0).get("name"));
        assertNotNull(cols.get(0).get("typeName"));
        assertNotNull(cols.get(0).get("jdbcType"));
        assertEquals(false, r.get("hasMore"));
        assertEquals(false, r.get("truncated"));
        assertEquals(1L, r.get("rowCount"));
        assertNull(r.get("cursorId"));
    }

    @Test void pagingCursorAndMaxRows() {
        String s = env.open(false);
        Map<String, Object> r = ok(env.rpc("query.execute", "sessionId", s, "queryId", "p1", "mode", "read",
                "sql", "SELECT X FROM SYSTEM_RANGE(1, 25)", "pageSize", 10L, "maxRows", 100L));
        assertEquals(10, rows(r).size());
        assertEquals(true, r.get("hasMore"));
        String cid = (String) r.get("cursorId");
        assertNotNull(cid);
        Map<String, Object> f = ok(env.rpc("query.fetch", "cursorId", cid, "count", 10L));
        assertEquals(10, rows(f).size());
        assertEquals(11L, rows(f).get(0).get(0));
        assertEquals(true, f.get("hasMore"));
        f = ok(env.rpc("query.fetch", "cursorId", cid));
        assertEquals(5, rows(f).size());
        assertEquals(false, f.get("hasMore"));
        assertEquals(false, f.get("truncated"));
        assertEquals("E_NOT_FOUND", code(env.rpc("query.fetch", "cursorId", cid)));

        // total capped by maxRows across pages -> truncated
        r = ok(env.rpc("query.execute", "sessionId", s, "queryId", "p2", "mode", "read",
                "sql", "SELECT X FROM SYSTEM_RANGE(1, 25)", "pageSize", 10L, "maxRows", 15L));
        String c2 = (String) r.get("cursorId");
        f = ok(env.rpc("query.fetch", "cursorId", c2, "count", 100L));
        assertEquals(5, rows(f).size());
        assertEquals(false, f.get("hasMore"));
        assertEquals(true, f.get("truncated"));

        // single page truncated
        r = ok(env.rpc("query.execute", "sessionId", s, "queryId", "p3", "mode", "read",
                "sql", "SELECT X FROM SYSTEM_RANGE(1, 25)", "maxRows", 7L));
        assertEquals(7, rows(r).size());
        assertEquals(true, r.get("truncated"));
        assertEquals(false, r.get("hasMore"));

        // exactly maxRows rows is NOT truncated
        r = ok(env.rpc("query.execute", "sessionId", s, "queryId", "p4", "mode", "read",
                "sql", "SELECT X FROM SYSTEM_RANGE(1, 7)", "maxRows", 7L));
        assertEquals(false, r.get("truncated"));
    }

    @Test void maxRowsIsCapped() {
        String s = env.open(false);
        Map<String, Object> r = ok(env.rpc("query.execute", "sessionId", s, "queryId", "cap", "mode", "read",
                "sql", "SELECT 1", "maxRows", 10_000_000L, "timeoutSec", 99_999L));
        assertEquals(1, rows(r).size());
        assertEquals("E_BAD_REQUEST", code(env.rpc("query.execute", "sessionId", s, "queryId", "cap2", "mode", "read", "sql", "SELECT 1", "maxRows", 0L)));
    }

    @Test void closeCursorFreesIt() {
        String s = env.open(false);
        Map<String, Object> r = ok(env.rpc("query.execute", "sessionId", s, "queryId", "cc", "mode", "read",
                "sql", "SELECT X FROM SYSTEM_RANGE(1, 25)", "pageSize", 5L));
        String cid = (String) r.get("cursorId");
        ok(env.rpc("query.closeCursor", "cursorId", cid));
        assertEquals("E_NOT_FOUND", code(env.rpc("query.fetch", "cursorId", cid)));
    }

    @Test void cursorLimit() throws Exception {
        try (TestEnvHolder h = new TestEnvHolder(tmp.resolve("lim"), new Config(5, 2, 100, 1800, 600, 3600))) {
            String s = h.env.open(false);
            for (int i = 0; i < 2; i++)
                ok(h.env.rpc("query.execute", "sessionId", s, "queryId", "l" + i, "mode", "read", "sql", "SELECT X FROM SYSTEM_RANGE(1,50)", "pageSize", 5L));
            assertEquals("E_LIMIT", code(h.env.rpc("query.execute", "sessionId", s, "queryId", "l9", "mode", "read", "sql", "SELECT 1")));
        }
    }

    @Test void sessionLimit() throws Exception {
        try (TestEnvHolder h = new TestEnvHolder(tmp.resolve("lim2"), new Config(1, 2, 100, 1800, 600, 3600))) {
            h.env.open(false);
            assertEquals("E_LIMIT", code(h.env.rpc("session.open", "profile", TestEnv.profile(TestEnv.newDb(), false))));
        }
    }

    @Test void idleReaperClosesIdleSessionsOnly() throws Exception {
        try (TestEnvHolder h = new TestEnvHolder(tmp.resolve("idle"), new Config(5, 2, 100, 1, 600, 3600))) {
            String s = h.env.open(false);
            assertEquals(1, h.env.d.sessions().sessionCount());
            h.env.d.sessions().reapOnce(System.nanoTime()); // not idle yet
            assertEquals(1, h.env.d.sessions().sessionCount());
            h.env.d.sessions().reapOnce(System.nanoTime() + TimeUnit.SECONDS.toNanos(5));
            assertEquals(0, h.env.d.sessions().sessionCount());
            assertEquals("E_NOT_FOUND", code(h.env.rpc("meta.catalogs", "sessionId", s)));
        }
    }

    @Test void timeoutMapsToETimeout() {
        String s = env.open(false);
        long t0 = System.nanoTime();
        Map<String, Object> r = env.rpc("query.execute", "sessionId", s, "queryId", "slow", "mode", "read",
                "sql", "SELECT MAX(A.X * B.X) FROM SYSTEM_RANGE(1, 200000) A, SYSTEM_RANGE(1, 200000) B", "timeoutSec", 1L);
        assertEquals("E_TIMEOUT", code(r));
        assertTrue(TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - t0) < 20);
    }

    @Test void cancelMapsToECancelled() throws Exception {
        String s = env.open(false);
        CompletableFuture<Map<String, Object>> f = CompletableFuture.supplyAsync(() -> env.rpc("query.execute", "sessionId", s,
                "queryId", "victim", "mode", "read", "sql", "SELECT MAX(A.X * B.X) FROM SYSTEM_RANGE(1, 200000) A, SYSTEM_RANGE(1, 200000) B", "timeoutSec", 120L));
        boolean cancelled = false;
        for (int i = 0; i < 50 && !cancelled; i++) {
            Thread.sleep(100);
            cancelled = (Boolean) ok(env.rpc("query.cancel", "queryId", "victim")).get("cancelled");
        }
        assertTrue(cancelled);
        assertEquals("E_CANCELLED", code(f.get(30, TimeUnit.SECONDS)));
        assertEquals(false, ok(env.rpc("query.cancel", "queryId", "victim")).get("cancelled"));
        // session still usable
        assertEquals(1, rows(ok(env.exec(s, "SELECT 1", "read", false))).size());
    }

    @Test void sqlErrorMapsToESql() {
        String s = env.open(false);
        Map<String, Object> r = env.exec(s, "SELECT * FROM NO_SUCH_TABLE", "read", false);
        assertEquals("E_SQL", code(r));
        @SuppressWarnings("unchecked") Map<String, Object> e = (Map<String, Object>) r.get("error");
        assertTrue(String.valueOf(e.get("sqlState")).startsWith("42S"), String.valueOf(e.get("sqlState")));
    }

    @Test void metadata() {
        String s = seeded();
        assertFalse(((List<?>) ok(env.rpc("meta.catalogs", "sessionId", s)).get("catalogs")).isEmpty());
        @SuppressWarnings("unchecked") List<String> schemas = (List<String>) ok(env.rpc("meta.schemas", "sessionId", s)).get("schemas");
        assertTrue(schemas.contains("PUBLIC"));
        @SuppressWarnings("unchecked") List<Map<String, Object>> tables = (List<Map<String, Object>>) ok(env.rpc("meta.tables", "sessionId", s, "schema", "PUBLIC")).get("tables");
        assertEquals(List.of("CHILD", "PARENT"), tables.stream().map(t -> t.get("name")).toList());
        assertEquals("BASE TABLE", tables.get(0).get("type").toString().replace("TABLE", "BASE TABLE").replace("BASE BASE", "BASE"));

        Map<String, Object> c = ok(env.rpc("meta.columns", "sessionId", s, "schema", "PUBLIC", "table", "CHILD"));
        @SuppressWarnings("unchecked") List<Map<String, Object>> cols = (List<Map<String, Object>>) c.get("columns");
        assertEquals(List.of("ID", "PARENT_ID", "AMT", "CREATED", "DATA"), cols.stream().map(x -> x.get("name")).toList());
        assertEquals(false, cols.get(0).get("nullable"));
        assertEquals(1L, cols.get(0).get("position"));
        assertEquals(12L, cols.get(2).get("size"));
        assertEquals(2L, cols.get(2).get("scale"));
        assertEquals(List.of("ID"), c.get("primaryKey"));
        @SuppressWarnings("unchecked") List<Map<String, Object>> fks = (List<Map<String, Object>>) c.get("foreignKeys");
        assertEquals(1, fks.size());
        assertEquals(List.of("PARENT_ID"), fks.get(0).get("columns"));
        assertEquals("PARENT", fks.get(0).get("refTable"));
        assertEquals(List.of("ID"), fks.get(0).get("refColumns"));
        assertEquals("FK_CP", fks.get(0).get("name"));

        assertEquals("E_NOT_FOUND", code(env.rpc("meta.columns", "sessionId", s, "schema", "PUBLIC", "table", "NOPE")));
        assertEquals("E_NOT_FOUND", code(env.rpc("meta.ddl", "sessionId", s, "schema", "PUBLIC", "table", "NOPE")));
        assertEquals("E_BAD_REQUEST", code(env.rpc("meta.tables", "sessionId", s, "schema", "PUBLIC", "types", List.of("TABLE;DROP"))));
    }

    @Test void synthesizedDdl() {
        String s = seeded();
        Map<String, Object> d = ok(env.rpc("meta.ddl", "sessionId", s, "schema", "PUBLIC", "table", "CHILD"));
        assertEquals("synthesized", d.get("source"));
        String ddl = (String) d.get("ddl");
        assertTrue(ddl.startsWith("CREATE TABLE \"PUBLIC\".\"CHILD\" ("), ddl);
        assertTrue(ddl.contains("\"ID\" BIGINT NOT NULL"), ddl);
        assertTrue(ddl.contains("PRIMARY KEY (\"ID\")"), ddl);
        assertTrue(ddl.contains("CONSTRAINT \"FK_CP\" FOREIGN KEY (\"PARENT_ID\") REFERENCES \"PUBLIC\".\"PARENT\" (\"ID\")"), ddl);
    }

    @Test void fingerprintStableAndChangesWithSchema() {
        String s = seeded();
        String f1 = (String) ok(env.rpc("meta.fingerprint", "sessionId", s, "schema", "PUBLIC")).get("fingerprint");
        String f2 = (String) ok(env.rpc("meta.fingerprint", "sessionId", s, "schema", "PUBLIC")).get("fingerprint");
        assertEquals(64, f1.length());
        assertEquals(f1, f2);
        ok(env.exec(s, "ALTER TABLE PARENT ADD COLUMN EXTRA INT", "write", true));
        assertNotEquals(f1, ok(env.rpc("meta.fingerprint", "sessionId", s, "schema", "PUBLIC")).get("fingerprint"));
    }

    @Test void underscoreInSchemaAndTableIsNotAWildcard() {
        String s = env.open(true);
        ok(env.exec(s, "CREATE TABLE ABC (A INT)", "write", true));
        ok(env.exec(s, "CREATE TABLE A_C (A INT)", "write", true));
        @SuppressWarnings("unchecked") List<Map<String, Object>> cols = (List<Map<String, Object>>) ok(env.rpc("meta.columns", "sessionId", s, "schema", "PUBLIC", "table", "A_C")).get("columns");
        assertEquals(1, cols.size());
    }

    @Test void diagProxyDirectAndValidation() throws Exception {
        try (var ss = new java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) {
            Map<String, Object> ok = ok(env.rpc("diag.proxy", "host", "127.0.0.1", "port", (long) ss.getLocalPort()));
            assertEquals(true, ok.get("reachable"));
            assertNotNull(ok.get("latencyMs"));
        }
        int closed;
        try (var ss = new java.net.ServerSocket(0)) { closed = ss.getLocalPort(); }
        Map<String, Object> bad = ok(env.rpc("diag.proxy", "host", "127.0.0.1", "port", (long) closed));
        assertEquals(false, bad.get("reachable"));
        assertNotNull(bad.get("error"));
        assertEquals("E_BAD_REQUEST", code(env.rpc("diag.proxy", "host", "a/b", "port", 80L)));
        assertEquals("E_BAD_REQUEST", code(env.rpc("diag.proxy", "host", "h", "port", 0L)));
    }

    @Test void diagProxyThroughHttpConnectProxy() throws Exception {
        try (var target = new java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress());
             var proxy = new java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) {
            Thread t = Thread.ofVirtual().start(() -> {
                try (var c = proxy.accept()) {
                    var in = new java.io.BufferedReader(new java.io.InputStreamReader(c.getInputStream()));
                    String line = in.readLine();
                    boolean good = line != null && line.startsWith("CONNECT 127.0.0.1:" + target.getLocalPort());
                    c.getOutputStream().write((good ? "HTTP/1.1 200 Connection established\r\n\r\n" : "HTTP/1.1 403 Forbidden\r\n\r\n").getBytes());
                    c.getOutputStream().flush();
                } catch (java.io.IOException ignored) { }
            });
            Map<String, Object> px = new LinkedHashMap<>(Map.of("type", "http", "host", "127.0.0.1", "port", (long) proxy.getLocalPort()));
            Map<String, Object> r = ok(env.rpc("diag.proxy", "host", "127.0.0.1", "port", (long) target.getLocalPort(), "proxy", px));
            assertEquals(true, r.get("reachable"), r.toString());
            t.join(2000);
        }
    }

    /** Holder giving each test its own env with custom Config. */
    static final class TestEnvHolder implements AutoCloseable {
        final TestEnv env;
        TestEnvHolder(Path dir, Config cfg) throws Exception {
            java.nio.file.Files.createDirectories(dir);
            env = new TestEnv(dir, cfg);
        }
        @Override public void close() { env.d.close(); }
    }
}
