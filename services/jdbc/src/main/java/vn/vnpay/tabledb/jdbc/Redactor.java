package vn.vnpay.tabledb.jdbc;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.regex.Pattern;

/** Scrubbing helpers so logs and error messages never carry credentials or literals. */
public final class Redactor {
    private Redactor() {}

    private static final Pattern KV = Pattern.compile("(?i)(password|passwd|pwd|token|accessToken|secret|authorization)\\s*[=:]\\s*[^\\s,;&\"']+");
    private static final Pattern BEARER = Pattern.compile("(?i)bearer\\s+[A-Za-z0-9._~+/=-]+");
    private static final Pattern JWT = Pattern.compile("eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]*");
    private static final Pattern STR_LIT = Pattern.compile("'(?:[^']|'')*'");
    private static final Pattern NUM_LIT = Pattern.compile("\\b\\d+(?:\\.\\d+)?\\b");
    private static final Pattern URL_QUERY = Pattern.compile("(?i)(https?://[^\\s?\"<>]+)\\?[^\\s\"<>]+");

    public static String scrub(String s, String... secrets) {
        if (s == null) return null;
        String r = s;
        if (secrets != null) {
            for (String sec : secrets) {
                if (sec != null && sec.length() >= 3) r = r.replace(sec, "***");
            }
        }
        r = BEARER.matcher(r).replaceAll("Bearer ***");
        r = JWT.matcher(r).replaceAll("***");
        r = KV.matcher(r).replaceAll("$1=***");
        r = URL_QUERY.matcher(r).replaceAll("$1?***");
        return r;
    }

    /** Mask literals in SQL for DEBUG logging: strings -> '?', numbers -> ?. Truncated to 200 chars. */
    public static String maskSql(String sql) {
        String r = STR_LIT.matcher(sql).replaceAll("'?'");
        r = NUM_LIT.matcher(r).replaceAll("?");
        r = r.replaceAll("\\s+", " ").trim();
        return r.length() > 200 ? r.substring(0, 200) : r;
    }

    public static String sha256Hex(String s) {
        return sha256Hex(s.getBytes(StandardCharsets.UTF_8));
    }

    public static String sha256Hex(byte[] b) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
