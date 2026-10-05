package vn.vnpay.tabledb.jdbc;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class SqlClassifierTest {
    static Path vectors() {
        Path p = Paths.get("").toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("packages/shared/testdata/sql-classify.json"))) p = p.getParent();
        assertNotNull(p, "shared test vectors not found above " + Paths.get("").toAbsolutePath());
        return p.resolve("packages/shared/testdata/sql-classify.json");
    }

    @Test
    void sharedVectors() throws Exception {
        Map<String, Object> doc = Json.parseObject(Files.readString(vectors()));
        @SuppressWarnings("unchecked") List<Map<String, Object>> cases = (List<Map<String, Object>>) doc.get("cases");
        assertTrue(cases.size() >= 30);
        int n = 0;
        for (Map<String, Object> c : cases) {
            String sql = (String) c.get("sql");
            SqlClassifier.Result r = SqlClassifier.classify(sql);
            assertEquals(c.get("kind"), r.kindName(), "kind of: " + sql);
            assertEquals(c.get("multi"), r.multi(), "multi of: " + sql);
            n++;
        }
        assertEquals(cases.size(), n);
    }

    @Test
    void tokenizerIgnoresLiteralsCommentsAndQuotedIdentifiers() {
        assertEquals("read", SqlClassifier.classify("SELECT $$; DROP TABLE t$$").kindName());
        assertFalse(SqlClassifier.classify("SELECT $tag$ ; delete $tag$").multi());
        assertEquals("read", SqlClassifier.classify("SELECT /* a /* nested */ delete */ 1").kindName());
        assertEquals("read", SqlClassifier.classify("SELECT E'it\\'s; DROP' AS x").kindName());
        assertFalse(SqlClassifier.classify("SELECT E'it\\'s; DROP' AS x").multi());
        assertEquals("read", SqlClassifier.classify("SELECT q'[a;b'c]' FROM dual").kindName());
        assertEquals("read", SqlClassifier.classify("SELECT \"a;b\" FROM \"insert\"").kindName());
        assertEquals("read", SqlClassifier.classify("SELECT 1 -- ; DROP TABLE t").kindName());
        assertTrue(SqlClassifier.classify("SELECT 1; -- c\nSELECT 2").multi());
        assertEquals("read", SqlClassifier.classify("(SELECT 1)").kindName());
    }

    @Test
    void unterminatedConstructsAreMalformed() {
        assertTrue(SqlClassifier.classify("SELECT 'abc").malformed());
        assertTrue(SqlClassifier.classify("SELECT 1 /* x").malformed());
        assertTrue(SqlClassifier.classify("SELECT \"abc").malformed());
        assertTrue(SqlClassifier.classify("SELECT $$abc").malformed());
        assertFalse(SqlClassifier.classify("SELECT 'a''b'").malformed());
    }

    @Test
    void writeAndLockingVariants() {
        assertEquals("write", SqlClassifier.classify("SELECT * FROM t FOR SHARE").kindName());
        assertEquals("write", SqlClassifier.classify("with x as (select 1) update t set a=1").kindName());
        assertEquals("read", SqlClassifier.classify("EXPLAIN (FORMAT JSON) SELECT 1").kindName());
        assertEquals("write", SqlClassifier.classify("EXPLAIN (ANALYZE, BUFFERS) DELETE FROM t").kindName());
        assertEquals("other", SqlClassifier.classify("EXPLAIN PLAN FOR DELETE FROM t").kindName());
        assertEquals("other", SqlClassifier.classify("DECLARE x int; BEGIN NULL; END;").kindName());
        assertFalse(SqlClassifier.classify("DECLARE x int; BEGIN NULL; END;").multi());
        assertEquals("other", SqlClassifier.classify("VACUUM").kindName());
    }

    @Test
    void executableSqlDropsTrailingSemicolonOnly() {
        assertEquals("SELECT 1", SqlClassifier.classify("SELECT 1;  ").executableSql());
        assertEquals("SELECT 1", SqlClassifier.classify("SELECT 1; -- done").executableSql());
        assertEquals("SELECT 'a;b'", SqlClassifier.classify("SELECT 'a;b';").executableSql());
        assertEquals("BEGIN NULL; END;", SqlClassifier.classify("BEGIN NULL; END;").executableSql());
    }
}
