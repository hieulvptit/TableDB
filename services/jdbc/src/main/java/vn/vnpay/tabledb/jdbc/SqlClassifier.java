package vn.vnpay.tabledb.jdbc;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Tokenizing SQL classifier. Comments, string literals, dollar-quoted strings and quoted identifiers are
 * removed from consideration before any keyword decision is taken. Shared test vectors:
 * packages/shared/testdata/sql-classify.json.
 */
public final class SqlClassifier {
    public enum Kind { READ, WRITE, DDL, OTHER }

    public record Result(Kind kind, boolean multi, boolean malformed, int statements, String executableSql) {
        public String kindName() { return kind.name().toLowerCase(java.util.Locale.ROOT); }
    }

    private SqlClassifier() {}

    private static final Set<String> WRITE = Set.of("INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "REPLACE");
    private static final Set<String> DDL = Set.of("CREATE", "DROP", "ALTER", "TRUNCATE", "GRANT", "REVOKE", "COMMENT", "RENAME");
    private static final Set<String> READ_HEAD = Set.of("SELECT", "SHOW", "DESCRIBE", "DESC", "VALUES", "TABLE");
    private static final Set<String> BLOCK_HEAD = Set.of("BEGIN", "DECLARE");

    /** Token: kind W=word (upper-cased), S=string/quoted ident placeholder, P=punctuation, ';'. */
    private record Tok(char t, String v, int pos) {}

    private static final class Lexed {
        final List<Tok> toks = new ArrayList<>();
        boolean malformed;
    }

    public static Result classify(String sql) {
        Lexed lx = lex(sql);
        // split into statements at top-level ';'
        List<List<Tok>> stmts = new ArrayList<>();
        List<Tok> cur = new ArrayList<>();
        int firstSemi = -1;
        boolean plBlock = false;
        for (Tok t : lx.toks) {
            if (t.t == ';') {
                // stored PL/SQL units (CREATE PROCEDURE ... IS BEGIN ...; END;) carry inner semicolons: one statement
                if (!cur.isEmpty() && stmts.isEmpty() && isPlUnit(cur)) { plBlock = true; cur.add(t); continue; }
                if (firstSemi < 0) firstSemi = t.pos;
                if (!cur.isEmpty()) stmts.add(cur);
                cur = new ArrayList<>();
            } else cur.add(t);
        }
        if (!cur.isEmpty()) stmts.add(cur);

        if (stmts.isEmpty()) return new Result(Kind.OTHER, false, lx.malformed, 0, sql.strip());
        if (plBlock && stmts.size() == 1) return new Result(Kind.DDL, false, lx.malformed, 1, sql.strip());

        String head = firstWord(stmts.get(0));
        // Anonymous PL blocks contain inner semicolons: treat the whole text as one statement (never read-only).
        if (head != null && BLOCK_HEAD.contains(head)) {
            return new Result(Kind.OTHER, false, lx.malformed, 1, sql.strip());
        }

        boolean multi = stmts.size() > 1;
        Kind kind = classifyStatement(stmts.get(0));
        String exec = sql.strip();
        if (!multi && firstSemi >= 0) exec = sql.substring(0, firstSemi).strip();
        return new Result(kind, multi, lx.malformed, stmts.size(), exec);
    }

    private static final Set<String> CREATE_MODIFIERS = Set.of("OR", "REPLACE", "EDITIONABLE", "NONEDITIONABLE", "EDITIONING", "NO", "FORCE");

    /**
     * CREATE [OR REPLACE] [EDITIONABLE] PACKAGE [BODY] / TYPE BODY always, and PROCEDURE / FUNCTION / TRIGGER when the body
     * is PL (IS/AS followed by a word, or BEGIN/DECLARE) rather than a dollar-quoted string (PostgreSQL). Mirrors
     * packages/shared/src/sql-classify.ts.
     */
    static boolean isPlUnit(List<Tok> ts) {
        if (ts.isEmpty() || ts.get(0).t != 'W' || !ts.get(0).v.equals("CREATE")) return false;
        int i = 1;
        while (i < ts.size() && ts.get(i).t == 'W' && CREATE_MODIFIERS.contains(ts.get(i).v)) i++;
        if (i >= ts.size() || ts.get(i).t != 'W') return false;
        String obj = ts.get(i).v;
        if (obj.equals("PACKAGE")) return true;
        if (obj.equals("TYPE")) return i + 1 < ts.size() && ts.get(i + 1).t == 'W' && ts.get(i + 1).v.equals("BODY");
        if (!obj.equals("PROCEDURE") && !obj.equals("FUNCTION") && !obj.equals("TRIGGER")) return false;
        for (int k = i + 1; k < ts.size(); k++) {
            Tok t = ts.get(k);
            if (t.t != 'W') continue;
            if (t.v.equals("BEGIN") || t.v.equals("DECLARE")) return true;
            if ((t.v.equals("IS") || t.v.equals("AS")) && k + 1 < ts.size() && ts.get(k + 1).t == 'W') return true;
        }
        return false;
    }

    /** First keyword of the first statement (upper-case), or null. */
    public static String firstKeyword(String sql) {
        for (Tok t : lex(sql).toks) {
            if (t.t == 'W') return t.v;
            if (t.t == 'P' && t.v.equals("(")) continue;
            return null;
        }
        return null;
    }

    private static String firstWord(List<Tok> ts) {
        for (Tok t : ts) {
            if (t.t == 'W') return t.v;
            if (t.t == 'P' && t.v.equals("(")) continue;
            return null;
        }
        return null;
    }

    private static Kind classifyStatement(List<Tok> ts) {
        int i = 0;
        while (i < ts.size() && ts.get(i).t == 'P' && ts.get(i).v.equals("(")) i++;
        if (i >= ts.size() || ts.get(i).t != 'W') return Kind.OTHER;
        String w = ts.get(i).v;

        if (WRITE.contains(w)) return Kind.WRITE;
        if (DDL.contains(w)) return Kind.DDL;
        if (w.equals("EXPLAIN")) return classifyExplain(ts, i + 1);
        if (w.equals("WITH")) return classifyWith(ts, i);
        if (w.equals("SELECT") || w.equals("TABLE") || w.equals("VALUES")) return classifySelect(ts, i);
        if (READ_HEAD.contains(w)) return Kind.READ;
        return Kind.OTHER;
    }

    /** SELECT ... INTO (creates table / assigns) and locking reads are not read-only. */
    private static Kind classifySelect(List<Tok> ts, int from) {
        for (int i = from; i < ts.size(); i++) {
            Tok t = ts.get(i);
            if (t.t != 'W') continue;
            if (t.v.equals("INTO")) return Kind.WRITE;
            if (t.v.equals("FOR") && i + 1 < ts.size() && ts.get(i + 1).t == 'W') {
                String n = ts.get(i + 1).v;
                if (n.equals("UPDATE") || n.equals("SHARE") || n.equals("NO") || n.equals("KEY")) return Kind.WRITE;
            }
        }
        return Kind.READ;
    }

    /** WITH: read only if no DML/DDL keyword appears anywhere at any depth. */
    private static Kind classifyWith(List<Tok> ts, int from) {
        Kind k = Kind.READ;
        for (int i = from; i < ts.size(); i++) {
            Tok t = ts.get(i);
            if (t.t != 'W') continue;
            if (DDL.contains(t.v)) return Kind.DDL;
            if (WRITE.contains(t.v)) k = Kind.WRITE;
        }
        if (k == Kind.READ) return classifySelect(ts, from);
        return k;
    }

    private static Kind classifyExplain(List<Tok> ts, int i) {
        // EXPLAIN [ANALYZE|VERBOSE] stmt  |  EXPLAIN (opt, ...) stmt  |  EXPLAIN PLAN FOR stmt (Oracle: writes PLAN_TABLE)
        boolean analyze = false;
        if (i < ts.size() && ts.get(i).t == 'W' && ts.get(i).v.equals("PLAN")) return Kind.OTHER;
        if (i < ts.size() && ts.get(i).t == 'P' && ts.get(i).v.equals("(")) {
            int depth = 0;
            while (i < ts.size()) {
                Tok t = ts.get(i);
                if (t.t == 'P' && t.v.equals("(")) depth++;
                else if (t.t == 'P' && t.v.equals(")")) { depth--; if (depth == 0) { i++; break; } }
                else if (t.t == 'W' && t.v.equals("ANALYZE")) analyze = true;
                else if (t.t == 'W' && t.v.equals("ANALYSE")) analyze = true;
                i++;
            }
        } else {
            while (i < ts.size() && ts.get(i).t == 'W' && (ts.get(i).v.equals("ANALYZE") || ts.get(i).v.equals("ANALYSE") || ts.get(i).v.equals("VERBOSE"))) {
                if (!ts.get(i).v.equals("VERBOSE")) analyze = true;
                i++;
            }
        }
        if (!analyze) return Kind.READ;
        if (i >= ts.size()) return Kind.OTHER;
        Kind inner = classifyStatement(ts.subList(i, ts.size()));
        return inner; // EXPLAIN ANALYZE executes the inner statement
    }

    // ---------------------------------------------------------------- lexer

    private static boolean identStart(char c) { return Character.isLetter(c) || c == '_' ; }
    private static boolean identPart(char c) { return Character.isLetterOrDigit(c) || c == '_' || c == '$' || c == '#'; }

    static Lexed lex(String s) {
        Lexed lx = new Lexed();
        int n = s.length();
        int i = 0;
        while (i < n) {
            char c = s.charAt(i);
            if (Character.isWhitespace(c)) { i++; continue; }
            // line comment
            if (c == '-' && i + 1 < n && s.charAt(i + 1) == '-') {
                while (i < n && s.charAt(i) != '\n' && s.charAt(i) != '\r') i++;
                continue;
            }
            // block comment (nested, as PostgreSQL)
            if (c == '/' && i + 1 < n && s.charAt(i + 1) == '*') {
                int depth = 1;
                i += 2;
                while (i < n && depth > 0) {
                    if (s.startsWith("/*", i)) { depth++; i += 2; }
                    else if (s.startsWith("*/", i)) { depth--; i += 2; }
                    else i++;
                }
                if (depth > 0) lx.malformed = true;
                continue;
            }
            // string literal (with optional E/N/B/X/U& prefix handled as identifier chars before it)
            if (c == '\'') {
                boolean backslash = i > 0 && (s.charAt(i - 1) == 'E' || s.charAt(i - 1) == 'e')
                        && (i < 2 || !identPart(s.charAt(i - 2)));
                i = skipQuoted(s, i, '\'', backslash, lx);
                lx.toks.add(new Tok('S', "'", i));
                continue;
            }
            if (c == '"' || c == '`') {
                i = skipQuoted(s, i, c, false, lx);
                lx.toks.add(new Tok('S', "\"", i));
                continue;
            }
            // dollar quoting: $tag$ ... $tag$ (not positional params like $1)
            if (c == '$') {
                int j = i + 1;
                while (j < n && (Character.isLetterOrDigit(s.charAt(j)) || s.charAt(j) == '_')) j++;
                if (j < n && s.charAt(j) == '$' && (j == i + 1 || !Character.isDigit(s.charAt(i + 1)))) {
                    String tag = s.substring(i, j + 1);
                    int end = s.indexOf(tag, j + 1);
                    if (end < 0) { lx.malformed = true; i = n; }
                    else i = end + tag.length();
                    lx.toks.add(new Tok('S', "$", i));
                    continue;
                }
                i++;
                lx.toks.add(new Tok('P', "$", i));
                continue;
            }
            if (c == ';') { lx.toks.add(new Tok(';', ";", i)); i++; continue; }
            if (identStart(c)) {
                int j = i + 1;
                while (j < n && identPart(s.charAt(j))) j++;
                String w = s.substring(i, j);
                // Oracle alternative quoting q'[...]' / nq'...'
                if ((w.equalsIgnoreCase("q") || w.equalsIgnoreCase("nq")) && j + 1 < n && s.charAt(j) == '\'') {
                    char open = s.charAt(j + 1);
                    char close = switch (open) { case '[' -> ']'; case '(' -> ')'; case '{' -> '}'; case '<' -> '>'; default -> open; };
                    int end = s.indexOf(close + "'", j + 2);
                    if (!Character.isWhitespace(open) && end >= 0) {
                        i = end + 2;
                        lx.toks.add(new Tok('S', "'", i));
                        continue;
                    }
                }
                lx.toks.add(new Tok('W', w.toUpperCase(java.util.Locale.ROOT), i));
                i = j;
                continue;
            }
            if (Character.isDigit(c)) {
                int j = i + 1;
                while (j < n && (Character.isLetterOrDigit(s.charAt(j)) || s.charAt(j) == '.' || s.charAt(j) == '_')) j++;
                lx.toks.add(new Tok('N', s.substring(i, j), i));
                i = j;
                continue;
            }
            lx.toks.add(new Tok('P', String.valueOf(c), i));
            i++;
        }
        return lx;
    }

    private static int skipQuoted(String s, int i, char q, boolean backslash, Lexed lx) {
        int n = s.length();
        i++;
        while (i < n) {
            char c = s.charAt(i);
            if (backslash && c == '\\') { i += 2; continue; }
            if (c == q) {
                if (i + 1 < n && s.charAt(i + 1) == q) { i += 2; continue; }
                return i + 1;
            }
            i++;
        }
        lx.malformed = true;
        return n;
    }
}
