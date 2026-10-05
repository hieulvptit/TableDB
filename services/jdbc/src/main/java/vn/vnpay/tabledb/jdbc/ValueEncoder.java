package vn.vnpay.tabledb.jdbc;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.Array;
import java.sql.Blob;
import java.sql.Clob;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Time;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.OffsetTime;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * JSON value encoding per SIDECAR-PROTOCOL: safe integers -> number; BIGINT/DECIMAL -> string;
 * temporal -> ISO-8601 string; binary -> {"$binary": base64 (max 256 bytes), "length": n}; NULL -> null.
 */
public final class ValueEncoder {
    public static final long MAX_SAFE = 9007199254740991L; // 2^53 - 1
    public static final int BINARY_PREVIEW = 256;
    static final int MAX_TEXT = 1 << 20; // per-value text cap for LOB reads (chars)
    /** Largest per-value cap a query may ask for with {@code lobLimit} (keeps one row well below the 8 MiB line). */
    public static final int MAX_LOB_LIMIT = 3 << 20;

    /** Per-query caps: binary bytes returned (base64) and CLOB characters. */
    public record Limits(int binary, int text) {
        public static final Limits DEFAULT = new Limits(BINARY_PREVIEW, MAX_TEXT);
        /** {@code lobLimit} bytes of binary; text is capped at half as many characters (UTF-8 of CJK/Vietnamese is 2–3 bytes). */
        public static Limits of(int lobLimit) {
            if (lobLimit <= BINARY_PREVIEW) return DEFAULT;
            int b = Math.min(lobLimit, MAX_LOB_LIMIT);
            return new Limits(b, Math.max(MAX_TEXT, b / 2));
        }
    }

    private ValueEncoder() {}

    public static Object read(ResultSet rs, int col, int jdbcType) throws SQLException {
        return read(rs, col, jdbcType, Limits.DEFAULT);
    }

    public static Object read(ResultSet rs, int col, int jdbcType, Limits lim) throws SQLException {
        Object o;
        if (jdbcType == Types.TIMESTAMP_WITH_TIMEZONE || jdbcType == -101 || jdbcType == -102) {
            try {
                o = rs.getObject(col, OffsetDateTime.class);
            } catch (SQLException | RuntimeException e) {
                o = rs.getObject(col);
            }
        } else {
            o = rs.getObject(col);
        }
        if (o == null || rs.wasNull()) return null;
        return encode(o, lim);
    }

    public static Object encode(Object o) { return encode(o, Limits.DEFAULT); }

    public static Object encode(Object o, Limits lim) {
        try {
            return enc(o, 0, lim);
        } catch (SQLException e) {
            return null;
        }
    }

    private static Object enc(Object o, int depth, Limits lim) throws SQLException {
        if (o == null) return null;
        if (o instanceof String s) return s;
        if (o instanceof Boolean b) return b;
        if (o instanceof Integer || o instanceof Short || o instanceof Byte) return ((Number) o).longValue();
        if (o instanceof Long l) return (l >= -MAX_SAFE && l <= MAX_SAFE) ? (Object) l : Long.toString(l);
        if (o instanceof BigInteger bi) return bi.toString();
        if (o instanceof BigDecimal bd) return bd.toPlainString();
        if (o instanceof Double || o instanceof Float) {
            double d = ((Number) o).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) return Double.toString(d);
            if (d == Math.rint(d) && Math.abs(d) > MAX_SAFE) return new BigDecimal(d).toPlainString();
            return (o instanceof Float f) ? Double.valueOf(Float.toString(f)) : (Double) d;
        }
        if (o instanceof Number n) return n.toString();
        if (o instanceof Timestamp t) return t.toLocalDateTime().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME);
        if (o instanceof java.sql.Date d) return d.toLocalDate().toString();
        if (o instanceof Time t) return t.toLocalTime().format(DateTimeFormatter.ISO_LOCAL_TIME);
        if (o instanceof LocalDateTime t) return t.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME);
        if (o instanceof LocalDate d) return d.toString();
        if (o instanceof LocalTime t) return t.format(DateTimeFormatter.ISO_LOCAL_TIME);
        if (o instanceof OffsetDateTime t) return t.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME);
        if (o instanceof OffsetTime t) return t.format(DateTimeFormatter.ISO_OFFSET_TIME);
        if (o instanceof ZonedDateTime t) return t.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME);
        if (o instanceof Instant t) return t.atOffset(ZoneOffset.UTC).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME);
        if (o instanceof byte[] b) return binary(b, b.length, lim);
        if (o instanceof Blob b) {
            long len = b.length();
            int n = (int) Math.min(len, lim.binary());
            byte[] head = n == 0 ? new byte[0] : b.getBytes(1, n);
            return binary(head, len, lim);
        }
        if (o instanceof Clob c) {
            long len = c.length();
            return c.getSubString(1, (int) Math.min(len, lim.text()));
        }
        if (o instanceof UUID u) return u.toString();
        if (o instanceof Array a && depth < 4) {
            Object arr = a.getArray();
            List<Object> out = new ArrayList<>();
            if (arr instanceof Object[] oa) for (Object e : oa) out.add(enc(e, depth + 1, lim));
            else out.add(String.valueOf(arr));
            return out;
        }
        if (o instanceof Object[] oa && depth < 4) {
            List<Object> out = new ArrayList<>();
            for (Object e : oa) out.add(enc(e, depth + 1, lim));
            return out;
        }
        return String.valueOf(o);
    }

    private static Map<String, Object> binary(byte[] head, long totalLength, Limits lim) {
        int n = Math.min(head.length, lim.binary());
        byte[] cut = n == head.length ? head : java.util.Arrays.copyOf(head, n);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("$binary", Base64.getEncoder().encodeToString(cut));
        m.put("length", totalLength);
        return m;
    }

    /** Rough encoded size, used to bound one page below the 8 MiB line limit. */
    public static int approxSize(Object v) {
        if (v == null) return 4;
        if (v instanceof String s) return s.length() + 2;
        if (v instanceof Map<?, ?> m) return 400 + (m.get("$binary") instanceof String b ? b.length() : m.size());
        if (v instanceof List<?> l) { int t = 2; for (Object o : l) t += approxSize(o) + 1; return t; }
        return 24;
    }
}
