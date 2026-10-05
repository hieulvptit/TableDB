package vn.vnpay.tabledb.jdbc;

import java.net.Socket;
import java.util.LinkedHashMap;
import java.util.Map;

/** diag.proxy: TCP reachability of host:port, directly or through an http(CONNECT)/socks5 proxy (optional credentials). */
public final class Diag {
    private Diag() {}

    public static Map<String, Object> proxyCheck(String host, int port, Profile.Proxy proxy, int timeoutMs) {
        long t0 = System.nanoTime();
        String err = null;
        boolean ok = false;
        try (Socket s = ProxyDialer.dial(proxy, host, port, timeoutMs)) {
            ok = true;
        } catch (ProxyDialer.ProxyException e) {
            err = e.getMessage();
        } catch (java.io.IOException e) {
            err = Tunnel.netMessage(e);
        } catch (RuntimeException e) {
            err = e.getClass().getSimpleName();
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("reachable", ok);
        m.put("latencyMs", (System.nanoTime() - t0) / 1_000_000L);
        if (err != null) m.put("error", Redactor.scrub(err, proxy == null ? null : new String[] {proxy.password()}));
        return m;
    }
}
