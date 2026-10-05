package vn.vnpay.tabledb.jdbc;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * Opens a TCP connection to host:port directly or through an HTTP CONNECT / SOCKS5 proxy (RFC 1928, username/password
 * per RFC 1929; HTTP Basic). Implemented here instead of java.net.Proxy because the JDK only takes SOCKS credentials from
 * a JVM-wide Authenticator. The target name is sent unresolved (the proxy resolves it). Errors never carry credentials.
 */
public final class ProxyDialer {
    private ProxyDialer() {}

    /** Failure attributable to the proxy itself (refused CONNECT, bad credentials, protocol error). */
    public static final class ProxyException extends IOException {
        public final boolean auth;
        ProxyException(String m, boolean auth) { super(m); this.auth = auth; }
    }

    public static Socket dial(Profile.Proxy proxy, String host, int port, int timeoutMs) throws IOException {
        Socket s = new Socket();
        boolean ok = false;
        try {
            s.setTcpNoDelay(true);
            if (proxy == null) {
                s.connect(new InetSocketAddress(host, port), timeoutMs);
            } else {
                s.connect(new InetSocketAddress(proxy.host(), proxy.port()), timeoutMs);
                s.setSoTimeout(timeoutMs);
                if (proxy.type().equals("socks")) socks5(s, proxy, host, port);
                else httpConnect(s, proxy, host, port);
                s.setSoTimeout(0);
            }
            ok = true;
            return s;
        } finally {
            if (!ok) try { s.close(); } catch (IOException ignored) { }
        }
    }

    static String unbracket(String host) {
        return host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
    }

    private static void httpConnect(Socket s, Profile.Proxy proxy, String host, int port) throws IOException {
        String authority = (host.startsWith("[") || host.indexOf(':') < 0 ? host : "[" + host + "]") + ":" + port;
        StringBuilder req = new StringBuilder("CONNECT ").append(authority).append(" HTTP/1.1\r\nHost: ").append(authority).append("\r\n");
        if (proxy.hasCredentials()) {
            String basic = Base64.getEncoder().encodeToString((proxy.username() + ":" + proxy.password()).getBytes(StandardCharsets.UTF_8));
            req.append("Proxy-Authorization: Basic ").append(basic).append("\r\n");
        }
        req.append("\r\n");
        OutputStream o = s.getOutputStream();
        o.write(req.toString().getBytes(StandardCharsets.ISO_8859_1));
        o.flush();
        InputStream in = s.getInputStream();
        String status = readLine(in);
        // drain headers up to the blank line (bounded) so the tunnel starts clean
        for (int i = 0; i < 100; i++) {
            String h = readLine(in);
            if (h.isEmpty()) break;
        }
        String[] parts = status.split(" ");
        if (parts.length >= 2 && parts[0].startsWith("HTTP/") && parts[1].equals("200")) return;
        String code = parts.length >= 2 ? parts[1].replaceAll("[^0-9]", "") : "";
        if (code.equals("407")) throw new ProxyException("proxy authentication required or rejected (HTTP 407)", true);
        throw new ProxyException("proxy refused CONNECT (" + (code.isEmpty() ? "no status" : "HTTP " + code) + ")", false);
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) >= 0 && c != '\n') {
            if (b.size() > 8192) throw new ProxyException("proxy response line too long", false);
            if (c != '\r') b.write(c);
        }
        if (c < 0 && b.size() == 0) throw new ProxyException("proxy closed the connection", false);
        return b.toString(StandardCharsets.ISO_8859_1);
    }

    private static void socks5(Socket s, Profile.Proxy proxy, String host, int port) throws IOException {
        OutputStream o = s.getOutputStream();
        InputStream in = s.getInputStream();
        boolean creds = proxy.hasCredentials();
        o.write(creds ? new byte[] {5, 2, 0, 2} : new byte[] {5, 1, 0});
        o.flush();
        int ver = readByte(in), method = readByte(in);
        if (ver != 5) throw new ProxyException("not a SOCKS5 proxy", false);
        if (method == 2 && creds) {
            byte[] u = proxy.username().getBytes(StandardCharsets.UTF_8), p = proxy.password().getBytes(StandardCharsets.UTF_8);
            if (u.length > 255 || p.length > 255) throw new ProxyException("proxy credentials too long", true);
            ByteArrayOutputStream a = new ByteArrayOutputStream();
            a.write(1); a.write(u.length); a.write(u); a.write(p.length); a.write(p);
            o.write(a.toByteArray());
            o.flush();
            readByte(in);
            if (readByte(in) != 0) throw new ProxyException("SOCKS5 proxy rejected the username/password", true);
        } else if (method == 0xFF) {
            throw new ProxyException(creds ? "SOCKS5 proxy accepts none of the offered authentication methods" : "SOCKS5 proxy requires authentication", true);
        } else if (method != 0) {
            throw new ProxyException("SOCKS5 proxy selected an unsupported method", false);
        }
        ByteArrayOutputStream r = new ByteArrayOutputStream();
        r.write(5); r.write(1); r.write(0);
        String h = unbracket(host);
        byte[] ip = literalIp(h);
        if (ip != null) {
            r.write(ip.length == 4 ? 1 : 4);
            r.write(ip);
        } else {
            byte[] name = h.getBytes(StandardCharsets.US_ASCII);
            if (name.length > 255) throw new ProxyException("host name too long for SOCKS5", false);
            r.write(3); r.write(name.length); r.write(name);
        }
        r.write((port >> 8) & 0xFF); r.write(port & 0xFF);
        o.write(r.toByteArray());
        o.flush();
        readByte(in);
        int rep = readByte(in);
        readByte(in);
        int atyp = readByte(in);
        int skip = switch (atyp) { case 1 -> 4; case 4 -> 16; case 3 -> readByte(in); default -> throw new ProxyException("bad SOCKS5 reply", false); };
        for (int i = 0; i < skip + 2; i++) readByte(in);
        if (rep != 0) throw new ProxyException("SOCKS5 proxy could not connect to the target (" + socksReply(rep) + ")", false);
    }

    private static String socksReply(int rep) {
        return switch (rep) {
            case 1 -> "general failure"; case 2 -> "not allowed by ruleset"; case 3 -> "network unreachable";
            case 4 -> "host unreachable"; case 5 -> "connection refused"; case 6 -> "TTL expired";
            default -> "code " + rep;
        };
    }

    /** IPv4 dotted quad or IPv6 literal (no DNS lookup); null for a host name. */
    static byte[] literalIp(String h) {
        if (h.matches("^\\d{1,3}(\\.\\d{1,3}){3}$") || h.indexOf(':') >= 0) {
            try { return java.net.InetAddress.getByName(h).getAddress(); } catch (java.net.UnknownHostException e) { return null; }
        }
        return null;
    }

    private static int readByte(InputStream in) throws IOException {
        int b = in.read();
        if (b < 0) throw new ProxyException("proxy closed the connection", false);
        return b;
    }
}
