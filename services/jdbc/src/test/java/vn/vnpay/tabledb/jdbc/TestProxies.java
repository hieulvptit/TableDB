package vn.vnpay.tabledb.jdbc;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicInteger;

/** Minimal test-only HTTP CONNECT and SOCKS5 proxies on loopback (optional username/password). */
final class TestProxies {
    private TestProxies() {}

    static final class Proxy implements AutoCloseable {
        final ServerSocket ss;
        final String user, pass;
        final boolean socks;
        final AtomicInteger connects = new AtomicInteger();
        volatile String lastTarget;

        Proxy(boolean socks, String user, String pass) throws IOException {
            this.socks = socks;
            this.user = user;
            this.pass = pass;
            ss = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
            Thread.ofVirtual().start(this::loop);
        }

        int port() { return ss.getLocalPort(); }

        private void loop() {
            while (!ss.isClosed()) {
                try {
                    Socket c = ss.accept();
                    Thread.ofVirtual().start(() -> handle(c));
                } catch (IOException e) {
                    return;
                }
            }
        }

        private void handle(Socket c) {
            try {
                Socket up = socks ? socks(c) : http(c);
                if (up == null) { c.close(); return; }
                connects.incrementAndGet();
                Thread t = Thread.ofVirtual().start(() -> copy(up, c));
                copy(c, up);
                t.join();
                up.close();
                c.close();
            } catch (Exception e) {
                try { c.close(); } catch (IOException ignored) { }
            }
        }

        private Socket http(Socket c) throws IOException {
            InputStream in = c.getInputStream();
            String first = line(in);
            String auth = null;
            for (String h; !(h = line(in)).isEmpty(); ) {
                if (h.toLowerCase().startsWith("proxy-authorization:")) auth = h.substring(h.indexOf(':') + 1).trim();
            }
            OutputStream o = c.getOutputStream();
            if (user != null) {
                String want = "Basic " + Base64.getEncoder().encodeToString((user + ":" + pass).getBytes(StandardCharsets.UTF_8));
                if (!want.equals(auth)) {
                    o.write("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                    o.flush();
                    return null;
                }
            }
            String[] p = first.split(" ");
            String hp = p[1];
            int i = hp.lastIndexOf(':');
            String host = hp.substring(0, i).replace("[", "").replace("]", "");
            lastTarget = hp;
            Socket up = new Socket(host, Integer.parseInt(hp.substring(i + 1)));
            o.write("HTTP/1.1 200 Connection established\r\nX-Test: 1\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
            o.flush();
            return up;
        }

        private Socket socks(Socket c) throws IOException {
            DataInputStream in = new DataInputStream(c.getInputStream());
            OutputStream o = c.getOutputStream();
            in.readUnsignedByte();
            int n = in.readUnsignedByte();
            byte[] methods = in.readNBytes(n);
            int want = user == null ? 0 : 2;
            boolean offered = false;
            for (byte m : methods) if (m == want) offered = true;
            if (!offered) { o.write(new byte[] {5, (byte) 0xFF}); o.flush(); return null; }
            o.write(new byte[] {5, (byte) want});
            o.flush();
            if (want == 2) {
                in.readUnsignedByte();
                String u = new String(in.readNBytes(in.readUnsignedByte()), StandardCharsets.UTF_8);
                String pw = new String(in.readNBytes(in.readUnsignedByte()), StandardCharsets.UTF_8);
                boolean good = user.equals(u) && pass.equals(pw);
                o.write(new byte[] {1, (byte) (good ? 0 : 1)});
                o.flush();
                if (!good) return null;
            }
            in.readUnsignedByte(); in.readUnsignedByte(); in.readUnsignedByte();
            int atyp = in.readUnsignedByte();
            String host = switch (atyp) {
                case 1 -> InetAddress.getByAddress(in.readNBytes(4)).getHostAddress();
                case 4 -> InetAddress.getByAddress(in.readNBytes(16)).getHostAddress();
                case 3 -> new String(in.readNBytes(in.readUnsignedByte()), StandardCharsets.US_ASCII);
                default -> throw new IOException("atyp");
            };
            int port = in.readUnsignedShort();
            lastTarget = host + ":" + port;
            Socket up;
            try {
                up = new Socket(host, port);
            } catch (IOException e) {
                o.write(new byte[] {5, 5, 0, 1, 0, 0, 0, 0, 0, 0});
                o.flush();
                return null;
            }
            o.write(new byte[] {5, 0, 0, 1, 127, 0, 0, 1, 0, 0});
            o.flush();
            return up;
        }

        private static String line(InputStream in) throws IOException {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            int ch;
            while ((ch = in.read()) >= 0 && ch != '\n') if (ch != '\r') b.write(ch);
            return b.toString(StandardCharsets.ISO_8859_1);
        }

        private static void copy(Socket from, Socket to) {
            byte[] buf = new byte[8192];
            try {
                InputStream in = from.getInputStream();
                OutputStream out = to.getOutputStream();
                int n;
                while ((n = in.read(buf)) >= 0) { out.write(buf, 0, n); out.flush(); }
            } catch (IOException ignored) {
            } finally {
                try { to.shutdownOutput(); } catch (IOException ignored) { }
            }
        }

        @Override public void close() throws IOException { ss.close(); }
    }
}
