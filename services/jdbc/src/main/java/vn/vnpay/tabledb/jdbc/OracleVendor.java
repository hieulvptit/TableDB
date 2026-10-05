package vn.vnpay.tabledb.jdbc;

import java.security.SecureRandom;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;

public final class OracleVendor extends Vendor {
    @Override public String type() { return "oracle"; }

    @Override public String url(Profile p) {
        if (p.database == null) throw RpcError.badRequest("profile.database (Oracle service name or SID) is required");
        if ("sid".equals(p.connectType)) {
            if (p.ssl || p.host.startsWith("[")) {
                String h = p.host.startsWith("[") ? p.host.substring(1, p.host.length() - 1) : p.host;
                return "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=" + (p.ssl ? "tcps" : "tcp") + ")(HOST=" + h + ")(PORT=" + p.port
                        + "))(CONNECT_DATA=(SID=" + p.database + ")))";
            }
            return "jdbc:oracle:thin:@" + p.host + ":" + p.port + ":" + p.database;
        }
        // serviceName form: //host:port/service
        return "jdbc:oracle:thin:@" + (p.ssl ? "tcps:" : "") + "//" + p.host + ":" + p.port + "/" + p.database;
    }

    @Override public Properties props(Profile p) {
        Properties pr = new Properties();
        pr.setProperty("user", p.username);
        pr.setProperty("password", p.password == null ? "" : p.password);
        pr.setProperty("oracle.net.CONNECT_TIMEOUT", Long.toString(p.connectTimeoutSec * 1000L));
        pr.setProperty("remarksReporting", "true");
        // through a tunnel the connect string host is 127.0.0.1: the server DN cannot match it (chain is still validated)
        if (p.routed && p.ssl) pr.setProperty("oracle.net.ssl_server_dn_match", "false");
        return pr;
    }

    @Override public List<String> catalogs(Connection c) { return List.of(); }

    private static final SecureRandom RND = new SecureRandom();

    @Override public void enableServerOutput(Connection c) {
        try (Statement st = c.createStatement()) {
            st.execute("BEGIN DBMS_OUTPUT.ENABLE(NULL); END;");
        } catch (SQLException e) {
            Log.debug("DBMS_OUTPUT.ENABLE failed (vendorCode=" + e.getErrorCode() + ")");
        }
    }

    @Override public List<String> readServerOutput(Connection c, int maxLines, int maxChars) {
        List<String> out = new ArrayList<>();
        int chars = 0;
        try (CallableStatement cs = c.prepareCall("BEGIN DBMS_OUTPUT.GET_LINE(?, ?); END;")) {
            cs.registerOutParameter(1, Types.VARCHAR);
            cs.registerOutParameter(2, Types.INTEGER);
            while (out.size() < maxLines && chars < maxChars) {
                cs.execute();
                if (cs.getInt(2) != 0) break;
                String line = cs.getString(1);
                if (line == null) line = "";
                chars += line.length();
                out.add(line);
            }
        } catch (SQLException e) {
            Log.debug("DBMS_OUTPUT.GET_LINE failed (vendorCode=" + e.getErrorCode() + ")");
        }
        return out;
    }

    @Override public boolean explainsDml() { return true; }

    /**
     * EXPLAIN PLAN into the session's PLAN_TABLE (a global temporary table since 10g, private to the session) under a random
     * statement id, then the rows of that plan. The statement itself is never executed.
     */
    @Override public Map<String, Object> explain(Connection c, String sql, int timeoutSec) throws SQLException {
        byte[] b = new byte[8];
        RND.nextBytes(b);
        String id = "TDB" + HexFormat.of().formatHex(b).toUpperCase(java.util.Locale.ROOT);
        try (Statement st = c.createStatement()) {
            try { st.setQueryTimeout(timeoutSec); } catch (SQLException | RuntimeException ignored) { }
            st.execute("EXPLAIN PLAN SET STATEMENT_ID = '" + id + "' FOR " + sql);
        }
        List<Map<String, Object>> cols = new ArrayList<>();
        List<List<Object>> rows = new ArrayList<>();
        try (PreparedStatement ps = c.prepareStatement("SELECT ID, PARENT_ID, DEPTH, OPERATION, OPTIONS, OBJECT_OWNER, OBJECT_NAME, COST, CARDINALITY, BYTES, "
                + "CPU_COST, IO_COST, TIME, ACCESS_PREDICATES, FILTER_PREDICATES FROM PLAN_TABLE WHERE STATEMENT_ID = ? ORDER BY ID")) {
            ps.setString(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                ResultSetMetaData md = rs.getMetaData();
                for (int i = 1; i <= md.getColumnCount(); i++) {
                    Map<String, Object> col = new LinkedHashMap<>();
                    col.put("name", md.getColumnLabel(i));
                    col.put("typeName", md.getColumnTypeName(i));
                    cols.add(col);
                }
                while (rs.next() && rows.size() < 5000) {
                    List<Object> r = new ArrayList<>();
                    for (int i = 1; i <= cols.size(); i++) r.add(ValueEncoder.read(rs, i, md.getColumnType(i)));
                    rows.add(r);
                }
            }
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("format", "table");
        m.put("columns", cols);
        m.put("rows", rows);
        return m;
    }

    @Override public String nativeDdl(Connection c, String catalog, String schema, String table, String objType) {
        String t = "VIEW".equals(objType) ? "VIEW" : "TABLE";
        try (PreparedStatement ps = c.prepareStatement("SELECT DBMS_METADATA.GET_DDL(?, ?, ?) FROM DUAL")) {
            ps.setString(1, t);
            ps.setString(2, table);
            ps.setString(3, schema);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    String d = rs.getString(1);
                    if (d != null && !d.isBlank()) return d.strip() + "\n";
                }
            }
        } catch (SQLException e) {
            // ORA-06550/ORA-01031 (no EXECUTE on DBMS_METADATA) etc.: fall back to synthesized DDL with the same account.
            Log.warn("DBMS_METADATA unavailable, synthesizing DDL (vendorCode=" + e.getErrorCode() + ")");
        }
        return null;
    }
}
