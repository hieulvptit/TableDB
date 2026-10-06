package vn.vnpay.tabledb.jdbc;

import static org.junit.jupiter.api.Assertions.*;
import static vn.vnpay.tabledb.jdbc.TestEnv.ok;
import static vn.vnpay.tabledb.jdbc.TestEnv.code;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class CursorLifecycleTest {
    @TempDir Path tmp;

    @Test void exactJsonBudgetPreservesRowsAcrossUnicodeAndEscapedPages() throws Exception {
        TestEnv env = new TestEnv(tmp);
        try {
            Session s = env.d.sessions().get(env.open(false));
            Statement st = s.conn.createStatement();
            ResultSet rs = st.executeQuery("SELECT X, REPEAT(CASE WHEN MOD(X, 2)=0 THEN CHAR(1) ELSE '界' END, 400000) FROM SYSTEM_RANGE(1, 5)");
            Cursor c = new Cursor("budget", s, st, rs, 10, 5);
            int expected = 1;
            boolean more;
            do {
                Cursor.Page page = c.fetch(5);
                assertTrue(Json.write(page.rows()).getBytes(StandardCharsets.UTF_8).length <= Cursor.PAGE_BYTE_BUDGET);
                for (List<Object> row : page.rows()) assertEquals(expected++, ((Number) row.get(0)).intValue());
                more = page.hasMore();
            } while (more);
            assertEquals(6, expected);
            assertTrue(c.isClosed());
        } finally { env.d.close(); }
    }

    @Test void singleOversizedRowClosesCursorWithExplicitError() throws Exception {
        TestEnv env = new TestEnv(tmp);
        try {
            Session s = env.d.sessions().get(env.open(false));
            Statement st = s.conn.createStatement();
            Cursor c = new Cursor("too-wide", s, st, st.executeQuery("SELECT REPEAT(CHAR(1), 800000), REPEAT(CHAR(1), 800000)"), 10, 5);
            RpcError e = assertThrows(RpcError.class, () -> c.fetch(5));
            assertEquals("E_LIMIT", e.code);
            assertEquals(0, c.delivered());
            assertTrue(c.isClosed());
        } finally { env.d.close(); }
    }

    @Test void oversizedRequestIdIsRejectedBeforeCursorAdvances() throws Exception {
        TestEnv env = new TestEnv(tmp);
        try {
            Session s = env.d.sessions().get(env.open(false));
            Statement st = s.conn.createStatement();
            Cursor c = new Cursor("id-budget", s, st, st.executeQuery("SELECT 1"), 10, 5);
            env.d.sessions().registerCursor(c);
            Map<String, Object> response = env.d.handle(Map.of("id", "x".repeat(1024), "method", "query.fetch", "params", Map.of("cursorId", c.id)));
            assertEquals("E_BAD_REQUEST", code(response));
            assertNull(response.get("id"));
            assertEquals(0, c.delivered());
            assertFalse(c.isClosed());
            ok(env.rpc("query.fetch", "cursorId", c.id));
        } finally { env.d.close(); }
    }

    @Test void oversizedColumnEnvelopeClosesHandedOffCursor() throws Exception {
        TestEnv env = new TestEnv(tmp);
        try {
            Session original = env.d.sessions().get(env.open(false));
            Statement originalSt = original.conn.createStatement();
            ResultSet originalRs = originalSt.executeQuery("SELECT X FROM SYSTEM_RANGE(1, 2)");
            java.sql.ResultSetMetaData md = originalRs.getMetaData();
            java.sql.ResultSetMetaData wideMd = (java.sql.ResultSetMetaData) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{java.sql.ResultSetMetaData.class}, (proxy, method, args) -> {
                if (method.getName().equals("getColumnLabel")) return "x".repeat(StdioServer.MAX_LINE);
                try { return method.invoke(md, args); } catch (InvocationTargetException e) { throw e.getCause(); }
            });
            ResultSet rs = (ResultSet) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{ResultSet.class}, (proxy, method, args) -> {
                if (method.getName().equals("getMetaData")) return wideMd;
                try { return method.invoke(originalRs, args); } catch (InvocationTargetException e) { throw e.getCause(); }
            });
            Statement st = (Statement) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Statement.class}, (proxy, method, args) -> {
                if (method.getName().equals("execute")) return true;
                if (method.getName().equals("getResultSet")) return rs;
                try { return method.invoke(originalSt, args); } catch (InvocationTargetException e) { throw e.getCause(); }
            });
            java.sql.Connection conn = (java.sql.Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{java.sql.Connection.class}, (proxy, method, args) -> {
                if (method.getName().equals("createStatement")) return st;
                try { return method.invoke(original.conn, args); } catch (InvocationTargetException e) { throw e.getCause(); }
            });
            Session wide = new Session("wide-columns", original.profile, original.vendor, conn, null, null);
            env.d.sessions().reserve();
            env.d.sessions().register(wide);
            assertEquals("E_LIMIT", code(env.rpc("query.execute", "sessionId", wide.id, "queryId", "wide", "mode", "read", "sql", "SELECT 1", "pageSize", 1L)));
            assertTrue(wide.cursors.isEmpty());
            assertTrue(originalSt.isClosed());
        } finally { env.d.close(); }
    }

    @Test void additionalResultsShareOneSerializedByteBudget() throws Exception {
        TestEnv env = new TestEnv(tmp);
        try {
            Session s = env.d.sessions().get(env.open(false));
            Statement a = s.conn.createStatement(), b = s.conn.createStatement();
            ResultSet[] results = {a.executeQuery("SELECT REPEAT('界', 100000)"), b.executeQuery("SELECT REPEAT('界', 100000)")};
            java.util.concurrent.atomic.AtomicInteger index = new java.util.concurrent.atomic.AtomicInteger(-1);
            Statement st = (Statement) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Statement.class}, (proxy, method, args) -> switch (method.getName()) {
                case "getMoreResults" -> index.incrementAndGet() < results.length;
                case "getResultSet" -> results[index.get()];
                case "getUpdateCount" -> -1;
                default -> throw new UnsupportedOperationException(method.getName());
            });
            java.lang.reflect.Method more = Dispatcher.class.getDeclaredMethod("moreResults", Session.class, Statement.class, int.class, int.class, ValueEncoder.Limits.class, long.class);
            more.setAccessible(true);
            InvocationTargetException e = assertThrows(InvocationTargetException.class,
                () -> more.invoke(env.d, s, st, 10, 10, ValueEncoder.Limits.DEFAULT, 450000L));
            assertInstanceOf(RpcError.class, e.getCause());
            assertEquals("E_LIMIT", ((RpcError) e.getCause()).code);
            assertTrue(results[0].isClosed());
            assertTrue(results[1].isClosed());
            a.close(); b.close();
        } finally { env.d.close(); }
    }

    @Test void reaperDoesNotRemoveLockedSession() throws Exception {
        TestEnv env = new TestEnv(tmp);
        try {
            Session s = env.d.sessions().get(env.open(false));
            s.lastUsed = System.nanoTime() - TimeUnit.HOURS.toNanos(2);
            s.lock.lock();
            try {
                CompletableFuture.runAsync(() -> env.d.sessions().reapOnce(System.nanoTime())).get(2, TimeUnit.SECONDS);
                assertSame(s, env.d.sessions().get(s.id));
                assertFalse(s.closed);
            } finally { s.lock.unlock(); }
        } finally { env.d.close(); }
    }

    @Test void cancellationOvertakesBlockedFetchAndReleasesSession() throws Exception {
        TestEnv env = new TestEnv(tmp);
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        try {
            Session s = env.d.sessions().get(env.open(false));
            Statement original = s.conn.createStatement();
            ResultSet originalRs = original.executeQuery("SELECT 1");
            Statement st = (Statement) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Statement.class}, (proxy, method, args) -> {
                if (method.getName().equals("cancel")) { release.countDown(); return null; }
                try { return method.invoke(original, args); } catch (InvocationTargetException e) { throw e.getCause(); }
            });
            ResultSet rs = (ResultSet) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{ResultSet.class}, (proxy, method, args) -> {
                if (method.getName().equals("next")) {
                    entered.countDown();
                    if (!release.await(5, TimeUnit.SECONDS)) throw new java.sql.SQLException("fetch remained blocked");
                }
                try { return method.invoke(originalRs, args); } catch (InvocationTargetException e) { throw e.getCause(); }
            });
            Cursor c = new Cursor("blocked-fetch", s, st, rs, 10, 5);
            env.d.sessions().registerCursor(c);
            CompletableFuture<Map<String, Object>> response = CompletableFuture.supplyAsync(() -> env.rpc("query.fetch", "cursorId", c.id));
            assertTrue(entered.await(5, TimeUnit.SECONDS));
            assertEquals(true, ok(env.rpc("query.cancel", "cursorId", c.id)).get("cancelled"));
            assertEquals("E_CANCELLED", code(response.get(5, TimeUnit.SECONDS)));
            assertTrue(c.isClosed());
            assertEquals("E_NOT_FOUND", code(env.rpc("query.fetch", "cursorId", c.id)));
            ok(env.rpc("meta.catalogs", "sessionId", s.id));
        } finally { release.countDown(); env.d.close(); }
    }
}
