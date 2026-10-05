package vn.vnpay.tabledb.jdbc;

import com.jcraft.jsch.ChannelDirectTCPIP;
import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.HostKeyRepository;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.JSchException;
import com.jcraft.jsch.KeyPair;
import com.jcraft.jsch.SocketFactory;
import com.jcraft.jsch.UIKeyboardInteractive;
import com.jcraft.jsch.UserInfo;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Network route from the sidecar to a database that the user's machine cannot reach directly:
 * <ul>
 *   <li><b>proxy</b>: HTTP CONNECT / SOCKS5 (optional credentials) straight to the database;</li>
 *   <li><b>ssh</b>: a chain of 1..{@value Profile#MAX_HOPS} SSH servers (first one optionally through the proxy), the
 *   last forwarding to the database with {@code direct-tcpip}.</li>
 * </ul>
 * Either way the JDBC driver connects to a loopback listener ({@link #host}:{@link #port}, random port, lives exactly as
 * long as the session) that relays each accepted connection over the route. Host keys are pinned per hop by SHA-256
 * fingerprint: an unknown key fails with E_SSH_HOSTKEY carrying the fingerprint so the user can confirm it (TOFU), a
 * different key fails the same way with reason "mismatch" and must not be auto-accepted.
 */
public final class Tunnel implements AutoCloseable {
    public static final String LOOPBACK = "127.0.0.1";

    static {
        JSch.setLogger(new com.jcraft.jsch.Logger() {
            @Override public boolean isEnabled(int level) { return level >= WARN || Log.isDebug(); }
            @Override public void log(int level, String message) {
                if (level >= WARN) Log.warn("ssh: " + message); else Log.debug("ssh: " + message);
            }
        });
    }

    /** Opens one upstream stream pair to the database for a relayed client socket. */
    private interface Upstream { void relay(Socket client, Set<Socket> track, Runnable established) throws Exception; }

    public final String host = LOOPBACK;
    public final int port;
    /** "ssh" or "proxy" (for logs/diagnostics) */
    public final String kind;
    public final int hops;
    private final ServerSocket server;
    private final List<com.jcraft.jsch.Session> sessions;
    private final Set<Socket> clients = ConcurrentHashMap.newKeySet();
    private final String[] secrets;
    private volatile String lastError;
    private volatile boolean lastErrorAuth;
    private volatile boolean closed;
    /** relayed connections still being set up (their failure may not be recorded yet) */
    private final java.util.concurrent.atomic.AtomicInteger settingUp = new java.util.concurrent.atomic.AtomicInteger();

    private Tunnel(String kind, List<com.jcraft.jsch.Session> sessions, Upstream up, String[] secrets) throws IOException {
        this.kind = kind;
        this.sessions = sessions;
        this.hops = sessions.size();
        this.secrets = secrets;
        this.server = new ServerSocket(0, 16, InetAddress.getByName(LOOPBACK));
        this.port = server.getLocalPort();
        Thread.ofVirtual().name("tabledb-tunnel-accept").start(() -> acceptLoop(up));
    }

    /** Does this profile need a local relay? Trino handles a credential-less proxy natively (keeps TLS host checks). */
    public static boolean needed(Profile p) {
        if (p.ssh != null) return true;
        return p.proxy != null && (!p.driver.equals("trino") || p.proxy.hasCredentials());
    }

    /**
     * Last relay failure (e.g. bastion refused to forward), used to explain a JDBC connect error. Waits briefly for
     * connections still being set up: JSch closes the client socket before reporting a refused channel.
     */
    public String lastError() {
        long deadline = System.nanoTime() + 2_000_000_000L;
        while (settingUp.get() > 0 && System.nanoTime() < deadline) {
            try { Thread.sleep(10); } catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
        }
        return lastError;
    }
    public boolean lastErrorIsAuth() { return lastErrorAuth; }

    public String describe() { return kind.equals("ssh") ? "ssh(" + hops + " hop" + (hops > 1 ? "s" : "") + ")" : "proxy"; }

    // ------------------------------------------------------------------ open

    public static Tunnel open(Profile p, SshKeys keys) {
        int timeoutMs = p.connectTimeoutSec * 1000;
        String target = ProxyDialer.unbracket(p.targetHost);
        int targetPort = p.targetPort;
        if (p.ssh == null) {
            Profile.Proxy px = p.proxy;
            try {
                return new Tunnel("proxy", List.of(), (client, track, established) -> {
                    Socket up;
                    try {
                        up = ProxyDialer.dial(px, p.targetHost, targetPort, timeoutMs);
                    } catch (ProxyDialer.ProxyException e) {
                        throw new RelayError("proxy " + px + ": " + e.getMessage(), e.auth);
                    } catch (IOException e) {
                        throw new RelayError("proxy " + px + " unreachable: " + netMessage(e), false);
                    }
                    established.run();
                    pump(client, up, track);
                }, p.secrets());
            } catch (IOException e) {
                throw RpcError.internal("could not open local relay");
            }
        }

        List<com.jcraft.jsch.Session> chain = new ArrayList<>();
        boolean ok = false;
        try {
            for (int i = 0; i < p.ssh.hops().size(); i++) {
                Profile.SshHop hop = p.ssh.hops().get(i);
                com.jcraft.jsch.Proxy via = i == 0 ? (p.proxy == null ? null : new DialerProxy(p.proxy)) : new ChannelProxy(chain.get(i - 1));
                chain.add(connectHop(i, hop, via, p, keys, timeoutMs));
            }
            com.jcraft.jsch.Session last = chain.get(chain.size() - 1);
            Profile.SshHop lastHop = p.ssh.hops().get(p.ssh.hops().size() - 1);
            Tunnel t = new Tunnel("ssh", List.copyOf(chain), (client, track, established) -> {
                ChannelDirectTCPIP ch = null;
                InputStream chIn;
                OutputStream chOut;
                try {
                    ch = (ChannelDirectTCPIP) last.openChannel("direct-tcpip");
                    ch.setHost(target);
                    ch.setPort(targetPort);
                    ch.setOrgIPAddress(LOOPBACK);
                    ch.setOrgPort(client.getPort());
                    // stream mode: connect() opens the channel synchronously and throws when the server refuses it
                    chIn = ch.getInputStream();
                    chOut = ch.getOutputStream();
                    ch.connect(timeoutMs);
                } catch (JSchException | IOException e) {
                    if (ch != null) ch.disconnect();
                    throw new RelayError("SSH server " + lastHop + " could not open a connection to " + p.targetHost + ":" + targetPort
                            + " (port forwarding disabled on the server, or target unreachable from it)", false);
                }
                established.run();
                ChannelDirectTCPIP fch = ch;
                Thread back = Thread.ofVirtual().name("tabledb-tunnel-pump").start(() -> {
                    try { copy(chIn, client.getOutputStream()); } catch (IOException ignored) { }
                    try { client.shutdownOutput(); } catch (IOException ignored) { }
                });
                try {
                    copy(client.getInputStream(), chOut);
                    try { chOut.close(); } catch (IOException ignored) { } // sends EOF on the channel
                    back.join();
                } finally {
                    fch.disconnect();
                    closeQuietly(client);
                }
            }, p.secrets());
            ok = true;
            return t;
        } catch (IOException e) {
            throw RpcError.internal("could not open local relay");
        } finally {
            if (!ok) disconnectAll(chain);
        }
    }

    private static final class RelayError extends Exception {
        final boolean auth;
        RelayError(String m, boolean auth) { super(m, null, false, false); this.auth = auth; }
    }

    private static com.jcraft.jsch.Session connectHop(int i, Profile.SshHop hop, com.jcraft.jsch.Proxy via, Profile p, SshKeys keys, int timeoutMs) {
        JSch jsch = new JSch(); // one instance per hop: identities never leak across hops
        String where = "SSH hop " + (i + 1) + " (" + hop + ")";
        try {
            if (hop.authType().equals("publicKey")) addKey(jsch, i, hop, keys.read(hop.keyId()), where);
            com.jcraft.jsch.Session s = jsch.getSession(hop.username(), ProxyDialer.unbracket(hop.host()), hop.port());
            PinnedHostKey repo = new PinnedHostKey(hop.hostKey());
            s.setHostKeyRepository(repo);
            s.setConfig("StrictHostKeyChecking", "yes");
            s.setConfig("HashKnownHosts", "no");
            s.setConfig("PreferredAuthentications", hop.authType().equals("publicKey") ? "publickey" : "keyboard-interactive,password");
            if (hop.password() != null) s.setPassword(hop.password().getBytes(StandardCharsets.UTF_8));
            s.setUserInfo(new NonInteractive(hop.password()));
            if (via != null) s.setProxy(via);
            if (p.ssh.keepAliveSec() > 0) {
                s.setServerAliveInterval(p.ssh.keepAliveSec() * 1000);
                s.setServerAliveCountMax(3);
            }
            try {
                s.connect(timeoutMs);
            } catch (JSchException e) {
                s.disconnect();
                throw mapHopError(e, i, hop, repo, where, p.secrets());
            }
            Log.info("ssh hop " + (i + 1) + " connected");
            return s;
        } catch (JSchException e) {
            throw new RpcError("E_CONN", Redactor.scrub(where + ": " + e.getMessage(), p.secrets()), null, 0, true);
        }
    }

    private static void addKey(JSch jsch, int i, Profile.SshHop hop, byte[] key, String where) throws JSchException {
        KeyPair kp;
        try {
            kp = KeyPair.load(jsch, key, null);
        } catch (JSchException e) {
            throw RpcError.badRequest(where + ": SSH key '" + hop.keyId() + "' is not a supported private key (OpenSSH, PEM or PuTTY .ppk)");
        }
        try {
            if (kp.isEncrypted()) {
                if (hop.passphrase() == null) throw new RpcError("E_SSH_AUTH", where + ": the SSH key is encrypted; enter its passphrase", false, hopDetails(i, hop, "passphrase"));
                if (!kp.decrypt(hop.passphrase().getBytes(StandardCharsets.UTF_8)))
                    throw new RpcError("E_SSH_AUTH", where + ": wrong passphrase for the SSH key", false, hopDetails(i, hop, "passphrase"));
            }
        } finally {
            kp.dispose();
        }
        jsch.addIdentity("hop" + i, key, null, hop.passphrase() == null ? null : hop.passphrase().getBytes(StandardCharsets.UTF_8));
    }

    private static Map<String, Object> hopDetails(int i, Profile.SshHop hop, String reason) {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("hop", (long) i);
        d.put("host", hop.host());
        d.put("port", (long) hop.port());
        d.put("reason", reason);
        return d;
    }

    private static RpcError mapHopError(JSchException e, int i, Profile.SshHop hop, PinnedHostKey repo, String where, String[] secrets) {
        if (repo.observedFingerprint != null && repo.result != HostKeyRepository.OK) {
            boolean mismatch = repo.result == HostKeyRepository.CHANGED;
            Map<String, Object> d = hopDetails(i, hop, mismatch ? "mismatch" : "unknown");
            d.put("keyType", repo.observedType);
            d.put("fingerprint", repo.observedFingerprint);
            if (mismatch) d.put("expected", hop.hostKey());
            String msg = mismatch
                    ? where + ": HOST KEY CHANGED (got " + repo.observedFingerprint + ", expected " + hop.hostKey() + "). Possible man-in-the-middle; verify with the server owner."
                    : where + ": unknown host key " + repo.observedType + " " + repo.observedFingerprint + "; confirm it to continue";
            return new RpcError("E_SSH_HOSTKEY", msg, false, d);
        }
        Throwable cause = e.getCause();
        if (cause instanceof ProxyDialer.ProxyException pe)
            return pe.auth ? new RpcError("E_PROXY_AUTH", "proxy: " + pe.getMessage(), false, null)
                    : new RpcError("E_CONN", "proxy: " + pe.getMessage(), null, 0, true);
        String m = String.valueOf(e.getMessage());
        String low = m.toLowerCase(java.util.Locale.ROOT);
        if (low.contains("auth fail") || low.contains("auth cancel") || low.contains("userauth fail") || low.contains("too many authentication"))
            return new RpcError("E_SSH_AUTH", where + ": SSH authentication failed", false, hopDetails(i, hop, "auth"));
        String detail = cause instanceof IOException io ? netMessage(io)
                : low.contains("timeout") || low.contains("timed out") ? "timed out"
                : Redactor.scrub(m, secrets);
        return new RpcError("E_CONN", where + ": " + detail, null, 0, true);
    }

    static String netMessage(IOException e) {
        if (e instanceof java.net.SocketTimeoutException) return "timed out";
        if (e instanceof java.net.ConnectException) return "connection refused or unreachable";
        if (e instanceof java.net.UnknownHostException) return "unknown host";
        if (e instanceof java.net.NoRouteToHostException) return "no route to host";
        return e.getClass().getSimpleName();
    }

    // ------------------------------------------------------------------ relay

    private void acceptLoop(Upstream up) {
        while (!closed) {
            Socket c;
            try {
                c = server.accept();
            } catch (IOException e) {
                if (!closed) Log.warn("tunnel accept failed: " + e.getClass().getSimpleName());
                return;
            }
            if (closed) { closeQuietly(c); return; }
            clients.removeIf(Socket::isClosed);
            clients.add(c);
            settingUp.incrementAndGet();
            Thread.ofVirtual().name("tabledb-tunnel-conn").start(() -> {
                boolean[] counted = {true};
                Runnable established = () -> { if (counted[0]) { counted[0] = false; settingUp.decrementAndGet(); } };
                try {
                    c.setTcpNoDelay(true);
                    up.relay(c, clients, established);
                    lastError = null;
                } catch (RelayError e) {
                    lastError = Redactor.scrub(e.getMessage(), secrets);
                    lastErrorAuth = e.auth;
                    Log.warn("tunnel: " + lastError);
                    closeQuietly(c);
                    clients.remove(c);
                } catch (Exception e) {
                    lastError = "relay failed (" + e.getClass().getSimpleName() + ")";
                    closeQuietly(c);
                    clients.remove(c);
                } finally {
                    established.run();
                }
            });
        }
    }

    /** Bidirectional copy until either side closes; closes both. {@code track} lets close() cut live relays. */
    private static void pump(Socket a, Socket b, Set<Socket> track) {
        track.add(b);
        try {
            b.setTcpNoDelay(true);
        } catch (IOException ignored) { }
        Thread t = Thread.ofVirtual().name("tabledb-tunnel-pump").start(() -> copy(b, a));
        copy(a, b);
        try { t.join(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        closeQuietly(b);
        closeQuietly(a);
        track.remove(a);
        track.remove(b);
    }

    private static void copy(Socket from, Socket to) {
        try {
            // not try-with-resources: closing a socket stream closes the socket and would cut the other direction
            copy(from.getInputStream(), to.getOutputStream());
        } catch (IOException ignored) {
            // peer closed
        } finally {
            try { to.shutdownOutput(); } catch (IOException ignored) { }
        }
    }

    private static void copy(InputStream in, OutputStream out) {
        byte[] buf = new byte[16 * 1024];
        try {
            int n;
            while ((n = in.read(buf)) >= 0) {
                out.write(buf, 0, n);
                out.flush();
            }
        } catch (IOException ignored) {
            // peer closed
        }
    }

    private static void closeQuietly(Socket s) {
        try { s.close(); } catch (IOException ignored) { }
    }

    private static void disconnectAll(List<com.jcraft.jsch.Session> chain) {
        for (int i = chain.size() - 1; i >= 0; i--) {
            try { chain.get(i).disconnect(); } catch (RuntimeException ignored) { }
        }
    }

    @Override public void close() {
        if (closed) return;
        closed = true;
        try { server.close(); } catch (IOException ignored) { }
        for (Socket c : clients) closeQuietly(c);
        clients.clear();
        disconnectAll(sessions);
    }

    // ------------------------------------------------------------------ JSch plumbing

    /** First hop through the HTTP/SOCKS proxy (same dialer as the proxy-only route). */
    private static final class DialerProxy implements com.jcraft.jsch.Proxy {
        private final Profile.Proxy px;
        private Socket s;
        DialerProxy(Profile.Proxy px) { this.px = px; }
        @Override public void connect(SocketFactory sf, String host, int port, int timeout) throws Exception {
            s = ProxyDialer.dial(px, host, port, timeout > 0 ? timeout : 15000);
        }
        @Override public InputStream getInputStream() { try { return s.getInputStream(); } catch (IOException e) { throw new IllegalStateException(e); } }
        @Override public OutputStream getOutputStream() { try { return s.getOutputStream(); } catch (IOException e) { throw new IllegalStateException(e); } }
        @Override public Socket getSocket() { return s; }
        @Override public void close() { if (s != null) closeQuietly(s); }
    }

    /** Next hop reached through a direct-tcpip channel of the previous hop (like OpenSSH ProxyJump). */
    private static final class ChannelProxy implements com.jcraft.jsch.Proxy {
        private final com.jcraft.jsch.Session prev;
        private ChannelDirectTCPIP ch;
        private InputStream in;
        private OutputStream out;
        ChannelProxy(com.jcraft.jsch.Session prev) { this.prev = prev; }
        @Override public void connect(SocketFactory sf, String host, int port, int timeout) throws Exception {
            ch = (ChannelDirectTCPIP) prev.openChannel("direct-tcpip");
            ch.setHost(host);
            ch.setPort(port);
            in = ch.getInputStream();
            out = ch.getOutputStream();
            ch.connect(timeout > 0 ? timeout : 15000);
        }
        @Override public InputStream getInputStream() { return in; }
        @Override public OutputStream getOutputStream() { return out; }
        @Override public Socket getSocket() { return null; }
        @Override public void close() { if (ch != null) ch.disconnect(); }
    }

    /** Answers password / keyboard-interactive prompts with the configured password only; never prompts a human. */
    private static final class NonInteractive implements UserInfo, UIKeyboardInteractive {
        private final String password;
        private int kbdAnswers;
        NonInteractive(String password) { this.password = password; }
        @Override public String getPassphrase() { return null; }
        @Override public String getPassword() { return password; }
        @Override public boolean promptPassword(String message) { return password != null; }
        @Override public boolean promptPassphrase(String message) { return false; }
        @Override public boolean promptYesNo(String message) { return false; }
        @Override public void showMessage(String message) { }
        @Override public String[] promptKeyboardInteractive(String destination, String name, String instruction, String[] prompt, boolean[] echo) {
            // one hidden prompt (the usual PAM "Password:") gets the password, once; OTP/multi-prompt challenges are declined
            if (password == null || prompt == null || prompt.length != 1 || echo[0] || kbdAnswers++ > 0) return null;
            return new String[] {password};
        }
    }

    /** Host key pinned by fingerprint (or none yet); remembers what the server presented for the error details. */
    static final class PinnedHostKey implements HostKeyRepository {
        private final String expected;
        volatile String observedFingerprint;
        volatile String observedType;
        volatile int result = NOT_INCLUDED;

        PinnedHostKey(String expected) { this.expected = expected; }

        @Override public int check(String host, byte[] key) {
            observedFingerprint = fingerprint(key);
            observedType = keyType(key);
            result = expected == null ? NOT_INCLUDED : MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII),
                    observedFingerprint.getBytes(StandardCharsets.US_ASCII)) ? OK : CHANGED;
            return result;
        }
        @Override public void add(HostKey hostkey, UserInfo ui) { }
        @Override public void remove(String host, String type) { }
        @Override public void remove(String host, String type, byte[] key) { }
        @Override public String getKnownHostsRepositoryID() { return "tabledb-pinned"; }
        @Override public HostKey[] getHostKey() { return new HostKey[0]; }
        @Override public HostKey[] getHostKey(String host, String type) { return new HostKey[0]; }
    }

    /** OpenSSH format: "SHA256:" + unpadded base64(sha256(key blob)). */
    static String fingerprint(byte[] blob) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(blob);
            return "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(d);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Algorithm name at the start of an SSH public key blob (uint32 length + ASCII). */
    static String keyType(byte[] blob) {
        if (blob == null || blob.length < 4) return "unknown";
        int n = ((blob[0] & 0xFF) << 24) | ((blob[1] & 0xFF) << 16) | ((blob[2] & 0xFF) << 8) | (blob[3] & 0xFF);
        if (n <= 0 || n > 64 || 4 + n > blob.length) return "unknown";
        String t = new String(blob, 4, n, StandardCharsets.US_ASCII);
        return t.matches("^[A-Za-z0-9@._-]+$") ? t : "unknown";
    }
}
