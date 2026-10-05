package vn.vnpay.tabledb.jdbc;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

public final class PgVendor extends Vendor {
    @Override public String type() { return "postgresql"; }

    @Override public String url(Profile p) {
        return "jdbc:postgresql://" + p.host + ":" + p.port + "/" + (p.database == null ? "" : p.database);
    }

    @Override public Properties props(Profile p) {
        Properties pr = new Properties();
        pr.setProperty("user", p.username);
        if (p.password != null && !p.password.isEmpty()) pr.setProperty("password", p.password);
        pr.setProperty("ApplicationName", "TableDB");
        pr.setProperty("connectTimeout", Integer.toString(p.connectTimeoutSec));
        // pgjdbc ignores setReadOnly in autocommit unless readOnlyMode=always (session-level read only).
        pr.setProperty("readOnlyMode", "always");
        if (p.ssl) {
            pr.setProperty("ssl", "true");
            // through a tunnel the URL host is 127.0.0.1, so the certificate cannot match it: keep chain validation (verify-ca);
            // the SSH/proxy leg is authenticated separately (pinned host key)
            pr.setProperty("sslmode", p.routed ? "verify-ca" : "verify-full");
            pr.setProperty("sslfactory", "org.postgresql.ssl.DefaultJavaSSLFactory"); // JVM trust store
        } else {
            pr.setProperty("sslmode", "disable");
        }
        return pr;
    }

    @Override public List<String> catalogs(Connection c) throws SQLException {
        List<String> l = new ArrayList<>();
        String cat = c.getCatalog();
        if (cat != null) l.add(cat);
        return l;
    }

    @Override public List<String> defaultTableTypes() {
        return List.of("TABLE", "VIEW", "MATERIALIZED VIEW", "FOREIGN TABLE", "PARTITIONED TABLE");
    }

    @Override public boolean explainsDml() { return true; }

    /** EXPLAIN without ANALYZE plans only (the statement is not executed). */
    @Override public java.util.Map<String, Object> explain(Connection c, String sql, int timeoutSec) throws SQLException {
        try (java.sql.Statement st = c.createStatement()) {
            try { st.setQueryTimeout(timeoutSec); } catch (SQLException | RuntimeException ignored) { }
            try (ResultSet rs = st.executeQuery("EXPLAIN (FORMAT JSON, VERBOSE) " + sql)) {
                StringBuilder sb = new StringBuilder();
                while (rs.next()) sb.append(rs.getString(1));
                java.util.Map<String, Object> m = new java.util.LinkedHashMap<>();
                m.put("format", "json");
                m.put("plan", sb.toString());
                return m;
            }
        }
    }

    @Override public String nativeDdl(Connection c, String catalog, String schema, String table, String objType) throws SQLException {
        if (!"VIEW".equals(objType)) return null; // tables: synthesized from columns + PK + FK
        try (PreparedStatement ps = c.prepareStatement("SELECT pg_get_viewdef(to_regclass(?), true)")) {
            ps.setString(1, quote(schema) + "." + quote(table));
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next() && rs.getString(1) != null) {
                    return "CREATE VIEW " + quote(schema) + "." + quote(table) + " AS\n" + rs.getString(1).strip() + "\n";
                }
            }
        }
        return null;
    }
}
