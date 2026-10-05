package config

import (
	"os"
	"path/filepath"
	"strings"
)

// ExeDir is the directory of the running executable (symlinks resolved). The server is deployed in a user folder on
// Windows and may be started by a service/scheduler whose working directory is C:\Windows\System32, so default data and log
// paths are anchored to the executable, never to the CWD. `go run` builds into a temp dir: there the CWD is used instead.
func ExeDir() string {
	exe, err := os.Executable()
	if err == nil {
		if r, e := filepath.EvalSymlinks(exe); e == nil {
			exe = r
		}
		dir := filepath.Dir(exe)
		tmp := filepath.Clean(os.TempDir())
		if !(strings.HasPrefix(dir, tmp+string(filepath.Separator)) && strings.Contains(dir, "go-build")) &&
			!strings.Contains(filepath.ToSlash(dir), "/go-build") {
			return dir
		}
	}
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}

// resolvePath returns def (relative to base) when v is empty, v itself when absolute, else v joined to base.
func resolvePath(base, v string, def ...string) string {
	if v == "" {
		return filepath.Join(append([]string{base}, def...)...)
	}
	if filepath.IsAbs(v) || strings.HasPrefix(v, `\\`) {
		return filepath.Clean(v)
	}
	return filepath.Join(base, filepath.FromSlash(strings.ReplaceAll(v, `\`, "/")))
}
