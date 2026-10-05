package vn.vnpay.tabledb.jdbc;

import static org.junit.jupiter.api.Assertions.*;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class HttpServiceTest {
    static final String TOKEN = "test-service-token-0123456789";
    @TempDir Path tmp;
    TestEnv env;
    HttpService svc;
    String base;
    final HttpClient http = HttpClient.newHttpClient();

    @BeforeEach void setUp() throws Exception {
        env = new TestEnv(tmp);
        svc = new HttpService(env.d, TOKEN, "127.0.0.1", 0, null);
        svc.start();
        base = "http://127.0.0.1:" + svc.port();
    }

    @AfterEach void tearDown() { svc.close(); }

    HttpResponse<String> post(String path, String body, String auth) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path)).POST(HttpRequest.BodyPublishers.ofString(body));
        if (auth != null) b.header("Authorization", auth);
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    HttpResponse<String> get(String path, String auth) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path)).GET().timeout(Duration.ofSeconds(30));
        if (auth != null) b.header("Authorization", auth);
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test void noTokenIs401() throws Exception {
        HttpResponse<String> r = post("/rpc", "{\"id\":1,\"method\":\"hello\"}", null);
        assertEquals(401, r.statusCode());
        assertEquals("Bearer", r.headers().firstValue("WWW-Authenticate").orElse(null));
        assertFalse(r.body().contains("protocol"));
        assertEquals(401, get("/events?after=0&wait=0", null).statusCode());
    }

    @Test void wrongOrMalformedTokenIs401() throws Exception {
        for (String a : new String[] {"Bearer wrong", "Bearer ", "Basic " + TOKEN, TOKEN, "Bearer " + TOKEN + "x", "bearer"}) {
            assertEquals(401, post("/rpc", "{\"id\":1,\"method\":\"hello\"}", a).statusCode(), a);
            assertEquals(401, get("/events?wait=0", a).statusCode(), a);
        }
    }

    @Test void correctTokenCallsDispatcher() throws Exception {
        HttpResponse<String> r = post("/rpc", "{\"id\":1,\"method\":\"hello\"}", "Bearer " + TOKEN);
        assertEquals(200, r.statusCode());
        Map<String, Object> m = Json.parseObject(r.body());
        assertEquals(1L, m.get("id"));
        assertEquals(1L, ((Map<?, ?>) m.get("result")).get("protocol"));
        // lower-case scheme accepted
        assertEquals(200, post("/rpc", "{\"id\":1,\"method\":\"hello\"}", "bearer " + TOKEN).statusCode());
    }

    @Test void protocolErrorsStay200WithEnvelope() throws Exception {
        HttpResponse<String> r = post("/rpc", "{bad", "Bearer " + TOKEN);
        assertEquals(200, r.statusCode());
        assertEquals("E_BAD_REQUEST", ((Map<?, ?>) Json.parseObject(r.body()).get("error")).get("code"));
    }

    @Test void methodAndPathChecks() throws Exception {
        assertEquals(405, get("/rpc", "Bearer " + TOKEN).statusCode());
        assertEquals(405, post("/events", "{}", "Bearer " + TOKEN).statusCode());
        assertEquals(404, get("/nope", "Bearer " + TOKEN).statusCode());
        assertEquals(400, get("/events?after=x", "Bearer " + TOKEN).statusCode());
    }

    @Test void eventsLongPoll() throws Exception {
        // nothing pending: wait=0 returns immediately with empty list
        Map<String, Object> m = Json.parseObject(get("/events?after=0&wait=0", "Bearer " + TOKEN).body());
        assertEquals(List.of(), m.get("events"));

        // long-poll wakes up when an event is emitted
        Thread.ofVirtual().start(() -> {
            try { Thread.sleep(300); } catch (InterruptedException ignored) { }
            env.bus.emit("auth.openUrl", Map.of("sessionId", "s1", "url", "https://idp.example/login", "purpose", "trino-sso"));
        });
        long t0 = System.nanoTime();
        m = Json.parseObject(get("/events?after=0&wait=10", "Bearer " + TOKEN).body());
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 8000);
        List<?> evs = (List<?>) m.get("events");
        assertEquals(1, evs.size());
        Map<?, ?> ev = (Map<?, ?>) evs.get(0);
        assertEquals("auth.openUrl", ev.get("event"));
        assertEquals(1L, ev.get("seq"));

        // "after" filters already-seen events
        m = Json.parseObject(get("/events?after=1&wait=0", "Bearer " + TOKEN).body());
        assertEquals(List.of(), m.get("events"));
    }

    @Test void endToEndQueryOverHttp() throws Exception {
        String open = Json.write(Map.of("id", 1L, "method", "session.open", "params", Map.of("profile", TestEnv.profile("httpdb", false))));
        Map<?, ?> res = (Map<?, ?>) Json.parseObject(post("/rpc", open, "Bearer " + TOKEN).body()).get("result");
        String sid = (String) res.get("sessionId");
        String q = Json.write(Map.of("id", 2L, "method", "query.execute", "params", Map.of("sessionId", sid, "queryId", "h1", "mode", "read", "sql", "SELECT 41+1")));
        Map<?, ?> r = (Map<?, ?>) Json.parseObject(post("/rpc", q, "Bearer " + TOKEN).body()).get("result");
        assertEquals(List.of(List.of(42L)), r.get("rows"));
    }

    @Test void tokenRequired() {
        assertThrows(IllegalArgumentException.class, () -> new HttpService(env.d, "", "127.0.0.1", 0, null));
    }
}
