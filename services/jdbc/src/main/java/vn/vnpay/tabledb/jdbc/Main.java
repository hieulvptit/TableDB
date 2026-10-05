package vn.vnpay.tabledb.jdbc;

import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

public final class Main {
    public static final Set<String> DRIVER_TYPES = Set.of("postgresql", "oracle", "trino");

    private Main() {}

    /** drivers/ next to the jar (or next to classes/ when run from a build directory). Never taken from a request. */
    static Path driversDir() {
        try {
            Path loc = Paths.get(Main.class.getProtectionDomain().getCodeSource().getLocation().toURI()).toAbsolutePath();
            Path base = Files.isDirectory(loc) ? loc.getParent() : loc.getParent();
            return base.resolve("drivers");
        } catch (URISyntaxException | RuntimeException e) {
            return Paths.get("drivers").toAbsolutePath();
        }
    }

    static String version() {
        String v = Main.class.getPackage().getImplementationVersion();
        return v == null ? "0.1.0-dev" : v;
    }

    /** The only production vendors; the set of allowed driver types is derived from it. */
    static Map<String, Vendor> productionVendors(EventBus bus) {
        Map<String, Vendor> m = new LinkedHashMap<>();
        m.put("postgresql", new PgVendor());
        m.put("oracle", new OracleVendor());
        m.put("trino", new TrinoVendor(bus));
        return m;
    }

    static Dispatcher production(Config cfg) { return production(cfg, null, null); }

    /** @param customDrivers app-data dir of user-imported drivers (from --custom-drivers; never from a request) or null */
    /** @param sshKeys app-data dir of imported SSH private keys (from --ssh-keys; never from a request) or null */
    static Dispatcher production(Config cfg, Path customDrivers, Path sshKeys) {
        EventBus bus = new EventBus();
        DriverRegistry reg = new DriverRegistry(driversDir(), DRIVER_TYPES, customDrivers);
        return new Dispatcher(reg, productionVendors(bus), new SessionManager(cfg), bus, version(), new SshKeys(sshKeys));
    }

    public static void main(String[] args) throws Exception {
        boolean stdio = false, http = false;
        String bind = "127.0.0.1";
        int port = -1;
        String keystore = null;
        Path customDrivers = null;
        Path sshKeys = null;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--stdio" -> stdio = true;
                case "--http" -> http = true;
                case "--bind" -> bind = need(args, ++i);
                case "--port" -> port = Integer.parseInt(need(args, ++i));
                case "--tls-keystore" -> keystore = need(args, ++i);
                case "--custom-drivers" -> customDrivers = Paths.get(need(args, ++i)).toAbsolutePath();
                case "--ssh-keys" -> sshKeys = Paths.get(need(args, ++i)).toAbsolutePath();
                case "--version" -> { System.out.println(version()); return; }
                default -> usage("unknown argument " + args[i]);
            }
        }
        if (stdio == http) usage("choose exactly one of --stdio or --http");

        if (stdio) {
            OutputStream protocolOut = new FileOutputStream(FileDescriptor.out);
            InputStream protocolIn = new FileInputStream(FileDescriptor.in);
            System.setOut(System.err); // anything printing to System.out (e.g. driver helpers) must not corrupt the protocol stream
            Dispatcher d = production(Config.fromEnv(), customDrivers, sshKeys);
            new StdioServer(d, protocolIn, protocolOut).run();
            return;
        }

        if (port < 0 || port > 65535) usage("--port is required for --http");
        String token = System.getenv("JDBC_SERVICE_TOKEN");
        if (token == null || token.isEmpty()) {
            System.err.println("JDBC_SERVICE_TOKEN must be set for --http");
            System.exit(2);
        }
        javax.net.ssl.SSLContext tls = keystore == null ? null : tlsContext(keystore);
        boolean loopback = java.net.InetAddress.getByName(bind).isLoopbackAddress();
        if (!loopback && tls == null) Log.warn("binding to a non-loopback address without TLS; terminate TLS in a reverse proxy");
        HttpService svc = new HttpService(production(Config.fromEnv(), customDrivers, sshKeys), token, bind, port, tls);
        svc.start();
        Log.info("http service listening on " + bind + ":" + svc.port());
        Runtime.getRuntime().addShutdownHook(new Thread(svc::close));
        Thread.currentThread().join();
    }

    private static javax.net.ssl.SSLContext tlsContext(String keystore) throws Exception {
        char[] pw = System.getenv().getOrDefault("JDBC_TLS_KEYSTORE_PASSWORD", "").toCharArray();
        java.security.KeyStore ks = java.security.KeyStore.getInstance("PKCS12");
        try (InputStream in = Files.newInputStream(Paths.get(keystore))) { ks.load(in, pw); }
        javax.net.ssl.KeyManagerFactory kmf = javax.net.ssl.KeyManagerFactory.getInstance(javax.net.ssl.KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(ks, pw);
        javax.net.ssl.SSLContext ctx = javax.net.ssl.SSLContext.getInstance("TLS");
        ctx.init(kmf.getKeyManagers(), null, null);
        return ctx;
    }

    private static String need(String[] a, int i) {
        if (i >= a.length) usage("missing value for " + a[i - 1]);
        return a[i];
    }

    private static void usage(String msg) {
        System.err.println(msg);
        System.err.println("usage: java -jar tabledb-jdbc.jar --stdio | --http [--bind 127.0.0.1] --port N [--tls-keystore file.p12] [--custom-drivers dir] [--ssh-keys dir]");
        System.exit(2);
    }
}
