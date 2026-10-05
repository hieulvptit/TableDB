// Package shared ports packages/shared (rbac, ticket state machine, redaction, validation, SQL classifier).
package shared

type TicketStatus string

const (
	StatusUploading       TicketStatus = "UPLOADING"
	StatusScanning        TicketStatus = "SCANNING"
	StatusPendingApproval TicketStatus = "PENDING_APPROVAL"
	StatusApproved        TicketStatus = "APPROVED"
	StatusDownloaded      TicketStatus = "DOWNLOADED"
	StatusRejected        TicketStatus = "REJECTED"
	StatusExpired         TicketStatus = "EXPIRED"
	StatusRevoked         TicketStatus = "REVOKED"
	StatusQuarantined     TicketStatus = "QUARANTINED"
	StatusAborted         TicketStatus = "ABORTED"
)

var TicketStatuses = []TicketStatus{
	StatusUploading, StatusScanning, StatusPendingApproval, StatusApproved, StatusDownloaded,
	StatusRejected, StatusExpired, StatusRevoked, StatusQuarantined, StatusAborted,
}

// Delivery state of the approval-request email.
const (
	NotifyPending = "PENDING"
	NotifySent    = "SENT"
	NotifyError   = "ERROR"
)

var transitions = map[TicketStatus][]TicketStatus{
	StatusUploading:       {StatusScanning, StatusAborted, StatusRevoked, StatusExpired},
	StatusScanning:        {StatusPendingApproval, StatusQuarantined, StatusRevoked, StatusExpired},
	StatusPendingApproval: {StatusApproved, StatusRejected, StatusRevoked, StatusExpired, StatusQuarantined},
	StatusApproved:        {StatusDownloaded, StatusExpired, StatusRevoked, StatusQuarantined},
	StatusDownloaded:      {StatusDownloaded, StatusExpired, StatusRevoked, StatusQuarantined},
	StatusRejected:        {}, StatusExpired: {}, StatusRevoked: {}, StatusQuarantined: {}, StatusAborted: {},
}

func CanTransition(from, to TicketStatus) bool {
	for _, t := range transitions[from] {
		if t == to {
			return true
		}
	}
	return false
}

// StatusLabelVI are the Vietnamese labels used by emails.
var StatusLabelVI = map[TicketStatus]string{
	StatusUploading: "Đang tải lên", StatusScanning: "Chờ kiểm tra", StatusPendingApproval: "Chờ duyệt", StatusApproved: "Đã duyệt",
	StatusDownloaded: "Đã tải", StatusRejected: "Từ chối", StatusExpired: "Hết hạn", StatusRevoked: "Đã thu hồi",
	StatusQuarantined: "Cách ly (mã độc)", StatusAborted: "Đã hủy upload",
}

type TransferDirection string

const (
	JumpToOffice TransferDirection = "JUMP_TO_OFFICE"
	OfficeToJump TransferDirection = "OFFICE_TO_JUMP"
)

type ClientKind string

const (
	ClientWeb     ClientKind = "web"
	ClientDesktop ClientKind = "desktop"
)

// DirectionForUploader: desktop uploads go to the office, web BO uploads go to the jump host. Server-assigned.
func DirectionForUploader(k ClientKind) TransferDirection {
	if k == ClientDesktop {
		return JumpToOffice
	}
	return OfficeToJump
}

// DownloadClientFor is the only client kind allowed to download a ticket of this direction.
func DownloadClientFor(d TransferDirection) ClientKind {
	if d == JumpToOffice {
		return ClientWeb
	}
	return ClientDesktop
}

var DirectionLabelVI = map[TransferDirection]string{JumpToOffice: "Jump → Office", OfficeToJump: "Office → Jump"}
