package vn.vnpay.tabledb.jdbc;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Metadata via the session's own DatabaseMetaData only (no secondary account). */
public final class Meta {
    private Meta() {}

    public static Map<String, Object> catalogs(Session s) throws SQLException {
        return Map.of("catalogs", s.vendor.catalogs(s.conn));
    }

    public static Map<String, Object> schemas(Session s, String catalog) throws SQLException {
        List<String> out = new ArrayList<>();
        try (ResultSet rs = s.conn.getMetaData().getSchemas(catalog, null)) {
            while (rs.next()) out.add(rs.getString("TABLE_SCHEM"));
        }
        out.sort(Comparator.nullsFirst(String::compareTo));
        return Map.of("schemas", out);
    }

    static String escape(DatabaseMetaData md, String s) throws SQLException {
        String esc = md.getSearchStringEscape();
        if (esc == null || esc.isEmpty()) return s;
        return s.replace(esc, esc + esc).replace("_", esc + "_").replace("%", esc + "%");
    }

    public static Map<String, Object> tables(Session s, String catalog, String schema, List<String> types) throws SQLException {
        DatabaseMetaData md = s.conn.getMetaData();
        String[] tt = (types == null || types.isEmpty() ? s.vendor.defaultTableTypes() : types).toArray(new String[0]);
        List<Map<String, Object>> out = new ArrayList<>();
        try (ResultSet rs = md.getTables(catalog, escape(md, schema), "%", tt)) {
            while (rs.next()) {
                Map<String, Object> t = new LinkedHashMap<>();
                t.put("name", rs.getString("TABLE_NAME"));
                t.put("type", rs.getString("TABLE_TYPE"));
                t.put("remarks", rs.getString("REMARKS"));
                out.add(t);
            }
        }
        out.sort(Comparator.comparing(m -> String.valueOf(m.get("name"))));
        return Map.of("tables", out);
    }

    /** Returns the TABLE_TYPE of an exact table match, or null. */
    static String tableType(Connection c, String catalog, String schema, String table) throws SQLException {
        DatabaseMetaData md = c.getMetaData();
        try (ResultSet rs = md.getTables(catalog, escape(md, schema), escape(md, table), null)) {
            while (rs.next()) {
                if (table.equals(rs.getString("TABLE_NAME"))) return rs.getString("TABLE_TYPE");
            }
        }
        return null;
    }

    record Col(String name, String typeName, int jdbcType, int size, Integer scale, boolean nullable, int position, String remarks, String def) {
        Map<String, Object> json() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", name);
            m.put("typeName", typeName);
            m.put("jdbcType", (long) jdbcType);
            m.put("size", (long) size);
            m.put("scale", scale == null ? null : (long) scale);
            m.put("nullable", nullable);
            m.put("position", (long) position);
            m.put("remarks", remarks);
            m.put("default", def);
            return m;
        }
    }

    record Fk(String name, List<String> cols, String refCatalog, String refSchema, String refTable, List<String> refCols) {
        Map<String, Object> json() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("columns", cols);
            m.put("refCatalog", refCatalog);
            m.put("refSchema", refSchema);
            m.put("refTable", refTable);
            m.put("refColumns", refCols);
            m.put("name", name);
            return m;
        }
    }

    static List<Col> readColumns(DatabaseMetaData md, String catalog, String schema, String table) throws SQLException {
        List<Col> cols = new ArrayList<>();
        try (ResultSet rs = md.getColumns(catalog, escape(md, schema), table == null ? "%" : escape(md, table), "%")) {
            while (rs.next()) {
                if (table != null && !table.equals(rs.getString("TABLE_NAME"))) continue;
                int scaleRaw = rs.getInt("DECIMAL_DIGITS");
                Integer scale = rs.wasNull() ? null : scaleRaw;
                cols.add(new Col(rs.getString("COLUMN_NAME"), rs.getString("TYPE_NAME"), rs.getInt("DATA_TYPE"),
                        rs.getInt("COLUMN_SIZE"), scale, rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls,
                        rs.getInt("ORDINAL_POSITION"), rs.getString("REMARKS"), rs.getString("COLUMN_DEF")));
            }
        }
        cols.sort(Comparator.comparingInt(Col::position));
        return cols;
    }

    static List<String> readPk(Session s, String catalog, String schema, String table) {
        if (!s.vendor.supportsKeys()) return List.of();
        TreeMap<Integer, String> pk = new TreeMap<>();
        try (ResultSet rs = s.conn.getMetaData().getPrimaryKeys(catalog, schema, table)) {
            while (rs.next()) pk.put(rs.getInt("KEY_SEQ"), rs.getString("COLUMN_NAME"));
        } catch (SQLException | RuntimeException e) {
            Log.debug("getPrimaryKeys failed: " + e.getClass().getSimpleName());
        }
        return new ArrayList<>(pk.values());
    }

    static List<Fk> readFks(Session s, String catalog, String schema, String table) {
        if (!s.vendor.supportsKeys()) return List.of();
        Map<String, List<Object[]>> groups = new LinkedHashMap<>();
        try (ResultSet rs = s.conn.getMetaData().getImportedKeys(catalog, schema, table)) {
            while (rs.next()) {
                String name = rs.getString("FK_NAME");
                String pkTable = rs.getString("PKTABLE_NAME");
                String key = (name != null ? name : "") + "|" + pkTable + "|" + rs.getString("PKTABLE_SCHEM");
                groups.computeIfAbsent(key, k -> new ArrayList<>()).add(new Object[] {
                        rs.getInt("KEY_SEQ"), rs.getString("FKCOLUMN_NAME"), rs.getString("PKCOLUMN_NAME"),
                        name, rs.getString("PKTABLE_CAT"), rs.getString("PKTABLE_SCHEM"), pkTable});
            }
        } catch (SQLException | RuntimeException e) {
            Log.debug("getImportedKeys failed: " + e.getClass().getSimpleName());
        }
        List<Fk> out = new ArrayList<>();
        for (List<Object[]> g : groups.values()) {
            g.sort(Comparator.comparingInt(a -> (Integer) a[0]));
            List<String> c = new ArrayList<>();
            List<String> rc = new ArrayList<>();
            for (Object[] a : g) { c.add((String) a[1]); rc.add((String) a[2]); }
            Object[] f = g.get(0);
            out.add(new Fk((String) f[3], c, (String) f[4], (String) f[5], (String) f[6], rc));
        }
        return out;
    }

    public static Map<String, Object> columns(Session s, String catalog, String schema, String table) throws SQLException {
        DatabaseMetaData md = s.conn.getMetaData();
        List<Col> cols = readColumns(md, catalog, schema, table);
        if (cols.isEmpty() && tableType(s.conn, catalog, schema, table) == null) throw RpcError.notFound("table not found");
        Map<String, Object> out = new LinkedHashMap<>();
        List<Map<String, Object>> cj = new ArrayList<>();
        for (Col c : cols) cj.add(c.json());
        out.put("columns", cj);
        out.put("primaryKey", readPk(s, catalog, schema, table));
        List<Map<String, Object>> fj = new ArrayList<>();
        for (Fk f : readFks(s, catalog, schema, table)) fj.add(f.json());
        out.put("foreignKeys", fj);
        return out;
    }

    public static Map<String, Object> ddl(Session s, String catalog, String schema, String table) throws SQLException {
        String type = tableType(s.conn, catalog, schema, table);
        if (type == null) throw RpcError.notFound("table not found");
        String objType = type.contains("VIEW") ? "VIEW" : "TABLE";
        String nat;
        try {
            nat = s.vendor.nativeDdl(s.conn, catalog, schema, table, objType);
        } catch (SQLException e) {
            // permission errors surface as E_POLICY (mapped in fromSql); never retried with another account
            throw RpcError.fromSql(e, s.profile.secrets());
        }
        Map<String, Object> out = new LinkedHashMap<>();
        if (nat != null) {
            out.put("ddl", nat);
            out.put("source", "native");
        } else {
            List<Col> cols = readColumns(s.conn.getMetaData(), catalog, schema, table);
            out.put("ddl", synthesize(schema, table, objType, cols, readPk(s, catalog, schema, table), readFks(s, catalog, schema, table)));
            out.put("source", "synthesized");
        }
        return out;
    }

    static String synthesize(String schema, String table, String objType, List<Col> cols, List<String> pk, List<Fk> fks) {
        StringBuilder sb = new StringBuilder();
        if (objType.equals("VIEW")) {
            sb.append("-- view definition unavailable; column list only\n");
        }
        sb.append("CREATE TABLE ").append(Vendor.quote(schema)).append('.').append(Vendor.quote(table)).append(" (\n");
        List<String> lines = new ArrayList<>();
        for (Col c : cols) {
            StringBuilder l = new StringBuilder("  ").append(Vendor.quote(c.name())).append(' ').append(typeText(c));
            if (!c.nullable()) l.append(" NOT NULL");
            if (c.def() != null) l.append(" DEFAULT ").append(c.def());
            lines.add(l.toString());
        }
        if (!pk.isEmpty()) lines.add("  PRIMARY KEY (" + quoteList(pk) + ")");
        for (Fk f : fks) {
            StringBuilder l = new StringBuilder("  ");
            if (f.name() != null) l.append("CONSTRAINT ").append(Vendor.quote(f.name())).append(' ');
            l.append("FOREIGN KEY (").append(quoteList(f.cols())).append(") REFERENCES ");
            if (f.refSchema() != null) l.append(Vendor.quote(f.refSchema())).append('.');
            l.append(Vendor.quote(f.refTable())).append(" (").append(quoteList(f.refCols())).append(')');
            lines.add(l.toString());
        }
        sb.append(String.join(",\n", lines)).append("\n);\n");
        return sb.toString();
    }

    private static String quoteList(List<String> l) {
        List<String> q = new ArrayList<>();
        for (String s : l) q.add(Vendor.quote(s));
        return String.join(", ", q);
    }

    private static String typeText(Col c) {
        String t = c.typeName() == null ? "unknown" : c.typeName();
        if (t.contains("(")) return t;
        switch (c.jdbcType()) {
            case Types.VARCHAR, Types.CHAR, Types.NVARCHAR, Types.NCHAR, Types.VARBINARY, Types.BINARY -> {
                if (c.size() > 0 && c.size() < 1_000_000) return t + "(" + c.size() + ")";
            }
            case Types.DECIMAL, Types.NUMERIC -> {
                if (c.size() > 0 && c.size() < 1000) return t + "(" + c.size() + (c.scale() != null && c.scale() > 0 ? "," + c.scale() : "") + ")";
            }
            default -> { }
        }
        return t;
    }

    public static Map<String, Object> fingerprint(Session s, String catalog, String schema) throws SQLException {
        DatabaseMetaData md = s.conn.getMetaData();
        List<String> lines = new ArrayList<>();
        try (ResultSet rs = md.getTables(catalog, escape(md, schema), "%", s.vendor.defaultTableTypes().toArray(new String[0]))) {
            while (rs.next()) lines.add("T|" + rs.getString("TABLE_NAME") + "|" + rs.getString("TABLE_TYPE"));
        }
        try (ResultSet rs = md.getColumns(catalog, escape(md, schema), "%", "%")) {
            while (rs.next()) {
                lines.add("C|" + rs.getString("TABLE_NAME") + "|" + rs.getString("COLUMN_NAME") + "|" + rs.getString("TYPE_NAME")
                        + "|" + rs.getInt("COLUMN_SIZE") + "|" + rs.getInt("DECIMAL_DIGITS") + "|" + rs.getInt("NULLABLE")
                        + "|" + rs.getInt("ORDINAL_POSITION"));
            }
        }
        java.util.Collections.sort(lines);
        return Map.of("fingerprint", Redactor.sha256Hex(String.join("\n", lines)));
    }
}
