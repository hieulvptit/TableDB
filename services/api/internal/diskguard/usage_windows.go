//go:build windows

package diskguard

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// Stat reports the volume holding path with GetDiskFreeSpaceEx (works for drive letters, mounted folders and UNC shares;
// the call accepts any directory on the volume). Avail honours per-user quotas.
func Stat(path string) (Usage, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return Usage{}, err
	}
	var avail, total, free uint64
	if err := windows.GetDiskFreeSpaceEx(p, &avail, &total, &free); err != nil {
		return Usage{}, fmt.Errorf("GetDiskFreeSpaceEx %s: %w", path, err)
	}
	return Usage{Total: total, Used: total - free, Avail: avail}, nil
}
