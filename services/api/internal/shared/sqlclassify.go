package shared

import "strings"

type SqlKind string

const (
	SqlRead  SqlKind = "read"
	SqlWrite SqlKind = "write"
	SqlDDL   SqlKind = "ddl"
	SqlOther SqlKind = "other"
)

type SqlClassification struct {
	Kind         SqlKind
	Multi        bool
	FirstKeyword string
}

func isWordStart(c byte) bool { return c == '_' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' }
func isWordPart(c byte) bool {
	return isWordStart(c) || isDigit(c) || c == '$' || c == '#'
}

var createModifiers = map[string]bool{"OR": true, "REPLACE": true, "EDITIONABLE": true, "NONEDITIONABLE": true, "EDITIONING": true, "NO": true, "FORCE": true}

func isWordTok(t string, ok bool) bool { return ok && t != "'" && t != `"ID"` }

func tokAt(ts []string, i int) (string, bool) {
	if i < len(ts) {
		return ts[i], true
	}
	return "", false
}

// IsPlUnit mirrors isPlUnit (TS) / SqlClassifier.isPlUnit (Java).
func IsPlUnit(tokens []string) bool {
	if len(tokens) == 0 || tokens[0] != "CREATE" {
		return false
	}
	i := 1
	for i < len(tokens) && createModifiers[tokens[i]] {
		i++
	}
	obj, _ := tokAt(tokens, i)
	if obj == "PACKAGE" {
		return true
	}
	if obj == "TYPE" {
		t, _ := tokAt(tokens, i+1)
		return t == "BODY"
	}
	if obj != "PROCEDURE" && obj != "FUNCTION" && obj != "TRIGGER" {
		return false
	}
	for k := i + 1; k < len(tokens); k++ {
		t := tokens[k]
		if t == "BEGIN" || t == "DECLARE" {
			return true
		}
		if t == "IS" || t == "AS" {
			nt, has := tokAt(tokens, k+1)
			if isWordTok(nt, has) {
				return true
			}
		}
	}
	return false
}

// dollarTag matches ^\$([A-Za-z_][A-Za-z0-9_]*)?\$ at s[i:], returning the full tag.
func dollarTag(s string, i int) (string, bool) {
	j := i + 1
	if j < len(s) && s[j] == '$' {
		return "$$", true
	}
	if j < len(s) && (s[j] == '_' || s[j] >= 'A' && s[j] <= 'Z' || s[j] >= 'a' && s[j] <= 'z') {
		j++
		for j < len(s) && (s[j] == '_' || isDigit(s[j]) || s[j] >= 'A' && s[j] <= 'Z' || s[j] >= 'a' && s[j] <= 'z') {
			j++
		}
		if j < len(s) && s[j] == '$' {
			return s[i : j+1], true
		}
	}
	return "", false
}

func scanSQL(sql string) [][]string {
	var statements [][]string
	var cur []string
	n := len(sql)
	i := 0
	push := func() {
		if len(cur) > 0 {
			statements = append(statements, cur)
		}
		cur = nil
	}
	for i < n {
		c := sql[i]
		var d byte
		if i+1 < n {
			d = sql[i+1]
		}
		switch {
		case c == '-' && d == '-':
			for i < n && sql[i] != '\n' {
				i++
			}
		case c == '/' && d == '*':
			i += 2
			for i < n && !(sql[i] == '*' && i+1 < n && sql[i+1] == '/') {
				i++
			}
			i += 2
		case c == '\'':
			i++
			for i < n {
				if sql[i] == '\'' && i+1 < n && sql[i+1] == '\'' {
					i += 2
				} else if sql[i] == '\'' {
					i++
					break
				} else {
					i++
				}
			}
			cur = append(cur, "'")
		case c == '"' || c == '`':
			i++
			for i < n {
				if sql[i] == c && i+1 < n && sql[i+1] == c {
					i += 2
				} else if sql[i] == c {
					i++
					break
				} else {
					i++
				}
			}
			cur = append(cur, `"ID"`)
		case c == '$':
			if tag, ok := dollarTag(sql, i); ok {
				end := strings.Index(sql[i+len(tag):], tag)
				if end < 0 {
					i = n
				} else {
					i = i + len(tag) + end + len(tag)
				}
				cur = append(cur, "'")
			} else {
				i++
			}
		case c == ';':
			if len(cur) > 0 && (cur[0] == "BEGIN" || cur[0] == "DECLARE") {
				i++
				continue
			}
			if len(statements) == 0 && IsPlUnit(cur) {
				i++
				continue
			}
			push()
			i++
		case isWordStart(c):
			j := i + 1
			for j < n && isWordPart(sql[j]) {
				j++
			}
			cur = append(cur, strings.ToUpper(sql[i:j]))
			i = j
		default:
			i++
		}
	}
	push()
	return statements
}

var (
	dml    = map[string]bool{"INSERT": true, "UPDATE": true, "DELETE": true, "MERGE": true}
	ddl    = map[string]bool{"TRUNCATE": true, "CREATE": true, "DROP": true, "ALTER": true, "GRANT": true, "REVOKE": true, "COMMENT": true, "RENAME": true}
	starts = map[string]bool{"SELECT": true, "WITH": true, "VALUES": true, "INSERT": true, "UPDATE": true, "DELETE": true, "MERGE": true,
		"TRUNCATE": true, "CREATE": true, "DROP": true, "ALTER": true, "GRANT": true, "REVOKE": true, "COMMENT": true, "RENAME": true}
)

func has(ts []string, s string) bool {
	for _, t := range ts {
		if t == s {
			return true
		}
	}
	return false
}

func classifyTokens(tokens []string) SqlKind {
	if len(tokens) == 0 {
		return SqlOther
	}
	first := tokens[0]
	if dml[first] {
		return SqlWrite
	}
	if ddl[first] {
		return SqlDDL
	}
	if first == "SHOW" || first == "DESCRIBE" || first == "DESC" || first == "VALUES" {
		return SqlRead
	}
	if first == "EXPLAIN" {
		idx := -1
		for k := 1; k < len(tokens); k++ {
			if starts[tokens[k]] {
				idx = k
				break
			}
		}
		if idx < 0 {
			return SqlRead
		}
		return classifyTokens(tokens[idx:])
	}
	if first == "SELECT" || first == "WITH" {
		if first == "WITH" {
			for _, t := range tokens {
				if dml[t] {
					return SqlWrite
				}
			}
		}
		if has(tokens, "INTO") {
			return SqlWrite
		}
		for k := 0; k < len(tokens)-1; k++ {
			if tokens[k] == "FOR" && tokens[k+1] == "UPDATE" {
				return SqlWrite
			}
		}
		if first == "WITH" && !has(tokens, "SELECT") && !has(tokens, "VALUES") {
			return SqlOther
		}
		return SqlRead
	}
	return SqlOther
}

// ClassifySQL is conservative: anything unknown is "other"; multiple statements are always "other".
func ClassifySQL(sql string) SqlClassification {
	stmts := scanSQL(sql)
	multi := len(stmts) > 1
	var first []string
	if len(stmts) > 0 {
		first = stmts[0]
	}
	kind := SqlOther
	if !multi {
		kind = classifyTokens(first)
	}
	fk := ""
	if len(first) > 0 {
		fk = first[0]
	}
	return SqlClassification{Kind: kind, Multi: multi, FirstKeyword: fk}
}

// ClassifyKindOfAll gives the most dangerous statement kind of a possibly multi-statement input.
func ClassifyKindOfAll(sql string) SqlKind {
	stmts := scanSQL(sql)
	order := []SqlKind{SqlRead, SqlWrite, SqlDDL, SqlOther}
	worst := 0
	for _, s := range stmts {
		k := classifyTokens(s)
		for i, o := range order {
			if o == k && i > worst {
				worst = i
			}
		}
	}
	if len(stmts) == 0 {
		return SqlOther
	}
	return order[worst]
}
