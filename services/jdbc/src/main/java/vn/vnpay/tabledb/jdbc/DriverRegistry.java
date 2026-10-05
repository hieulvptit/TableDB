package vn.vnpay.tabledb.jdbc;

import java.io.IOException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.sql.Driver;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Loads JDBC drivers ONLY from a directory (normally {@code drivers/} next to the jar) described by
 * {@code manifest.json}: {"drivers":[{"type","file","sha256","version","class"}]} (a bare array is accepted too).
 * A driver whose file is missing or whose SHA-256 does not match is never loaded (E_DRIVER_UNAVAILABLE).
 */
public final class DriverRegistry {
    public record Info(String type, String version, String sha256, boolean loaded, String error) {
        public Map<String, Object> toJson() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("type", type);
            m.put("version", version);
            m.put("sha256", sha256);
            m.put("loaded", loaded);
            if (error != null) m.put("error", error);
            return m;
        }
    }

    /** A custom (user-imported) driver as described by the custom-drivers manifest. */
    public record CustomInfo(String id, String name, String version, String className, String urlTemplate, Integer defaultPort,
                             List<Map<String, String>> files, DriverShim shim, String error) {
        public boolean loaded() { return shim != null; }

        public Map<String, Object> toJson() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("type", "custom");
            m.put("id", id);
            m.put("name", name);
            if (version != null) m.put("version", version);
            m.put("className", className);
            m.put("urlTemplate", urlTemplate);
            if (defaultPort != null) m.put("defaultPort", (long) defaultPort);
            m.put("files", new ArrayList<Object>(files));
            m.put("loaded", loaded());
            if (error != null) m.put("error", error);
            return m;
        }
    }

    static final Pattern TEMPLATE_PLACEHOLDER = Pattern.compile("\\{([^{}]*)\\}");
    static final Set<String> TEMPLATE_KEYS = Set.of("host", "port", "database");
    private static final Set<String> BUILTIN_TYPES = Set.of("postgresql", "oracle", "trino");

    private final Map<String, DriverShim> shims = new LinkedHashMap<>();
    private final Map<String, Info> infos = new LinkedHashMap<>();
    private final Set<String> allowedTypes;
    private final Path customDir;
    private volatile Map<String, CustomInfo> custom = Map.of();

    /** @param allowedTypes the only driver types accepted from the manifest (production: postgresql, oracle, trino). */
    public DriverRegistry(Path driversDir, Set<String> allowedTypes) {
        this(driversDir, allowedTypes, null);
    }

    /** @param customDir app-data directory of user-imported drivers (manifest.json of type "custom" entries); null = none. Never from a request. */
    public DriverRegistry(Path driversDir, Set<String> allowedTypes, Path customDir) {
        this.allowedTypes = allowedTypes;
        this.customDir = customDir;
        load(driversDir);
        for (String t : allowedTypes) {
            infos.putIfAbsent(t, new Info(t, null, null, false, "not in manifest"));
        }
        reloadCustom();
    }

    private void load(Path dir) {
        Path mf = dir.resolve("manifest.json");
        if (!Files.isRegularFile(mf)) {
            Log.warn("driver manifest not found; no drivers will be available");
            return;
        }
        List<Object> entries;
        try {
            Object root = Json.parse(Files.readString(mf));
            if (root instanceof Map<?, ?> m && m.get("drivers") instanceof List<?> l) entries = new ArrayList<>(l);
            else if (root instanceof List<?> l) entries = new ArrayList<>(l);
            else throw new IllegalArgumentException("manifest must be an array or {drivers:[...]}");
        } catch (IOException | RuntimeException e) {
            Log.warn("driver manifest unreadable: " + e.getClass().getSimpleName());
            return;
        }
        for (Object o : entries) {
            if (!(o instanceof Map<?, ?> e)) continue;
            String type = str(e.get("type"));
            String version = str(e.get("version"));
            String declared = str(e.get("sha256"));
            if (type == null) continue;
            type = type.toLowerCase(Locale.ROOT);
            if (type.equals("custom") || !allowedTypes.contains(type)) {
                Log.warn("manifest entry with disallowed driver type ignored");
                continue;
            }
            if (shims.containsKey(type) || infos.containsKey(type)) {
                Log.warn("duplicate manifest entry for " + type + " ignored");
                continue;
            }
            try {
                DriverShim shim = loadOne(dir, str(e.get("file")), declared, str(e.get("class")));
                shims.put(type, shim);
                infos.put(type, new Info(type, version, declared, true, null));
                Log.info("driver loaded: " + type + " " + version);
            } catch (Exception ex) {
                infos.put(type, new Info(type, version, declared, false, ex.getMessage()));
                Log.warn("driver " + type + " NOT loaded: " + ex.getMessage());
            }
        }
    }

    private static String str(Object o) { return o instanceof String s ? s : null; }

    private static void checkFileName(String file) {
        if (file == null || file.contains("/") || file.contains("\\") || file.contains("\0") || file.startsWith(".") || !file.endsWith(".jar"))
            throw new IllegalArgumentException("invalid driver file name");
    }

    /** Verifies name, symlink-ness and sha256 of {@code dir/file}, then writes the verified bytes to {@code tmpDir}. */
    private static Path verifiedCopy(Path dir, String file, String sha256, Path tmpDir) throws IOException {
        checkFileName(file);
        if (sha256 == null || !sha256.matches("(?i)[0-9a-f]{64}")) throw new IllegalArgumentException("invalid sha256 in manifest");
        Path jar = dir.resolve(file).normalize();
        if (!jar.getParent().equals(dir.normalize()) || Files.isSymbolicLink(jar) || !Files.isRegularFile(jar))
            throw new IllegalArgumentException("driver file missing");
        byte[] bytes = Files.readAllBytes(jar);
        String actual = Redactor.sha256Hex(bytes);
        if (!MessageDigest.isEqual(actual.getBytes(), sha256.toLowerCase(Locale.ROOT).getBytes()))
            throw new SecurityException("checksum mismatch");
        Path copy = tmpDir.resolve(file);
        Files.write(copy, bytes);
        copy.toFile().deleteOnExit();
        return copy;
    }

    private static Path privateTmpDir() throws IOException {
        Path tmpDir;
        try {
            tmpDir = Files.createTempDirectory("tabledb-drv-", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        } catch (UnsupportedOperationException notPosix) { // Windows: rely on the per-user temp dir ACL
            tmpDir = Files.createTempDirectory("tabledb-drv-");
        }
        tmpDir.toFile().deleteOnExit();
        return tmpDir;
    }

    private static DriverShim instantiate(String name, List<Path> jars, String className) throws Exception {
        URL[] urls = new URL[jars.size()];
        for (int i = 0; i < urls.length; i++) urls[i] = jars.get(i).toUri().toURL();
        // Load from private copies of the exact bytes we verified (closes the verify/load race on the drivers dir).
        URLClassLoader cl = new URLClassLoader("tabledb-driver-" + name, urls, ClassLoader.getPlatformClassLoader());
        Class<?> c = Class.forName(className, true, cl);
        if (!Driver.class.isAssignableFrom(c)) throw new IllegalArgumentException("class is not a java.sql.Driver");
        return new DriverShim((Driver) c.getDeclaredConstructor().newInstance());
    }

    private DriverShim loadOne(Path dir, String file, String sha256, String className) throws Exception {
        if (file == null || className == null || sha256 == null) throw new IllegalArgumentException("incomplete manifest entry");
        Path copy = verifiedCopy(dir, file, sha256, privateTmpDir());
        return instantiate(file, List.of(copy), className);
    }

    // ------------------------------------------------------------------ custom drivers

    /** Validates a custom URL template: jdbc: prefix, no whitespace/control chars, only {host} {port} {database}. */
    public static void validateUrlTemplate(String t) {
        if (t == null || t.length() > 512 || !t.startsWith("jdbc:") || t.length() < 6) throw new IllegalArgumentException("invalid urlTemplate");
        for (int i = 0; i < t.length(); i++) {
            char ch = t.charAt(i);
            if (ch <= 0x20 || ch == 0x7f) throw new IllegalArgumentException("urlTemplate contains whitespace or control characters");
        }
        Matcher m = TEMPLATE_PLACEHOLDER.matcher(t);
        StringBuilder rest = new StringBuilder();
        int last = 0;
        while (m.find()) {
            if (!TEMPLATE_KEYS.contains(m.group(1))) throw new IllegalArgumentException("urlTemplate placeholder not allowed");
            rest.append(t, last, m.start());
            last = m.end();
        }
        rest.append(t.substring(last));
        if (rest.indexOf("{") >= 0 || rest.indexOf("}") >= 0) throw new IllegalArgumentException("urlTemplate has unbalanced braces");
    }

    /** Re-reads the custom manifest. Existing sessions keep the DriverShim they already hold. */
    public synchronized void reloadCustom() {
        Map<String, CustomInfo> next = new LinkedHashMap<>();
        if (customDir != null) {
            Path mf = customDir.resolve("manifest.json");
            if (Files.isRegularFile(mf)) {
                try {
                    Object root = Json.parse(Files.readString(mf));
                    List<?> entries;
                    if (root instanceof Map<?, ?> m && m.get("drivers") instanceof List<?> l) entries = l;
                    else if (root instanceof List<?> l) entries = l;
                    else throw new IllegalArgumentException("manifest must be an array or {drivers:[...]}");
                    for (Object o : entries) if (o instanceof Map<?, ?> e) loadCustomEntry(e, next);
                } catch (IOException | RuntimeException ex) {
                    Log.warn("custom driver manifest unreadable: " + ex.getClass().getSimpleName());
                }
            }
        }
        custom = java.util.Collections.unmodifiableMap(next);
    }

    private void loadCustomEntry(Map<?, ?> e, Map<String, CustomInfo> out) {
        Object type = e.get("type");
        if (!"custom".equals(type)) {
            Log.warn("custom manifest entry with type other than 'custom' ignored");
            return;
        }
        String id = str(e.get("id"));
        if (id == null || !Profile.IDENT.matcher(id).matches() || BUILTIN_TYPES.contains(id.toLowerCase(Locale.ROOT))) {
            Log.warn("custom manifest entry with invalid id ignored");
            return;
        }
        if (out.containsKey(id)) {
            Log.warn("duplicate custom driver id " + id + " ignored");
            return;
        }
        String name = str(e.get("name")) == null ? id : str(e.get("name"));
        String version = str(e.get("version"));
        String cls = str(e.get("class"));
        String tpl = str(e.get("urlTemplate"));
        Integer dp = null;
        List<Map<String, String>> files = new ArrayList<>();
        try {
            if (e.get("defaultPort") instanceof Long l) {
                if (l < 1 || l > 65535) throw new IllegalArgumentException("invalid defaultPort");
                dp = (int) (long) l;
            } else if (e.get("defaultPort") != null) throw new IllegalArgumentException("invalid defaultPort");
            if (cls == null || cls.isEmpty()) throw new IllegalArgumentException("incomplete manifest entry");
            validateUrlTemplate(tpl);
            if (!(e.get("files") instanceof List<?> fl) || fl.isEmpty() || fl.size() > 64) throw new IllegalArgumentException("files must be a non-empty array");
            for (Object fo : fl) {
                if (!(fo instanceof Map<?, ?> fm)) throw new IllegalArgumentException("invalid files entry");
                String f = str(fm.get("file")), sha = str(fm.get("sha256"));
                if (f == null || sha == null) throw new IllegalArgumentException("incomplete files entry");
                files.add(Map.of("file", f, "sha256", sha));
            }
        } catch (IllegalArgumentException ex) {
            out.put(id, new CustomInfo(id, name, version, cls, tpl, dp, files, null, ex.getMessage()));
            Log.warn("custom driver " + id + " NOT loaded: " + ex.getMessage());
            return;
        }
        try {
            Path tmp = privateTmpDir();
            List<Path> jars = new ArrayList<>();
            java.util.HashSet<String> seen = new java.util.HashSet<>();
            for (Map<String, String> f : files) {
                if (!seen.add(f.get("file"))) throw new IllegalArgumentException("duplicate file in entry");
                jars.add(verifiedCopy(customDir, f.get("file"), f.get("sha256"), tmp));
            }
            DriverShim shim = instantiate(id, jars, cls);
            out.put(id, new CustomInfo(id, name, version, cls, tpl, dp, files, shim, null));
            Log.info("custom driver loaded: " + id);
        } catch (Exception ex) {
            String msg = ex instanceof ClassNotFoundException ? "driver class not found" : ex.getMessage();
            out.put(id, new CustomInfo(id, name, version, cls, tpl, dp, files, null, msg));
            Log.warn("custom driver " + id + " NOT loaded: " + msg);
        }
    }

    public CustomInfo customInfo(String id) { return id == null ? null : custom.get(id); }

    public DriverShim requireCustom(String id) {
        CustomInfo i = customInfo(id);
        if (i == null || !i.loaded())
            throw new RpcError("E_DRIVER_UNAVAILABLE", "custom JDBC driver '" + id + "' is not available"
                    + (i != null && i.error() != null ? " (" + i.error() + ")" : ""));
        return i.shim();
    }

    public Set<String> allowedTypes() { return allowedTypes; }
    public boolean isLoaded(String type) { return shims.containsKey(type); }

    public DriverShim require(String type) {
        DriverShim s = shims.get(type);
        if (s == null) {
            Info i = infos.get(type);
            throw new RpcError("E_DRIVER_UNAVAILABLE", "JDBC driver '" + type + "' is not available"
                    + (i != null && i.error() != null ? " (" + i.error() + ")" : ""));
        }
        return s;
    }

    public List<Map<String, Object>> describe() {
        List<Map<String, Object>> l = new ArrayList<>();
        for (Info i : infos.values()) l.add(i.toJson());
        for (CustomInfo c : custom.values()) l.add(c.toJson());
        return l;
    }
}
