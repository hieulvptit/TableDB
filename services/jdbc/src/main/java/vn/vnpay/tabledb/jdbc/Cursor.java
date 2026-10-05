package vn.vnpay.tabledb.jdbc;

import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Open result set with paging; the total number of delivered rows is bounded by maxRows. */
public final class Cursor {
    public record Page(List<List<Object>> rows, boolean hasMore, boolean truncated) {}

    static final int PAGE_BYTE_BUDGET = 4 << 20; // keep one response well below the 8 MiB line limit

    public final String id;
    public final Session session;
    private final Statement st;
    private final ResultSet rs;
    private final int[] types;
    private final int maxRows;
    public final int pageSize;
    private final ValueEncoder.Limits limits;
    private int delivered;
    private boolean positioned;
    private boolean closed;
    /** the statement is closed with the cursor only once the cursor owns it (handed off to query.fetch) */
    private boolean ownsStatement = true;
    public volatile long lastUsed = System.nanoTime();

    public Cursor(String id, Session session, Statement st, ResultSet rs, int maxRows, int pageSize) throws SQLException {
        this(id, session, st, rs, maxRows, pageSize, ValueEncoder.Limits.DEFAULT);
    }

    public Cursor(String id, Session session, Statement st, ResultSet rs, int maxRows, int pageSize, ValueEncoder.Limits limits) throws SQLException {
        this.id = id;
        this.limits = limits;
        this.session = session;
        this.st = st;
        this.rs = rs;
        this.maxRows = maxRows;
        this.pageSize = pageSize;
        ResultSetMetaData md = rs.getMetaData();
        types = new int[md.getColumnCount()];
        for (int i = 0; i < types.length; i++) types[i] = md.getColumnType(i + 1);
    }

    public List<Map<String, Object>> columns() throws SQLException {
        ResultSetMetaData md = rs.getMetaData();
        List<Map<String, Object>> cols = new ArrayList<>();
        for (int i = 1; i <= types.length; i++) {
            Map<String, Object> c = new LinkedHashMap<>();
            c.put("name", md.getColumnLabel(i));
            c.put("typeName", md.getColumnTypeName(i));
            c.put("jdbcType", (long) types[i - 1]);
            cols.add(c);
        }
        return cols;
    }

    public int delivered() { return delivered; }

    /** Keep the statement open when the result set ends (the caller still reads further results from it). */
    Cursor keepStatement() { ownsStatement = false; return this; }
    void ownStatement() { ownsStatement = true; }
    public boolean isClosed() { return closed; }

    public Page fetch(int count) throws SQLException {
        lastUsed = System.nanoTime();
        int limit = Math.min(count, maxRows - delivered);
        List<List<Object>> rows = new ArrayList<>();
        long size = 0;
        boolean exhausted = false;
        while (rows.size() < limit) {
            if (!positioned && !rs.next()) { exhausted = true; break; }
            positioned = false;
            List<Object> row = new ArrayList<>(types.length);
            for (int i = 0; i < types.length; i++) {
                Object v = ValueEncoder.read(rs, i + 1, types[i], limits);
                size += ValueEncoder.approxSize(v);
                row.add(v);
            }
            rows.add(row);
            delivered++;
            if (size > PAGE_BYTE_BUDGET) break;
        }
        if (exhausted) {
            close();
            return new Page(rows, false, false);
        }
        if (!positioned) positioned = rs.next();
        if (delivered >= maxRows) {
            boolean more = positioned;
            close();
            return new Page(rows, false, more);
        }
        if (!positioned) {
            close();
            return new Page(rows, false, false);
        }
        return new Page(rows, true, false);
    }

    public void close() {
        if (closed) return;
        closed = true;
        session.cursors.remove(id);
        try { rs.close(); } catch (SQLException | RuntimeException ignored) { }
        if (ownsStatement) try { st.close(); } catch (SQLException | RuntimeException ignored) { }
    }
}
