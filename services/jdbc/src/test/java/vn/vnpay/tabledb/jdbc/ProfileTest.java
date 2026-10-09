package vn.vnpay.tabledb.jdbc;

import static org.junit.jupiter.api.Assertions.*;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class ProfileTest {
    static final Set<String> TYPES = Main.DRIVER_TYPES;

    static Map<String, Object> pg() {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("driver", "postgresql");
        p.put("host", "db.internal");
        p.put("port", 5432L);
        p.put("database", "app");
        p.put("auth", new LinkedHashMap<>(Map.of("type", "password", "username", "u", "password", "p")));
        p.put("options", new LinkedHashMap<String, Object>());
        return p;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> opts(Map<String, Object> p) { return (Map<String, Object>) p.get("options"); }

    static Profile parse(Map<String, Object> p) { return Profile.parse(new Params(p, "profile"), TYPES); }

    static void bad(Map<String, Object> p) {
        RpcError e = assertThrows(RpcError.class, () -> parse(p));
        assertEquals("E_BAD_REQUEST", e.code);
    }

    @Test void defaultsAreSafe() {
        Profile p = parse(pg());
        assertTrue(p.readOnly);
        assertFalse(p.allowWrite);
        assertFalse(p.ssl);
        assertEquals(15, p.connectTimeoutSec);
    }

    @Test void trinoExternalAlwaysUsesTlsIncludingThroughTunnel() {
        Map<String, Object> input = pg();
        input.put("driver", "trino");
        input.put("auth", Map.of("type", "trino-external"));
        opts(input).put("ssl", false);
        opts(input).put("props", Map.of("SSL", "false"));
        Profile profile = parse(input);
        assertTrue(profile.ssl);
        TrinoVendor vendor = new TrinoVendor(new EventBus());
        assertEquals("true", vendor.allProps(profile).getProperty("SSL"));
        Profile routed = profile.routedTo("127.0.0.1", 12345);
        assertEquals("true", vendor.allProps(routed).getProperty("SSL"));
        assertEquals("db.internal", vendor.allProps(routed).getProperty("hostnameInCertificate"));
    }

    @Test void unknownOptionKeysRejected() {
        for (String k : new String[] {"sslmode", "url", "jdbcUrl", "driverPath", "properties", "socketFactory", "loggerLevel"}) {
            Map<String, Object> p = pg();
            opts(p).put(k, "x");
            bad(p);
        }
    }

    @Test void unknownProfileAndAuthKeysRejected() {
        Map<String, Object> p = pg();
        p.put("url", "jdbc:postgresql://evil/db?x=y");
        bad(p);
        p = pg();
        p.put("driverPath", "/tmp/evil.jar");
        bad(p);
        p = pg();
        ((Map<String, Object>) p.get("auth")).put("extra", "x");
        bad(p);
    }

    @Test void hostCharactersValidated() {
        for (String h : new String[] {"a/b", "a?b", "a;b", "a=b", "a b", "h:5432", "h@x", "", "-x", "db.internal/x?ssl=false", "a\nb"}) {
            Map<String, Object> p = pg();
            p.put("host", h);
            bad(p);
        }
        for (String h : new String[] {"db.internal", "10.0.0.1", "[::1]", "db-1"}) {
            Map<String, Object> p = pg();
            p.put("host", h);
            assertEquals(h, parse(p).host);
        }
    }

    @Test void databaseAndSchemaValidated() {
        Map<String, Object> p = pg();
        p.put("database", "app?ssl=false");
        bad(p);
        p = pg();
        p.put("schema", "a;b");
        bad(p);
    }

    @Test void driverTypeAllowlist() {
        Map<String, Object> p = pg();
        p.put("driver", "mysql");
        bad(p);
        p.put("driver", "h2test");
        bad(p);
    }

    @Test void typesAndRanges() {
        Map<String, Object> p = pg();
        opts(p).put("ssl", "yes");
        bad(p);
        p = pg();
        opts(p).put("connectTimeoutSec", 0L);
        bad(p);
        p = pg();
        p.put("port", 70000L);
        bad(p);
        p = pg();
        opts(p).put("externalAuthTimeoutSec", 5L);
        bad(p);
    }

    @Test void authTypeMatrix() {
        Map<String, Object> p = pg();
        p.put("auth", new LinkedHashMap<>(Map.of("type", "trino-external")));
        bad(p); // not trino
        p = new LinkedHashMap<>();
        p.put("driver", "trino");
        p.put("host", "trino.internal");
        p.put("port", 443L);
        p.put("auth", new LinkedHashMap<>(Map.of("type", "trino-external")));
        Profile t = parse(p);
        assertEquals("trino-external", t.authType);
        p.put("auth", new LinkedHashMap<>(Map.of("type", "kerberos")));
        bad(p);
    }

    @Test void proxyForAnyDriverWithOptionalCredentials() {
        Map<String, Object> p = pg();
        opts(p).put("proxy", new LinkedHashMap<>(Map.of("type", "http", "host", "proxy", "port", 8080L)));
        Profile pp = parse(p);
        assertEquals("http", pp.proxy.type());
        assertFalse(pp.proxy.hasCredentials());
        assertTrue(Tunnel.needed(pp), "non-Trino drivers go through the local relay");
        opts(p).put("proxy", new LinkedHashMap<>(Map.of("type", "socks", "host", "proxy", "port", 1080L, "username", "u", "password", "px-Secret-1")));
        pp = parse(p);
        assertTrue(pp.proxy.hasCredentials());
        assertTrue(java.util.Arrays.asList(pp.secrets()).contains("px-Secret-1"));
        opts(p).put("proxy", new LinkedHashMap<>(Map.of("type", "socks", "host", "proxy", "port", 1080L, "password", "orphan")));
        bad(p);
        opts(p).put("proxy", new LinkedHashMap<>(Map.of("type", "socks", "host", "proxy", "port", 1080L, "username", "a\nb")));
        bad(p);
        opts(p).put("proxy", new LinkedHashMap<>(Map.of("type", "https", "host", "proxy", "port", 1080L)));
        bad(p);
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("driver", "trino");
        t.put("host", "trino.internal");
        t.put("port", 443L);
        t.put("auth", new LinkedHashMap<>(Map.of("type", "trino-jwt", "token", "x.y.z")));
        t.put("options", new LinkedHashMap<>(Map.of("proxy", new LinkedHashMap<>(Map.of("type", "socks", "host", "px", "port", 1080L)))));
        assertEquals("socks", parse(t).proxy.type());
        assertFalse(Tunnel.needed(parse(t)), "Trino uses its native proxy properties when no credentials are needed");
        ((Map<String, Object>) ((Map<String, Object>) t.get("options")).get("proxy")).put("host", "px/evil");
        bad(t);
    }

    @Test void urlsAreBuiltOnlyFromValidatedFields() {
        Profile p = parse(pg());
        assertEquals("jdbc:postgresql://db.internal:5432/app", new PgVendor().url(p));
        Map<String, Object> o = pg();
        o.put("driver", "oracle");
        o.put("port", 1521L);
        o.put("database", "SVC.EXAMPLE");
        opts(o).put("ssl", true);
        assertEquals("jdbc:oracle:thin:@tcps://db.internal:1521/SVC.EXAMPLE", new OracleVendor().url(parse(o)));
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("driver", "trino");
        t.put("host", "trino.internal");
        t.put("port", 443L);
        t.put("database", "hive");
        t.put("schema", "web");
        t.put("auth", new LinkedHashMap<>(Map.of("type", "password", "username", "u", "password", "p")));
        assertEquals("jdbc:trino://trino.internal:443/hive/web", new TrinoVendor(new EventBus()).url(parse(t)));
    }

    @Test void credentialsGoThroughPropertiesNotUrl() {
        Map<String, Object> m = pg();
        ((Map<String, Object>) m.get("auth")).put("password", "p@ss;word=1&x");
        Profile p = parse(m);
        assertFalse(new PgVendor().url(p).contains("p@ss"));
        assertEquals("p@ss;word=1&x", new PgVendor().props(p).getProperty("password"));
        assertEquals("disable", new PgVendor().props(p).getProperty("sslmode"));
        opts(m).put("ssl", true);
        assertEquals("verify-full", new PgVendor().props(parse(m)).getProperty("sslmode"));
    }

    @Test void trinoPropertiesForSso() {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("driver", "trino");
        t.put("host", "trino.internal");
        t.put("port", 443L);
        t.put("auth", new LinkedHashMap<>(Map.of("type", "trino-external")));
        t.put("options", new LinkedHashMap<>(Map.of("ssl", true, "externalAuthTimeoutSec", 120L,
                "proxy", new LinkedHashMap<>(Map.of("type", "http", "host", "px", "port", 3128L)))));
        var pr = new TrinoVendor(new EventBus()).props(parse(t));
        assertEquals("true", pr.getProperty("externalAuthentication"));
        assertEquals("120s", pr.getProperty("externalAuthenticationTimeout"));
        assertEquals("px:3128", pr.getProperty("httpProxy"));
        assertNull(pr.getProperty("socksProxy"));
        assertEquals("true", pr.getProperty("SSL"));
    }

    static Map<String, Object> oracle(String db) {
        Map<String, Object> o = pg();
        o.put("driver", "oracle");
        o.put("port", 1521L);
        o.put("database", db);
        return o;
    }

    @Test void oracleServiceNameAndSidUrls() {
        Map<String, Object> o = oracle("BISVC");
        assertEquals("jdbc:oracle:thin:@//db.internal:1521/BISVC", new OracleVendor().url(parse(o)));
        assertEquals("serviceName", parse(o).connectType);
        opts(o).put("connectType", "sid");
        assertEquals("jdbc:oracle:thin:@db.internal:1521:BISVC", new OracleVendor().url(parse(o)));
        opts(o).put("ssl", true);
        assertEquals("jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=tcps)(HOST=db.internal)(PORT=1521))(CONNECT_DATA=(SID=BISVC)))", new OracleVendor().url(parse(o)));
        opts(o).put("connectType", "serviceName");
        assertEquals("jdbc:oracle:thin:@tcps://db.internal:1521/BISVC", new OracleVendor().url(parse(o)));
        opts(o).put("connectType", "other");
        bad(o);
    }

    @Test void connectTypeOnlyForOracle() {
        Map<String, Object> p = pg();
        opts(p).put("connectType", "sid");
        bad(p);
        assertNull(parse(pg()).connectType);
    }

    @Test void propsValidation() {
        Map<String, Object> p = pg();
        opts(p).put("props", new LinkedHashMap<>(Map.of("ApplicationName", "x", "oracle.jdbc.ReadTimeout", "5000")));
        Profile ok = parse(p);
        assertEquals("5000", ok.props.get("oracle.jdbc.ReadTimeout"));
        assertTrue(java.util.Arrays.asList(ok.secrets()).contains("5000"));
        for (String k : new String[] {"user", "PASSWORD", "javax.net.ssl.trustStore", "JAVA.x", "oracle.net.wallet_location", "Oracle.JDBC.libraryPath", "1abc", "a b", "a=b", ""}) {
            Map<String, Object> q = pg();
            opts(q).put("props", new LinkedHashMap<>(Map.of(k, "v")));
            bad(q);
        }
        Map<String, Object> q = pg();
        opts(q).put("props", new LinkedHashMap<>(Map.of("a", 1L)));
        bad(q);
        q = pg();
        opts(q).put("props", new LinkedHashMap<>(Map.of("a", "x".repeat(513))));
        bad(q);
        q = pg();
        opts(q).put("props", new LinkedHashMap<>(Map.of("a", "x\0y")));
        bad(q);
        q = pg();
        Map<String, Object> many = new LinkedHashMap<>();
        for (int i = 0; i < 21; i++) many.put("k" + i, "v");
        opts(q).put("props", many);
        bad(q);
        many.remove("k0");
        assertEquals(20, parse(q).props.size());
    }

    @Test void vendorPropsWinOverUserProps() {
        Map<String, Object> p = pg();
        opts(p).put("props", new LinkedHashMap<>(Map.of("readOnlyMode", "off", "loginTimeout", "3")));
        var pr = new PgVendor().allProps(parse(p));
        assertEquals("always", pr.getProperty("readOnlyMode"));
        assertEquals("3", pr.getProperty("loginTimeout"));
    }

    @Test void customDriverProfileRules() {
        Set<String> t = Set.of("custom", "postgresql");
        Map<String, Object> c = new LinkedHashMap<>(pg());
        c.put("driver", "custom");
        assertEquals("E_BAD_REQUEST", assertThrows(RpcError.class, () -> Profile.parse(new Params(c, "profile"), t)).code); // no driverId
        c.put("driverId", "my-db");
        assertEquals(5432L, (long) Profile.parse(new Params(c, "profile"), t).port);
        c.remove("port");
        assertEquals("E_BAD_REQUEST", assertThrows(RpcError.class, () -> Profile.parse(new Params(c, "profile"), t)).code); // port required
        assertEquals(1234, Profile.parse(new Params(c, "profile"), t, id -> 1234).port);
        c.put("driverId", "bad/id");
        assertEquals("E_BAD_REQUEST", assertThrows(RpcError.class, () -> Profile.parse(new Params(c, "profile"), t, id -> 1)).code);
        Map<String, Object> p = pg();
        p.put("driverId", "x");
        bad(p); // driverId on a builtin
        Map<String, Object> notAllowed = new LinkedHashMap<>(pg());
        notAllowed.put("driver", "custom");
        notAllowed.put("driverId", "x");
        bad(notAllowed); // "custom" is not in TYPES
    }
}
