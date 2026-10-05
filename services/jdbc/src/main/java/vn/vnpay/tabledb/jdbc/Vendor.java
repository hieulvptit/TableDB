package vn.vnpay.tabledb.jdbc;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;

/** Per-database-type behaviour: URL/property construction (from validated fields only) and DDL/catalog quirks. */
public abstract class Vendor {
    public abstract String type();

    /** JDBC URL built only from validated host/port/database; credentials and options go through properties. */
    public abstract String url(Profile p);

    public abstract Properties props(Profile p);

    /** Vendor properties plus the user's validated extra props; vendor-set keys are never overridden. */
    public final Properties allProps(Profile p) {
        Properties pr = props(p);
        for (var e : p.props.entrySet()) pr.putIfAbsent(e.getKey(), e.getValue());
        return pr;
    }

    public Connection connect(DriverShim driver, Profile p) throws SQLException {
        Connection c = driver.connect(url(p), allProps(p));
        if (c == null) throw new SQLException("driver refused URL");
        return c;
    }

    /** Called after connect: apply default schema / read-only defaults. Failures are non-fatal. */
    public void afterConnect(Connection c, Profile p) {
        if (p.schema != null) {
            try { c.setSchema(p.schema); } catch (SQLException | RuntimeException e) { Log.warn("setSchema failed: " + e.getClass().getSimpleName()); }
        }
    }

    public List<String> defaultTableTypes() { return List.of("TABLE", "VIEW"); }

    public boolean supportsKeys() { return true; }

    public List<String> catalogs(Connection c) throws SQLException {
        List<String> out = new ArrayList<>();
        try (ResultSet rs = c.getMetaData().getCatalogs()) {
            while (rs.next()) out.add(rs.getString(1));
        }
        return out;
    }

    /** Native DDL, or null to synthesize. {@code objType} is TABLE or VIEW (as reported by metadata). */
    public String nativeDdl(Connection c, String catalog, String schema, String table, String objType) throws SQLException {
        return null;
    }

    /** Called before a statement that asked for server output (Oracle DBMS_OUTPUT). */
    public void enableServerOutput(Connection c) { }

    /** Server output produced by the last statement (bounded), or an empty list. */
    public List<String> readServerOutput(Connection c, int maxLines, int maxChars) { return List.of(); }

    /** true when EXPLAIN of INSERT/UPDATE/DELETE/MERGE only plans (never executes) on this engine. */
    public boolean explainsDml() { return false; }

    /**
     * Plan of {@code sql} (already validated as one query/DML statement). Result: {format:"text", text} |
     * {format:"json", plan} | {format:"table", columns, rows}. Default: plain EXPLAIN, rows joined as text.
     */
    public Map<String, Object> explain(Connection c, String sql, int timeoutSec) throws SQLException {
        return textPlan(c, "EXPLAIN " + sql, timeoutSec);
    }

    static Map<String, Object> textPlan(Connection c, String explainSql, int timeoutSec) throws SQLException {
        StringBuilder sb = new StringBuilder();
        try (Statement st = c.createStatement()) {
            try { st.setQueryTimeout(timeoutSec); } catch (SQLException | RuntimeException ignored) { }
            try (ResultSet rs = st.executeQuery(explainSql)) {
                int n = rs.getMetaData().getColumnCount();
                while (rs.next() && sb.length() < 2_000_000) {
                    for (int i = 1; i <= n; i++) {
                        if (i > 1) sb.append('\t');
                        String v = rs.getString(i);
                        sb.append(v == null ? "" : v);
                    }
                    sb.append('\n');
                }
            }
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("format", "text");
        m.put("text", sb.toString());
        return m;
    }

    public static String quote(String ident) { return "\"" + ident.replace("\"", "\"\"") + "\""; }

    static DatabaseMetaData md(Connection c) throws SQLException { return c.getMetaData(); }
}
