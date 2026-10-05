package vn.vnpay.tabledb.jdbc;

import static org.junit.jupiter.api.Assertions.*;
import static vn.vnpay.tabledb.jdbc.TestEnv.code;
import static vn.vnpay.tabledb.jdbc.TestEnv.ok;

import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Manual transactions, bind parameters, plans, schema switch and LOB limits (against H2). */
class DispatcherFeaturesTest {
    @TempDir Path tmp;
    TestEnv env;

    @BeforeEach void setUp() throws Exception { env = new TestEnv(tmp); }
    @AfterEach void tearDown() { env.d.close(); }

    @SuppressWarnings("unchecked")
    static List<List<Object>> rows(Map<String, Object> r) { return (List<List<Object>>) r.get("rows"); }

    String openOn(String db, boolean allowWrite) {
        return (String) ok(env.rpc("session.open", "profile", TestEnv.profile(db, allowWrite))).get("sessionId");
    }

    long count(String sid) {
        return ((Number) rows(ok(env.exec(sid, "SELECT COUNT(*) FROM T", "read", false))).get(0).get(0)).longValue();
    }

    @Test void manualCommitRollbackAndIsolation() {
        String db = TestEnv.newDb();
        String a = openOn(db, true), b = openOn(db, true);
        ok(env.exec(a, "CREATE TABLE T (ID INT PRIMARY KEY)", "write", true));

        Map<String, Object> st = ok(env.rpc("tx.setAutoCommit", "sessionId", a, "autoCommit", false));
        assertEquals(false, st.get("autoCommit"));
        assertEquals(false, st.get("txPending"));

        Map<String, Object> ins = ok(env.exec(a, "INSERT INTO T VALUES (1)", "write", true));
        assertEquals(true, ins.get("txPending"));
        assertEquals(false, ins.get("autoCommit"));
        assertEquals(1L, count(a));          // own uncommitted row
        assertEquals(0L, count(b));          // not visible elsewhere

        // switching back to auto-commit would commit implicitly: refused while changes are pending
        assertEquals("E_POLICY", code(env.rpc("tx.setAutoCommit", "sessionId", a, "autoCommit", true)));

        assertEquals(false, ok(env.rpc("tx.rollback", "sessionId", a)).get("txPending"));
        assertEquals(0L, count(a));

        ok(env.exec(a, "INSERT INTO T VALUES (2)", "write", true));
        ok(env.rpc("tx.commit", "sessionId", a));
        assertEquals(1L, count(b));

        // reads in read mode stay read-only inside a manual transaction
        assertEquals("E_READONLY_VIOLATION", code(env.exec(a, "DELETE FROM T", "read", false)));
        assertEquals(true, ok(env.rpc("tx.setAutoCommit", "sessionId", a, "autoCommit", true)).get("autoCommit"));
        assertEquals("E_POLICY", code(env.rpc("tx.commit", "sessionId", a)));
    }

    @Test void closingASessionRollsBackPendingWork() {
        String db = TestEnv.newDb();
        String a = openOn(db, true), b = openOn(db, true);
        ok(env.exec(a, "CREATE TABLE T (ID INT)", "write", true));
        ok(env.rpc("tx.setAutoCommit", "sessionId", a, "autoCommit", false));
        ok(env.exec(a, "INSERT INTO T VALUES (1)", "write", true));
        ok(env.rpc("session.close", "sessionId", a));
        assertEquals(0L, count(b));
    }

    @Test void manualCommitNeedsWriteSession() {
        String ro = env.open(false);
        assertEquals("E_POLICY", code(env.rpc("tx.setAutoCommit", "sessionId", ro, "autoCommit", false)));
        assertEquals("E_BAD_REQUEST", code(env.rpc("tx.setAutoCommit", "sessionId", ro)));
    }

    @Test void bindParameters() {
        String s = env.open(false);
        Map<String, Object> r = ok(env.rpc("query.execute", "sessionId", s, "queryId", "b1", "mode", "read",
                "sql", "SELECT CAST(? AS INT) + 1, ?, ?, CAST(? AS DATE)",
                "params", List.of(Map.of("type", "number", "value", "41"), Map.of("type", "string", "value", "x'y"),
                        Map.of("type", "null"), Map.of("type", "date", "value", "2024-02-29"))));
        List<Object> row = rows(r).get(0);
        assertEquals(42L, ((Number) row.get(0)).longValue());
        assertEquals("x'y", row.get(1));
        assertNull(row.get(2));
        assertEquals("2024-02-29", row.get(3));

        assertEquals("E_BAD_REQUEST", code(env.rpc("query.execute", "sessionId", s, "queryId", "b2", "mode", "read", "sql", "SELECT ?",
                "params", List.of(Map.of("type", "number", "value", "abc")))));
        assertEquals("E_BAD_REQUEST", code(env.rpc("query.execute", "sessionId", s, "queryId", "b3", "mode", "read", "sql", "SELECT ?",
                "params", List.of(Map.of("type", "exec", "value", "1")))));
        assertEquals("E_BAD_REQUEST", code(env.rpc("query.execute", "sessionId", s, "queryId", "b4", "mode", "read", "sql", "SELECT ?",
                "params", List.of(Map.of("type", "string")))));
        // bound values never turn a read into a write
        assertEquals("E_READONLY_VIOLATION", code(env.rpc("query.execute", "sessionId", s, "queryId", "b5", "mode", "read",
                "sql", "DELETE FROM T WHERE ID = ?", "params", List.of(Map.of("type", "number", "value", "1")))));
    }

    @Test void planOnlyForQueries() {
        String s = env.open(true);
        ok(env.exec(s, "CREATE TABLE T (ID INT PRIMARY KEY)", "write", true));
        Map<String, Object> p = ok(env.rpc("query.plan", "sessionId", s, "sql", "SELECT * FROM T WHERE ID = 1"));
        assertEquals("text", p.get("format"));
        assertTrue(((String) p.get("text")).toUpperCase().contains("T"));
        // the generic vendor does not know whether EXPLAIN executes DML: refused
        assertEquals("E_BAD_REQUEST", code(env.rpc("query.plan", "sessionId", s, "sql", "DELETE FROM T")));
        assertEquals("E_BAD_REQUEST", code(env.rpc("query.plan", "sessionId", s, "sql", "DROP TABLE T")));
        assertEquals("E_BAD_REQUEST", code(env.rpc("query.plan", "sessionId", s, "sql", "SELECT 1; DROP TABLE T")));
        assertEquals("E_BAD_REQUEST", code(env.rpc("query.plan", "sessionId", s, "sql", "EXPLAIN SELECT 1")));
        assertEquals(0L, count(s)); // table still there
    }

    @Test void setSchema() {
        String s = env.open(true);
        Map<String, Object> open = ok(env.rpc("session.open", "profile", TestEnv.profile(TestEnv.newDb(), false)));
        assertEquals("PUBLIC", open.get("schema"));
        assertEquals(true, open.get("autoCommit"));
        ok(env.exec(s, "CREATE SCHEMA S2", "write", true));
        ok(env.exec(s, "CREATE TABLE S2.T (ID INT)", "write", true));
        assertEquals("S2", ok(env.rpc("session.setSchema", "sessionId", s, "schema", "S2")).get("schema"));
        assertEquals(0L, count(s)); // unqualified T resolves in S2
        assertNotNull(code(env.rpc("session.setSchema", "sessionId", s, "schema", "NOPE_" + "X")));
        assertEquals("E_BAD_REQUEST", code(env.rpc("session.setSchema", "sessionId", s, "schema", "")));
    }

    @Test void lobLimitReturnsFullBinary() {
        String s = env.open(true);
        ok(env.exec(s, "CREATE TABLE B (ID INT, DATA VARBINARY(4000))", "write", true));
        ok(env.exec(s, "INSERT INTO B VALUES (1, X'" + "AB".repeat(1000) + "')", "write", true));
        @SuppressWarnings("unchecked") Map<String, Object> preview = (Map<String, Object>) rows(ok(env.exec(s, "SELECT DATA FROM B", "read", false))).get(0).get(0);
        assertEquals(256, Base64.getDecoder().decode((String) preview.get("$binary")).length);
        assertEquals(1000L, preview.get("length"));
        Map<String, Object> r = ok(env.rpc("query.execute", "sessionId", s, "queryId", "l1", "mode", "read", "sql", "SELECT DATA FROM B", "lobLimit", 4096L));
        @SuppressWarnings("unchecked") Map<String, Object> full = (Map<String, Object>) rows(r).get(0).get(0);
        assertEquals(1000, Base64.getDecoder().decode((String) full.get("$binary")).length);
        assertEquals("E_BAD_REQUEST", code(env.rpc("query.execute", "sessionId", s, "queryId", "l2", "mode", "read", "sql", "SELECT 1", "lobLimit", 99_999_999L)));
    }

    @Test void updateCountResultHasNoFurtherResults() {
        String s = env.open(true);
        Map<String, Object> r = ok(env.exec(s, "CREATE TABLE T (ID INT)", "write", true));
        assertNull(r.get("moreResults"));
        assertEquals(true, r.get("autoCommit"));
        assertEquals(false, r.get("txPending"));
    }
}
