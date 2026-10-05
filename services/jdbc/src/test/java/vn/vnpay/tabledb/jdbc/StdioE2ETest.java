package vn.vnpay.tabledb.jdbc;

import static org.junit.jupiter.api.Assertions.*;

import java.io.*;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class StdioE2ETest {
    @TempDir Path tmp;

    /** Client end of a loopback socket pair standing in for the child's stdin/stdout, against an in-process StdioServer. */
    static final class Client implements AutoCloseable {
        final Socket client;
        final Socket server;
        final OutputStream toServer;
        final BufferedReader fromServer;
        final Thread thread;
        final Dispatcher d;

        Client(TestEnv env) throws IOException {
            try (ServerSocket ss = new ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) {
                client = new Socket(java.net.InetAddress.getLoopbackAddress(), ss.getLocalPort());
                server = ss.accept();
            }
            toServer = client.getOutputStream();
            fromServer = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
            d = env.d;
            StdioServer srv = new StdioServer(d, server.getInputStream(), server.getOutputStream());
            thread = new Thread(() -> { try { srv.run(); } catch (IOException ignored) { } }, "stdio-test");
            thread.start();
        }

        void send(String line) throws IOException {
            toServer.write((line + "\n").getBytes(StandardCharsets.UTF_8));
            toServer.flush();
        }

        Map<String, Object> read() throws IOException {
            String l = fromServer.readLine();
            assertNotNull(l, "server closed stdout");
            return Json.parseObject(l);
        }

        @Override public void close() throws Exception {
            client.shutdownOutput(); // EOF on the server's stdin
            thread.join(20000);
            assertFalse(thread.isAlive(), "server did not exit on stdin EOF");
            client.close();
            server.close();
        }
    }

    @Test void fullSessionOverNdjson() throws Exception {
        TestEnv env = new TestEnv(tmp);
        try (Client c = new Client(env)) {
            Map<String, Object> ready = c.read();
            assertEquals("ready", ready.get("event"));
            assertEquals(0L, ready.get("seq"));

            c.send("{\"id\":1,\"method\":\"hello\"}");
            Map<String, Object> hello = c.read();
            assertEquals(1L, hello.get("id"));
            assertEquals(1L, ((Map<?, ?>) hello.get("result")).get("protocol"));

            c.send(Json.write(Map.of("id", 2L, "method", "session.open", "params", Map.of("profile", TestEnv.profile("e2e", true)))));
            Map<String, Object> open = c.read();
            String sid = (String) ((Map<?, ?>) open.get("result")).get("sessionId");
            assertNotNull(sid);

            c.send(Json.write(Map.of("id", 3L, "method", "query.execute", "params", Map.of("sessionId", sid, "queryId", "q1", "mode", "write",
                    "confirmWrite", true, "sql", "CREATE TABLE T (A INT)"))));
            assertEquals("ddl", ((Map<?, ?>) c.read().get("result")).get("kind"));

            // garbage line -> error with null id, server keeps going
            c.send("this is not json");
            Map<String, Object> bad = c.read();
            assertNull(bad.get("id"));
            assertEquals("E_BAD_REQUEST", ((Map<?, ?>) bad.get("error")).get("code"));

            c.send(Json.write(Map.of("id", 4L, "method", "query.execute", "params", Map.of("sessionId", sid, "queryId", "q2", "mode", "read",
                    "sql", "SELECT 'héllo\nworld' AS S"))));
            Map<String, Object> sel = c.read();
            assertEquals(4L, sel.get("id"));
            assertEquals("héllo\nworld", ((List<?>) ((List<?>) ((Map<?, ?>) sel.get("result")).get("rows")).get(0)).get(0));

            c.send(Json.write(Map.of("id", 5L, "method", "session.close", "params", Map.of("sessionId", sid))));
            assertNotNull(c.read().get("result"));
        }
    }

    @Test void eventsArePushedOnStdout() throws Exception {
        TestEnv env = new TestEnv(tmp);
        try (Client c = new Client(env)) {
            c.read(); // ready
            env.bus.emit("auth.openUrl", Map.of("sessionId", "s1", "url", "https://idp.example/x", "purpose", "trino-sso"));
            Map<String, Object> ev = c.read();
            assertEquals("auth.openUrl", ev.get("event"));
            assertEquals(1L, ev.get("seq"));
            assertNull(ev.get("id"));
            assertEquals("trino-sso", ((Map<?, ?>) ev.get("data")).get("purpose"));
        }
    }

    @Test void cancelOvertakesRunningExecute() throws Exception {
        TestEnv env = new TestEnv(tmp);
        try (Client c = new Client(env)) {
            c.read();
            c.send(Json.write(Map.of("id", 1L, "method", "session.open", "params", Map.of("profile", TestEnv.profile("e2ec", false)))));
            String sid = (String) ((Map<?, ?>) c.read().get("result")).get("sessionId");
            c.send(Json.write(Map.of("id", 2L, "method", "query.execute", "params", Map.of("sessionId", sid, "queryId", "long", "mode", "read",
                    "sql", "SELECT MAX(A.X * B.X) FROM SYSTEM_RANGE(1, 200000) A, SYSTEM_RANGE(1, 200000) B"))));
            Thread.sleep(500);
            c.send("{\"id\":3,\"method\":\"query.cancel\",\"params\":{\"queryId\":\"long\"}}");
            Map<String, Object> a = c.read();
            Map<String, Object> b = c.read();
            Map<String, Object> cancel = a.get("id").equals(3L) ? a : b;
            Map<String, Object> exec = a.get("id").equals(2L) ? a : b;
            assertEquals(true, ((Map<?, ?>) cancel.get("result")).get("cancelled"));
            assertEquals("E_CANCELLED", ((Map<?, ?>) exec.get("error")).get("code"));
        }
    }

    @Test void oversizedRequestLineIsRejectedAndStreamRecovers() throws Exception {
        TestEnv env = new TestEnv(tmp);
        try (Client c = new Client(env)) {
            c.read();
            // 8 MiB + 10 bytes on one line, then a valid request
            Thread w = new Thread(() -> {
                try {
                    byte[] chunk = new byte[1 << 16];
                    java.util.Arrays.fill(chunk, (byte) 'x');
                    for (int i = 0; i < (StdioServer.MAX_LINE / chunk.length) + 1; i++) c.toServer.write(chunk);
                    c.send("");
                    c.send("{\"id\":9,\"method\":\"hello\"}");
                } catch (IOException ignored) { }
            });
            w.start();
            Map<String, Object> err = c.read();
            assertEquals("E_BAD_REQUEST", ((Map<?, ?>) err.get("error")).get("code"));
            assertEquals(9L, c.read().get("id"));
            w.join();
        }
    }

    /** Real entry point in a child JVM: stdout must be NDJSON only; no drivers dir next to classes => E_DRIVER_UNAVAILABLE. */
    @Test void realMainStdioSubprocess() throws Exception {
        String javaBin = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        Path classes = Path.of(Main.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        Path app = tmp.resolve("app/classes"); // sibling app/drivers does not exist
        try (var walk = Files.walk(classes)) {
            for (Path src : (Iterable<Path>) walk::iterator) {
                Path dst = app.resolve(classes.relativize(src).toString());
                if (Files.isDirectory(src)) Files.createDirectories(dst);
                else Files.copy(src, dst);
            }
        }
        ProcessBuilder pb = new ProcessBuilder(javaBin, "-cp", app.toString(), "vn.vnpay.tabledb.jdbc.Main", "--stdio");
        pb.environment().put("TABLEDB_LOG", "debug");
        Process p = pb.start();
        List<String> err = new ArrayList<>();
        Thread et = Thread.ofVirtual().start(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getErrorStream()))) {
                String l;
                while ((l = r.readLine()) != null) err.add(l);
            } catch (IOException ignored) { }
        });
        BufferedReader out = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
        Writer in = new OutputStreamWriter(p.getOutputStream(), StandardCharsets.UTF_8);

        Map<String, Object> ready = Json.parseObject(out.readLine());
        assertEquals("ready", ready.get("event"));
        List<?> drivers = (List<?>) ((Map<?, ?>) ready.get("data")).get("drivers");
        assertEquals(3, drivers.size());
        for (Object o : drivers) assertEquals(false, ((Map<?, ?>) o).get("loaded"));

        String secret = "sup3r-secret-pw";
        Map<String, Object> prof = TestEnv.profile("x", false);
        prof.put("driver", "postgresql");
        prof.put("port", 5432L);
        ((Map<String, Object>) prof.get("auth")).put("password", secret);
        in.write(Json.write(Map.of("id", 1L, "method", "session.open", "params", Map.of("profile", prof))) + "\n");
        in.write("{\"id\":2,\"method\":\"hello\"}\n");
        in.flush();
        Map<String, Object> ra = Json.parseObject(out.readLine());
        Map<String, Object> rb = Json.parseObject(out.readLine());
        Map<String, Object> r1 = ra.get("id").equals(1L) ? ra : rb; // responses may arrive out of order
        assertEquals(2L, (ra.get("id").equals(1L) ? rb : ra).get("id"));
        assertEquals("E_DRIVER_UNAVAILABLE", ((Map<?, ?>) r1.get("error")).get("code"));
        assertFalse(Json.write(r1).contains(secret));

        in.close();
        assertTrue(p.waitFor(20, TimeUnit.SECONDS));
        assertEquals(0, p.exitValue());
        assertNull(out.readLine(), "stdout must contain nothing but the NDJSON we read");
        et.join(2000);
        for (String l : err) assertFalse(l.contains(secret), "stderr leaked a secret: " + l);
    }
}
