package vn.vnpay.tabledb.jdbc;

import static org.junit.jupiter.api.Assertions.*;
import static vn.vnpay.tabledb.jdbc.TestEnv.ok;

import com.jcraft.jsch.JSch;
import com.jcraft.jsch.KeyPair;
import java.io.ByteArrayOutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.PublicKey;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.sshd.common.config.keys.KeyUtils;
import org.apache.sshd.common.digest.BuiltinDigests;
import org.apache.sshd.server.SshServer;
import org.apache.sshd.server.forward.AcceptAllForwardingFilter;
import org.apache.sshd.server.forward.RejectAllForwardingFilter;
import org.apache.sshd.server.keyprovider.SimpleGeneratorHostKeyProvider;
import org.h2.tools.Server;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * SSH tunnel / proxy routes end to end: embedded SSH servers (Apache MINA SSHD, test scope) as bastions, H2 in TCP server
 * mode as the database, and minimal HTTP/SOCKS5 proxies. Everything listens on loopback only.
 */
class TunnelTest {
    static final String SSH_USER = "alice";
    static final String SSH_PASS = "ssh-Pass-123";

    /** H2 over TCP: the URL uses the (possibly tunnel-rewritten) host/port, exactly like the production vendors. */
    static final class H2TcpVendor extends Vendor {
        @Override public String type() { return "h2test"; }
        @Override public String url(Profile p) { return "jdbc:h2:tcp://" + p.host + ":" + p.port + "/mem:" + p.database + ";DB_CLOSE_DELAY=-1"; }
        @Override public Properties props(Profile p) {
            Properties pr = new Properties();
            pr.setProperty("user", p.username);
            pr.setProperty("password", p.password == null ? "" : p.password);
            return pr;
        }
    }

    @TempDir Path tmp;
    Dispatcher d;
    Server h2;
    int dbPort;
    Path keysDir;
    final List<SshServer> servers = new ArrayList<>();
    final List<AutoCloseable> closeables = new ArrayList<>();
    final AtomicInteger ids = new AtomicInteger();
    PublicKey allowedKey;

    @BeforeEach void setUp() throws Exception {
        keysDir = Files.createDirectories(tmp.resolve("ssh-keys"));
        Map<String, Vendor> vendors = new LinkedHashMap<>();
        vendors.put("h2test", new H2TcpVendor());
        d = new Dispatcher(new DriverRegistry(TestEnv.driversDir(tmp), Set.of("h2test")), vendors, new SessionManager(Config.defaults()),
                new EventBus(), "test", new SshKeys(keysDir));
        dbPort = freePort();
        h2 = Server.createTcpServer("-tcpPort", Integer.toString(dbPort), "-ifNotExists").start();
    }

    @AfterEach void tearDown() throws Exception {
        d.close();
        h2.stop();
        for (SshServer s : servers) s.stop(true);
        for (AutoCloseable c : closeables) c.close();
    }

    static int freePort() throws Exception {
        try (ServerSocket s = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) { return s.getLocalPort(); }
    }

    SshServer sshd(boolean allowForwarding) throws Exception {
        SshServer s = SshServer.setUpDefaultServer();
        s.setHost("127.0.0.1");
        s.setPort(0);
        s.setKeyPairProvider(new SimpleGeneratorHostKeyProvider(tmp.resolve("hostkey-" + servers.size() + ".ser")));
        s.setPasswordAuthenticator((u, p, sess) -> SSH_USER.equals(u) && SSH_PASS.equals(p));
        s.setPublickeyAuthenticator((u, k, sess) -> SSH_USER.equals(u) && allowedKey != null && KeyUtils.compareKeys(allowedKey, k));
        s.setForwardingFilter(allowForwarding ? AcceptAllForwardingFilter.INSTANCE : RejectAllForwardingFilter.INSTANCE);
        s.start();
        servers.add(s);
        return s;
    }

    static String fingerprint(SshServer s) throws Exception {
        PublicKey k = s.getKeyPairProvider().loadKeys(null).iterator().next().getPublic();
        return KeyUtils.getFingerPrint(BuiltinDigests.sha256, k);
    }

    static Map<String, Object> hop(SshServer s, String hostKey) {
        Map<String, Object> h = new LinkedHashMap<>();
        h.put("host", "127.0.0.1");
        h.put("port", (long) s.getPort());
        h.put("username", SSH_USER);
        h.put("auth", new LinkedHashMap<>(Map.of("type", "password", "password", SSH_PASS)));
        if (hostKey != null) h.put("hostKey", hostKey);
        return h;
    }

    Map<String, Object> profile(String db) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("driver", "h2test");
        p.put("host", "127.0.0.1");
        p.put("port", (long) dbPort);
        p.put("database", db);
        p.put("auth", new LinkedHashMap<>(Map.of("type", "password", "username", "sa", "password", "pw-Secret-123")));
        p.put("options", new LinkedHashMap<>(Map.of("allowWrite", true, "connectTimeoutSec", 5L)));
        return p;
    }

    static void ssh(Map<String, Object> p, List<Map<String, Object>> hops) {
        p.put("ssh", new LinkedHashMap<>(Map.of("hops", hops)));
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> opts(Map<String, Object> p) { return (Map<String, Object>) p.get("options"); }

    Map<String, Object> rpc(String method, Object... kv) {
        Map<String, Object> params = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) params.put((String) kv[i], kv[i + 1]);
        Map<String, Object> req = new LinkedHashMap<>();
        req.put("id", (long) ids.incrementAndGet());
        req.put("method", method);
        req.put("params", params);
        return d.handleRaw(Json.write(req));
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> err(Map<String, Object> resp) {
        Map<String, Object> e = (Map<String, Object>) resp.get("error");
        if (e == null) throw new AssertionError("expected error, got " + resp);
        return e;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> details(Map<String, Object> resp) { return (Map<String, Object>) err(resp).get("details"); }

    /** Opens, writes and reads through the route, then closes; returns the session id. */
    String roundTrip(Map<String, Object> profile) {
        String sid = (String) ok(rpc("session.open", "profile", profile)).get("sessionId");
        ok(rpc("query.execute", "sessionId", sid, "queryId", "q" + ids.incrementAndGet(), "sql", "CREATE TABLE IF NOT EXISTS T (A INT)", "mode", "write", "confirmWrite", true));
        ok(rpc("query.execute", "sessionId", sid, "queryId", "q" + ids.incrementAndGet(), "sql", "INSERT INTO T VALUES (42)", "mode", "write", "confirmWrite", true));
        Map<String, Object> r = ok(rpc("query.execute", "sessionId", sid, "queryId", "q" + ids.incrementAndGet(), "sql", "SELECT SUM(A) FROM T", "mode", "read"));
        assertEquals("[[42]]", String.valueOf(r.get("rows")));
        return sid;
    }

    // ------------------------------------------------------------------ SSH

    @Test void unknownHostKeyIsReportedThenPinnedKeyConnects() throws Exception {
        SshServer s = sshd(true);
        Map<String, Object> p = profile("tofu");
        ssh(p, List.of(hop(s, null)));
        Map<String, Object> first = rpc("session.open", "profile", p);
        assertEquals("E_SSH_HOSTKEY", err(first).get("code"));
        Map<String, Object> det = details(first);
        assertEquals("unknown", det.get("reason"));
        assertEquals(0L, det.get("hop"));
        assertEquals(fingerprint(s), det.get("fingerprint"));
        assertNotNull(det.get("keyType"));
        assertFalse(Json.write(first).contains(SSH_PASS));

        ssh(p, List.of(hop(s, (String) det.get("fingerprint"))));
        String sid = roundTrip(p);
        assertEquals(1, d.sessions().sessionCount());
        ok(rpc("session.close", "sessionId", sid));
    }

    @Test void changedHostKeyIsAMismatch() throws Exception {
        SshServer s = sshd(true);
        Map<String, Object> p = profile("mitm");
        String other = "SHA256:" + "A".repeat(43);
        ssh(p, List.of(hop(s, other)));
        Map<String, Object> r = rpc("session.open", "profile", p);
        assertEquals("E_SSH_HOSTKEY", err(r).get("code"));
        assertEquals("mismatch", details(r).get("reason"));
        assertEquals(other, details(r).get("expected"));
        assertEquals(fingerprint(s), details(r).get("fingerprint"));
    }

    @Test void wrongSshPasswordIsSshAuthAndNeverLeaks() throws Exception {
        SshServer s = sshd(true);
        Map<String, Object> p = profile("badpw");
        Map<String, Object> h = hop(s, fingerprint(s));
        h.put("auth", new LinkedHashMap<>(Map.of("type", "password", "password", "wrong-Ssh-999")));
        ssh(p, List.of(h));
        Map<String, Object> r = rpc("session.open", "profile", p);
        assertEquals("E_SSH_AUTH", err(r).get("code"));
        assertEquals("auth", details(r).get("reason"));
        assertFalse(Json.write(r).contains("wrong-Ssh-999"));
        assertEquals(0, d.sessions().sessionCount());
    }

    @Test void forwardingRefusedByBastionIsExplained() throws Exception {
        SshServer s = sshd(false);
        Map<String, Object> p = profile("nofwd");
        ssh(p, List.of(hop(s, fingerprint(s))));
        Map<String, Object> r = rpc("session.open", "profile", p);
        assertEquals("E_CONN", err(r).get("code"));
        assertTrue(String.valueOf(err(r).get("message")).contains("could not open a connection"), String.valueOf(err(r)));
    }

    @Test void twoHopJumpChain() throws Exception {
        SshServer a = sshd(true), b = sshd(true);
        Map<String, Object> p = profile("jump");
        ssh(p, List.of(hop(a, fingerprint(a)), hop(b, fingerprint(b))));
        String sid = roundTrip(p);
        ok(rpc("session.close", "sessionId", sid));
        // an unknown key on the SECOND hop names that hop
        ssh(p, List.of(hop(a, fingerprint(a)), hop(b, null)));
        Map<String, Object> r = rpc("session.open", "profile", p);
        assertEquals("E_SSH_HOSTKEY", err(r).get("code"));
        assertEquals(1L, details(r).get("hop"));
    }

    @Test void publicKeyAuthWithEncryptedKey() throws Exception {
        SshServer s = sshd(true);
        JSch j = new JSch();
        KeyPair kp = KeyPair.genKeyPair(j, KeyPair.RSA, 2048);
        ByteArrayOutputStream prv = new ByteArrayOutputStream();
        kp.writePrivateKey(prv, "key-Pass-1".getBytes());
        allowedKey = new org.apache.sshd.common.util.buffer.ByteArrayBuffer(kp.getPublicKeyBlob()).getRawPublicKey();
        Files.write(keysDir.resolve("k1.key"), prv.toByteArray());

        Map<String, Object> p = profile("pk");
        Map<String, Object> h = hop(s, fingerprint(s));
        h.put("auth", new LinkedHashMap<>(Map.of("type", "publicKey", "keyId", "k1")));
        ssh(p, List.of(h));
        Map<String, Object> r = rpc("session.open", "profile", p);
        assertEquals("E_SSH_AUTH", err(r).get("code"));
        assertEquals("passphrase", details(r).get("reason"));

        h.put("auth", new LinkedHashMap<>(Map.of("type", "publicKey", "keyId", "k1", "passphrase", "nope-Nope-1")));
        r = rpc("session.open", "profile", p);
        assertEquals("E_SSH_AUTH", err(r).get("code"));
        assertFalse(Json.write(r).contains("nope-Nope-1"));

        h.put("auth", new LinkedHashMap<>(Map.of("type", "publicKey", "keyId", "k1", "passphrase", "key-Pass-1")));
        ok(rpc("session.close", "sessionId", roundTrip(p)));

        h.put("auth", new LinkedHashMap<>(Map.of("type", "publicKey", "keyId", "missing")));
        assertEquals("E_NOT_FOUND", err(rpc("session.open", "profile", p)).get("code"));
    }

    @Test void closingTheSessionClosesTheTunnel() throws Exception {
        SshServer s = sshd(true);
        Map<String, Object> p = profile("close");
        ssh(p, List.of(hop(s, fingerprint(s))));
        String sid = roundTrip(p);
        Session sess = d.sessions().get(sid);
        assertNotNull(sess.tunnel);
        int local = sess.tunnel.port;
        assertTrue(sess.profile.routed);
        assertEquals("127.0.0.1", sess.profile.host);
        ok(rpc("session.close", "sessionId", sid));
        assertThrows(java.io.IOException.class, () -> { try (var c = new java.net.Socket("127.0.0.1", local)) { c.getInputStream().read(); } });
        // session.test leaves nothing behind either
        assertEquals(true, ok(rpc("session.test", "profile", p)).get("ok"));
        assertEquals(0, d.sessions().sessionCount());
    }

    // ------------------------------------------------------------------ proxy

    @Test void socks5ProxyWithCredentials() throws Exception {
        TestProxies.Proxy px = new TestProxies.Proxy(true, "pu", "px-Pass-1");
        closeables.add(px);
        Map<String, Object> p = profile("socks");
        opts(p).put("proxy", new LinkedHashMap<>(Map.of("type", "socks", "host", "127.0.0.1", "port", (long) px.port(), "username", "pu", "password", "px-Pass-1")));
        ok(rpc("session.close", "sessionId", roundTrip(p)));
        assertEquals("127.0.0.1:" + dbPort, px.lastTarget);

        opts(p).put("proxy", new LinkedHashMap<>(Map.of("type", "socks", "host", "127.0.0.1", "port", (long) px.port(), "username", "pu", "password", "bad-Pass-9")));
        Map<String, Object> r = rpc("session.open", "profile", p);
        assertEquals("E_PROXY_AUTH", err(r).get("code"), String.valueOf(r));
        assertFalse(Json.write(r).contains("bad-Pass-9"));
    }

    @Test void httpConnectProxyWithCredentials() throws Exception {
        TestProxies.Proxy px = new TestProxies.Proxy(false, "hu", "hp-Pass-1");
        closeables.add(px);
        Map<String, Object> p = profile("http");
        opts(p).put("proxy", new LinkedHashMap<>(Map.of("type", "http", "host", "127.0.0.1", "port", (long) px.port(), "username", "hu", "password", "hp-Pass-1")));
        ok(rpc("session.close", "sessionId", roundTrip(p)));
        opts(p).put("proxy", new LinkedHashMap<>(Map.of("type", "http", "host", "127.0.0.1", "port", (long) px.port())));
        assertEquals("E_PROXY_AUTH", err(rpc("session.open", "profile", p)).get("code"));
    }

    @Test void sshThroughHttpProxy() throws Exception {
        SshServer s = sshd(true);
        TestProxies.Proxy px = new TestProxies.Proxy(false, null, null);
        closeables.add(px);
        Map<String, Object> p = profile("sshpx");
        ssh(p, List.of(hop(s, fingerprint(s))));
        opts(p).put("proxy", new LinkedHashMap<>(Map.of("type", "http", "host", "127.0.0.1", "port", (long) px.port())));
        ok(rpc("session.close", "sessionId", roundTrip(p)));
        assertEquals("127.0.0.1:" + s.getPort(), px.lastTarget, "the proxy carries the SSH connection, not the database one");
    }

    @Test void diagProxyWithSocksCredentials() throws Exception {
        TestProxies.Proxy px = new TestProxies.Proxy(true, "pu", "px-Pass-1");
        closeables.add(px);
        Map<String, Object> good = ok(rpc("diag.proxy", "host", "127.0.0.1", "port", (long) dbPort,
                "proxy", new LinkedHashMap<>(Map.of("type", "socks", "host", "127.0.0.1", "port", (long) px.port(), "username", "pu", "password", "px-Pass-1"))));
        assertEquals(true, good.get("reachable"), good.toString());
        Map<String, Object> bad = ok(rpc("diag.proxy", "host", "127.0.0.1", "port", (long) dbPort,
                "proxy", new LinkedHashMap<>(Map.of("type", "socks", "host", "127.0.0.1", "port", (long) px.port(), "username", "pu", "password", "zz-Wrong-1"))));
        assertEquals(false, bad.get("reachable"));
        assertFalse(Json.write(bad).contains("zz-Wrong-1"));
    }

    // ------------------------------------------------------------------ validation

    @Test void sshProfileValidation() {
        Map<String, Object> base = profile("v");
        List<Map<String, Object>> bads = new ArrayList<>();
        bads.add(Map.of("hops", List.of()));
        bads.add(Map.of("hops", List.of(Map.of("host", "a/b", "username", "u", "auth", Map.of("type", "password")))));
        bads.add(Map.of("hops", List.of(Map.of("host", "h", "username", "u", "auth", Map.of("type", "agent")))));
        bads.add(Map.of("hops", List.of(Map.of("host", "h", "username", "u", "auth", Map.of("type", "publicKey", "keyId", "../x")))));
        bads.add(Map.of("hops", List.of(Map.of("host", "h", "username", "u", "auth", Map.of("type", "publicKey", "keyId", "k"), "hostKey", "MD5:aa"))));
        bads.add(Map.of("hops", List.of(Map.of("host", "h", "username", "u", "auth", Map.of("type", "password"), "path", "/etc/passwd"))));
        bads.add(Map.of("hops", List.of(Map.of("host", "h", "username", "u", "auth", Map.of("type", "password", "keyId", "k")))));
        bads.add(Map.of("hops", List.of(Map.of("host", "h", "auth", Map.of("type", "password")))));
        Map<String, Object> hop = Map.of("host", "h", "username", "u", "auth", Map.of("type", "password"));
        bads.add(Map.of("hops", List.of(hop, hop, hop, hop, hop)));
        bads.add(Map.of("hops", List.of(hop), "keyFile", "/x"));
        for (Map<String, Object> b : bads) {
            Map<String, Object> p = new LinkedHashMap<>(base);
            p.put("ssh", b);
            assertEquals("E_BAD_REQUEST", err(rpc("session.open", "profile", p)).get("code"), b.toString());
        }
    }

    @Test void fingerprintAndKeyTypeHelpers() {
        byte[] blob = {0, 0, 0, 11, 's', 's', 'h', '-', 'e', 'd', '2', '5', '5', '1', '9', 1, 2, 3};
        assertEquals("ssh-ed25519", Tunnel.keyType(blob));
        assertEquals("unknown", Tunnel.keyType(new byte[] {0, 0, 1}));
        assertTrue(Profile.HOST_KEY.matcher(Tunnel.fingerprint(blob)).matches());
    }
}
