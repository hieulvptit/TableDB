package vn.vnpay.tabledb.jdbc;

import static org.junit.jupiter.api.Assertions.*;
import static vn.vnpay.tabledb.jdbc.TestEnv.code;
import static vn.vnpay.tabledb.jdbc.TestEnv.ok;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ProtocolTest {
    @TempDir Path tmp;
    TestEnv env;

    @BeforeEach void setUp() throws Exception { env = new TestEnv(tmp); }
    @AfterEach void tearDown() { env.d.close(); }

    @Test void helloReportsProtocolAndDrivers() {
        Map<String, Object> r = ok(env.rpc("hello"));
        assertEquals(1L, r.get("protocol"));
        assertEquals("test", r.get("version"));
        @SuppressWarnings("unchecked") List<Map<String, Object>> drivers = (List<Map<String, Object>>) r.get("drivers");
        assertEquals("h2test", drivers.get(0).get("type"));
        assertEquals(true, drivers.get(0).get("loaded"));
        assertEquals(64, ((String) drivers.get(0).get("sha256")).length());
    }

    @Test void readyEventShape() {
        Map<String, Object> ev = env.d.readyEvent();
        assertEquals("ready", ev.get("event"));
        assertEquals(0L, ev.get("seq"));
        assertEquals(1L, ((Map<?, ?>) ev.get("data")).get("protocol"));
    }

    @Test void malformedJsonIsBadRequestWithNullId() {
        Map<String, Object> r = env.d.handleRaw("{not json");
        assertEquals("E_BAD_REQUEST", code(r));
        assertNull(r.get("id"));
        assertEquals("E_BAD_REQUEST", code(env.d.handleRaw("[1,2]")));
    }

    @Test void missingIdUnknownMethodAndBadParams() {
        assertEquals("E_BAD_REQUEST", code(env.d.handleRaw("{\"method\":\"hello\"}")));
        Map<String, Object> r = env.d.handleRaw("{\"id\":7,\"method\":\"exec.shell\",\"params\":{}}");
        assertEquals("E_BAD_REQUEST", code(r));
        assertEquals(7L, r.get("id"));
        assertEquals("E_BAD_REQUEST", code(env.d.handleRaw("{\"id\":8,\"method\":\"hello\",\"params\":[1]}")));
        assertEquals("E_BAD_REQUEST", code(env.d.handleRaw("{\"id\":{\"a\":1},\"method\":\"hello\"}")));
    }

    @Test void stringIdIsEchoed() {
        Map<String, Object> r = env.d.handleRaw("{\"id\":\"abc\",\"method\":\"hello\"}");
        assertEquals("abc", r.get("id"));
        assertNotNull(r.get("result"));
    }

    @Test void errorEnvelopeHasAllFields() {
        Map<String, Object> r = env.rpc("session.close", "sessionId", "nope");
        @SuppressWarnings("unchecked") Map<String, Object> e = (Map<String, Object>) r.get("error");
        assertEquals("E_NOT_FOUND", e.get("code"));
        assertNotNull(e.get("message"));
        assertEquals(0L, e.get("vendorCode"));
        assertEquals(false, e.get("retryable"));
    }

    @Test void missingRequiredParamsAreBadRequest() {
        assertEquals("E_BAD_REQUEST", code(env.rpc("session.open")));
        assertEquals("E_BAD_REQUEST", code(env.rpc("meta.tables", "sessionId", "x")));
        assertEquals("E_NOT_FOUND", code(env.rpc("meta.catalogs", "sessionId", "x")));
        assertEquals("E_NOT_FOUND", code(env.rpc("query.fetch", "cursorId", "x")));
        assertEquals(false, ok(env.rpc("query.cancel", "queryId", "none")).get("cancelled"));
    }

    @Test void jsonRoundTripAndLineSafety() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("s", "line1\nline2 \"q\"\\");
        m.put("n", 12L);
        m.put("d", 1.5);
        m.put("z", null);
        String text = Json.write(m);
        assertFalse(text.contains("\n"));
        assertFalse(text.contains(" "));
        assertEquals(m, Json.parseObject(text));
        assertThrows(Json.ParseException.class, () -> Json.parse("{\"a\":1,\"a\":2}"));
        assertThrows(Json.ParseException.class, () -> Json.parse("[1,]"));
        assertThrows(Json.ParseException.class, () -> Json.parse("01"));
    }

    @Test void redactorScrubsSecrets() {
        assertFalse(Redactor.scrub("failed password=hunter2 for x").contains("hunter2"));
        assertFalse(Redactor.scrub("Authorization: Bearer abc.def-123").contains("abc.def"));
        assertFalse(Redactor.scrub("x eyJhbGciOiJI.eyJzdWIiOiIx.sig y").contains("eyJhbGci"));
        assertFalse(Redactor.scrub("boom secretvalue here", "secretvalue").contains("secretvalue"));
        String masked = Redactor.maskSql("select * from t where a='x' and b=42");
        assertFalse(masked.contains("x'") || masked.contains("42"));
    }
}
