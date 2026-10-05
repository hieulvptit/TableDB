//go:build !windows

package diskguard

import (
	"fmt"
	"syscall"
)

// Stat reports the volume holding path (statfs). Used follows df: blocks - free blocks; Avail is what an unprivileged
// process may still allocate.
func Stat(path string) (Usage, error) {
	var s syscall.Statfs_t
	if err := syscall.Statfs(path, &s); err != nil {
		return Usage{}, fmt.Errorf("statfs %s: %w", path, err)
	}
	bs := uint64(s.Bsize)
	return Usage{Total: uint64(s.Blocks) * bs, Used: (uint64(s.Blocks) - uint64(s.Bfree)) * bs, Avail: uint64(s.Bavail) * bs}, nil
}
