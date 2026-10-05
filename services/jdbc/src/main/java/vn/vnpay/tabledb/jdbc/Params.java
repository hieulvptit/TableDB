package vn.vnpay.tabledb.jdbc;

import java.util.List;
import java.util.Map;
import java.util.Set;

/** Typed, strict accessors over a JSON object; every violation is E_BAD_REQUEST. */
public final class Params {
    private final Map<String, Object> m;
    private final String ctx;

    public Params(Map<String, Object> m, String ctx) {
        this.m = m == null ? Map.of() : m;
        this.ctx = ctx;
    }

    public Map<String, Object> raw() { return m; }

    public void only(Set<String> allowed) {
        for (String k : m.keySet()) {
            if (!allowed.contains(k)) throw RpcError.badRequest("unknown " + ctx + " key '" + printable(k) + "'");
        }
    }

    private static String printable(String k) {
        String s = k.length() > 40 ? k.substring(0, 40) : k;
        return s.replaceAll("[^A-Za-z0-9_.-]", "?");
    }

    public boolean has(String k) { return m.get(k) != null; }

    public String str(String k) {
        Object v = m.get(k);
        if (v == null) return null;
        if (!(v instanceof String s)) throw RpcError.badRequest(ctx + "." + k + " must be a string");
        return s;
    }

    public String reqStr(String k) {
        String s = str(k);
        if (s == null || s.isEmpty()) throw RpcError.badRequest(ctx + "." + k + " is required");
        return s;
    }

    public Boolean bool(String k) {
        Object v = m.get(k);
        if (v == null) return null;
        if (!(v instanceof Boolean b)) throw RpcError.badRequest(ctx + "." + k + " must be a boolean");
        return b;
    }

    public boolean bool(String k, boolean def) {
        Boolean b = bool(k);
        return b == null ? def : b;
    }

    public Long lng(String k) {
        Object v = m.get(k);
        if (v == null) return null;
        if (v instanceof Long l) return l;
        throw RpcError.badRequest(ctx + "." + k + " must be an integer");
    }

    public int intIn(String k, int def, int min, int max) {
        Long l = lng(k);
        if (l == null) return def;
        if (l < min || l > max) throw RpcError.badRequest(ctx + "." + k + " out of range [" + min + "," + max + "]");
        return (int) (long) l;
    }

    /** Integer capped (not rejected) at {@code cap}; must be >= min. */
    public int intCapped(String k, int def, int min, int cap) {
        Long l = lng(k);
        if (l == null) return def;
        if (l < min) throw RpcError.badRequest(ctx + "." + k + " must be >= " + min);
        return (int) Math.min(l, cap);
    }

    public Params obj(String k) {
        Object v = m.get(k);
        if (v == null) return null;
        if (!(v instanceof Map<?, ?>)) throw RpcError.badRequest(ctx + "." + k + " must be an object");
        @SuppressWarnings("unchecked") Map<String, Object> mm = (Map<String, Object>) v;
        return new Params(mm, ctx + "." + k);
    }

    /** Array of objects (each wrapped as Params), or null when absent. */
    public List<Params> objList(String k) {
        Object v = m.get(k);
        if (v == null) return null;
        if (!(v instanceof List<?> l)) throw RpcError.badRequest(ctx + "." + k + " must be an array");
        java.util.ArrayList<Params> out = new java.util.ArrayList<>();
        int i = 0;
        for (Object o : l) {
            if (!(o instanceof Map<?, ?>)) throw RpcError.badRequest(ctx + "." + k + " must contain objects");
            @SuppressWarnings("unchecked") Map<String, Object> mm = (Map<String, Object>) o;
            out.add(new Params(mm, ctx + "." + k + "[" + i++ + "]"));
        }
        return out;
    }

    public List<String> strList(String k) {
        Object v = m.get(k);
        if (v == null) return null;
        if (!(v instanceof List<?> l)) throw RpcError.badRequest(ctx + "." + k + " must be an array");
        java.util.ArrayList<String> out = new java.util.ArrayList<>();
        for (Object o : l) {
            if (!(o instanceof String s)) throw RpcError.badRequest(ctx + "." + k + " must contain strings");
            out.add(s);
        }
        return out;
    }
}
