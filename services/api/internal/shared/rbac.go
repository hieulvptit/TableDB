package shared

import (
	"fmt"
	"time"
)

type Role string
type Permission string

const (
	RoleUser    Role = "user"
	RoleLeader  Role = "leader"
	RoleAdmin   Role = "admin"
	RoleService Role = "service"
)

var rolePerms = map[Role][]Permission{
	RoleUser:    {"db:connect", "db:read", "db:custom", "agent:use", "transfer:create", "transfer:download"},
	RoleLeader:  {"db:connect", "db:read", "db:custom", "agent:use", "transfer:create", "transfer:download", "transfer:approve"},
	RoleAdmin:   {"db:connect", "db:read", "db:custom", "agent:use", "transfer:create", "transfer:download", "admin:manage", "audit:read"},
	RoleService: {},
}

type Principal struct {
	ID     string
	Roles  []Role
	Grants []Permission
	Active bool
}

// PermissionsOf returns the union of grants and role permissions, in a stable order (grants first, then roles in order).
func PermissionsOf(p Principal) []Permission {
	seen := map[Permission]bool{}
	var out []Permission
	add := func(x Permission) {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	for _, g := range p.Grants {
		add(g)
	}
	for _, r := range p.Roles {
		for _, x := range rolePerms[r] {
			add(x)
		}
	}
	return out
}

func HasPermission(p *Principal, perm Permission) bool {
	if p == nil || !p.Active {
		return false
	}
	for _, x := range PermissionsOf(*p) {
		if x == perm {
			return true
		}
	}
	return false
}

type TicketRef struct {
	ID            string
	RequesterID   string
	ApproverID    string
	RecipientIDs  []string
	Status        TicketStatus
	ExpiresAt     *time.Time
	DownloadCount int
	MaxDownloads  int
	Direction     TransferDirection // empty = unknown
}

type Delegation struct {
	FromUserID, ToUserID string
	ValidFrom, ValidTo   time.Time
	Revoked              bool
}

func ActiveDelegateFor(approverID, userID string, ds []Delegation, now time.Time) bool {
	for _, d := range ds {
		if !d.Revoked && d.FromUserID == approverID && d.ToUserID == userID && !d.ValidFrom.After(now) && !now.After(d.ValidTo) {
			return true
		}
	}
	return false
}

type Decision struct {
	Allow  bool
	Reason string
}

var ok = Decision{Allow: true}

func deny(r string) Decision { return Decision{Reason: r} }

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func CanApprove(p Principal, t TicketRef, ds []Delegation, now time.Time) Decision {
	if !HasPermission(&p, "transfer:approve") {
		return deny("missing transfer:approve")
	}
	if p.ID == t.RequesterID {
		return deny("requester cannot decide own ticket")
	}
	if t.Status != StatusPendingApproval {
		return deny(fmt.Sprintf("ticket is %s", t.Status))
	}
	if t.ExpiresAt != nil && !t.ExpiresAt.After(now) {
		return deny("ticket expired")
	}
	if p.ID == t.ApproverID || ActiveDelegateFor(t.ApproverID, p.ID, ds, now) {
		return ok
	}
	return deny("not the designated approver or delegate")
}

// CanDownload: client may be "" when unknown. When both client and direction are known only the destination side may download.
func CanDownload(p Principal, t TicketRef, now time.Time, client ClientKind) Decision {
	if !HasPermission(&p, "transfer:download") {
		return deny("missing transfer:download")
	}
	if client != "" && t.Direction != "" && client != DownloadClientFor(t.Direction) {
		return deny(fmt.Sprintf("this file can only be downloaded from the %s app", DownloadClientFor(t.Direction)))
	}
	if t.Status != StatusApproved && t.Status != StatusDownloaded {
		return deny(fmt.Sprintf("ticket is %s", t.Status))
	}
	if t.ExpiresAt != nil && !t.ExpiresAt.After(now) {
		return deny("ticket expired")
	}
	if t.DownloadCount >= t.MaxDownloads {
		return deny("download limit reached")
	}
	if p.ID != t.RequesterID && !contains(t.RecipientIDs, p.ID) {
		return deny("not a permitted downloader")
	}
	return ok
}

func CanView(p Principal, t TicketRef, ds []Delegation, now time.Time) Decision {
	if HasPermission(&p, "audit:read") {
		return ok
	}
	if p.ID == t.RequesterID || p.ID == t.ApproverID || contains(t.RecipientIDs, p.ID) {
		return ok
	}
	if ActiveDelegateFor(t.ApproverID, p.ID, ds, now) {
		return ok
	}
	return deny("no access to ticket")
}

func CanRevoke(p Principal, t TicketRef) Decision {
	switch t.Status {
	case StatusUploading, StatusScanning, StatusPendingApproval, StatusApproved, StatusDownloaded:
	default:
		return deny(fmt.Sprintf("ticket is %s", t.Status))
	}
	if p.ID == t.RequesterID || HasPermission(&p, "admin:manage") {
		return ok
	}
	return deny("only requester or admin can revoke")
}
