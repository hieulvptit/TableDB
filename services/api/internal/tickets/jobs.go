package tickets

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"vnpay/tabledb-api/internal/apperr"
	"vnpay/tabledb-api/internal/audit"
	"vnpay/tabledb-api/internal/db"
	"vnpay/tabledb-api/internal/inspect"
	"vnpay/tabledb-api/internal/mail"
	"vnpay/tabledb-api/internal/outbox"
	"vnpay/tabledb-api/internal/scan"
	"vnpay/tabledb-api/internal/shared"
)

type user struct{ ID, Email, Name string }

func (s *Service) user(ctx context.Context, id string) (user, error) {
	var u user
	err := s.DB.QueryRow(ctx, "SELECT id::text, email, name FROM users WHERE id=$1", id).Scan(&u.ID, &u.Email, &u.Name)
	return u, err
}

func (s *Service) mailData(ctx context.Context, id string) (*Ticket, mail.TicketMailData, user, user, error) {
	t, err := loadTicket(ctx, s.DB, id, false)
	if err != nil {
		return nil, mail.TicketMailData{}, user{}, user{}, err
	}
	rq, err := s.user(ctx, t.RequesterID)
	if err != nil {
		return nil, mail.TicketMailData{}, user{}, user{}, err
	}
	ap, err := s.user(ctx, t.ApproverID)
	if err != nil {
		return nil, mail.TicketMailData{}, user{}, user{}, err
	}
	d := mail.TicketMailData{Code: t.Code, FileName: t.FileName, Size: t.Size, SHA256: t.SHA256, Purpose: t.Purpose, Direction: t.Direction,
		Requester: mail.Person{Name: rq.Name, Email: rq.Email}, Approver: mail.Person{Name: ap.Name, Email: ap.Email},
		Link: fmt.Sprintf("%s/transfers/%s", s.Cfg.PublicURL, t.ID)}
	if t.ExpiresAt != nil {
		d.ExpiresAt = isoMillis(*t.ExpiresAt)
	}
	if t.DecisionReason != nil {
		d.Reason = *t.DecisionReason
	}
	if t.ScanResult != nil && strings.HasPrefix(*t.ScanResult, "infected:") {
		d.Signature = (*t.ScanResult)[9:]
	}
	return t, d, rq, ap, nil
}

// Handlers returns the outbox job handlers (scan, emails, purge, rescan).
func (s *Service) Handlers() map[string]outbox.Handler {
	return map[string]outbox.Handler{
		"scan": func(ctx context.Context, job outbox.Job) error {
			t, err := loadTicket(ctx, s.DB, job.PayloadString("ticketId"), false)
			if err != nil {
				return err
			}
			if t.Status != shared.StatusScanning {
				return nil
			}
			engine := scan.EngineName(s.Scanner)
			began := time.Now()
			r, privacy, err := assessFile(ctx, t.FileName, s.Scanner, s.PII, func() (io.Reader, error) { return s.plaintext(t) }, func() (io.Reader, error) {
				at, err := s.plaintextAt(t)
				if err != nil {
					return nil, err
				}
				return io.NewSectionReader(at, 0, t.Size), nil
			})
			if err != nil {
				if job.Attempts <= 1 {
					_ = s.sysAuditT(ctx, s.DB, "transfer.scan_error", t, map[string]any{"engine": "llm-pii", "result": "error", "reason": inspect.SanitizeName(err.Error(), 200)})
				}
				return err
			}
			if privacy != nil {
				engine += "+llm-pii"
			}
			scanMs := int(time.Since(began).Milliseconds())
			if r.Status == scan.Unavailable {
				if job.Attempts <= 1 { // first failure only: retries back off for hours and must not flood the trail
					_ = s.sysAuditT(ctx, s.DB, "transfer.scan_error", t, map[string]any{"engine": engine, "result": "error", "reason": inspect.SanitizeName(r.Reason, 200),
						"attempt": job.Attempts, "maxAttempts": job.MaxAttempts, "ms": scanMs})
				}
				return fmt.Errorf("scanner unavailable: %s", r.Reason) // stays SCANNING; retried with backoff
			}
			// the verdict is in; the content manifest is gathered afterwards (clean AND infected) and can never change it
			rec := s.inspectTicket(ctx, t)
			return s.DB.InTx(ctx, func(tx db.Runner) error {
				cur, err := loadTicket(ctx, tx, t.ID, true)
				if err != nil {
					return err
				}
				if cur.Status != shared.StatusScanning {
					return nil
				}
				now := s.Now()
				inspected := func() error {
					if rec == nil {
						return nil
					}
					ins, err := saveManifest(ctx, tx, t.ID, rec)
					if err != nil || !ins {
						return err
					}
					if err := event(ctx, tx, t.ID, "", "inspected", map[string]any{"status": rec.Status, "entries": len(rec.Entries), "manifestHash": rec.Hash}); err != nil {
						return err
					}
					return s.sysAuditT(ctx, tx, "transfer.inspected", cur, inspectAuditDetail(rec))
				}
				if r.Status == scan.Clean || r.Status == scan.Skipped {
					if privacy != nil {
						if err := event(ctx, tx, t.ID, "", "scan.pii", privacy.Metadata()); err != nil {
							return err
						}
						if err := s.sysAuditT(ctx, tx, "transfer.pii_scanned", cur, privacy.Metadata()); err != nil {
							return err
						}
					}
					result, eventKind, auditKind := "clean", "scan.clean", "transfer.scan_clean"
					if r.Status == scan.Skipped {
						result, eventKind, auditKind = "skipped:"+r.Reason, "scan.skipped", "transfer.scan_skipped"
					}
					exp := now.Add(time.Duration(s.Cfg.ApprovalWindowHours * float64(time.Hour)))
					if err := setStatus(ctx, tx, t.ID, shared.StatusScanning, shared.StatusPendingApproval,
						setCol{"scan_result", result}, setCol{"scanned_at", now}, setCol{"expires_at", exp}, setCol{"scan_engine", engine}, setCol{"scan_ms", scanMs}); err != nil {
						return err
					}
					if err := event(ctx, tx, t.ID, "", eventKind, map[string]any{"reason": r.Reason}); err != nil {
						return err
					}
					if err := s.sysAuditT(ctx, tx, auditKind, cur, map[string]any{"engine": engine, "result": string(r.Status), "reason": r.Reason, "ms": scanMs, "scannedAt": isoMillis(now),
						"approvalExpiresAt": isoMillis(exp)}); err != nil {
						return err
					}
					if err := inspected(); err != nil {
						return err
					}
					return s.queueMail(ctx, tx, "approval", t.ID, ":"+cur.ApproverID)
				}
				if err := setStatus(ctx, tx, t.ID, shared.StatusScanning, shared.StatusQuarantined,
					setCol{"scan_result", "infected:" + r.Signature}, setCol{"scanned_at", now}, setCol{"scan_engine", engine}, setCol{"scan_ms", scanMs}); err != nil {
					return err
				}
				if err := event(ctx, tx, t.ID, "", "scan.infected", map[string]any{"signature": r.Signature}); err != nil {
					return err
				}
				if err := s.sysAuditT(ctx, tx, "transfer.quarantine", cur, map[string]any{"signature": inspect.SanitizeName(r.Signature, 200), "engine": engine, "result": "infected", "ms": scanMs,
					"scannedAt": isoMillis(now)}); err != nil {
					return err
				}
				if err := inspected(); err != nil {
					return err
				}
				if err := s.queueMail(ctx, tx, "quarantine", t.ID, ""); err != nil {
					return err
				}
				return outbox.Enqueue(ctx, tx, "purge", map[string]any{"ticketId": t.ID}, outbox.EnqueueOpts{DedupeKey: "purge:" + t.ID})
			})
		},

		"email.approval": func(ctx context.Context, job outbox.Job) error {
			id := job.PayloadString("ticketId")
			t, data, _, ap, err := s.mailData(ctx, id)
			if err != nil {
				return err
			}
			if t.Status != shared.StatusPendingApproval {
				return nil // decided/expired meanwhile: nothing to ask for
			}
			data.ApprovalLink, err = s.NewEmailApprovalLink(ctx, id, ap.ID)
			if err != nil {
				return err
			}
			if err := s.Mailer.Send(ctx, mail.ApprovalRequestMail(data, []string{ap.Email})); err != nil {
				_, _ = s.DB.Exec(ctx, "UPDATE tickets SET notify_state='ERROR', updated_at=now() WHERE id=$1", id)
				msg := err.Error()
				if len(msg) > 200 {
					msg = msg[:200]
				}
				_ = event(ctx, s.DB, id, "", "email.approval_failed", map[string]any{"message": msg})
				return err
			}
			if _, err := s.DB.Exec(ctx, "UPDATE tickets SET notify_state='SENT', updated_at=now() WHERE id=$1", id); err != nil {
				return err
			}
			if err := event(ctx, s.DB, id, "", "email.approval_sent", nil); err != nil {
				return err
			}
			return s.sysAuditT(ctx, s.DB, "notify.approval_sent", t, map[string]any{"to": ap.ID, "notified": s.person(ctx, s.DB, ap.ID)})
		},

		"email.decision": func(ctx context.Context, job outbox.Job) error {
			t, data, rq, _, err := s.mailData(ctx, job.PayloadString("ticketId"))
			if err != nil {
				return err
			}
			approved := t.Status == shared.StatusApproved || t.Status == shared.StatusDownloaded
			if !approved && t.Status != shared.StatusRejected {
				return nil
			}
			to := []string{rq.Email}
			if approved && len(t.RecipientIDs) > 0 {
				rows, err := s.DB.Query(ctx, "SELECT email FROM users WHERE id = ANY($1::uuid[]) AND active", t.RecipientIDs)
				if err != nil {
					return err
				}
				for rows.Next() {
					var e string
					if err := rows.Scan(&e); err != nil {
						rows.Close()
						return err
					}
					to = append(to, e)
				}
				rows.Close()
			}
			if err := s.Mailer.Send(ctx, mail.DecisionMail(data, to, approved)); err != nil {
				return err
			}
			return event(ctx, s.DB, t.ID, "", "email.decision_sent", nil)
		},

		"email.quarantine": func(ctx context.Context, job outbox.Job) error {
			t, data, rq, _, err := s.mailData(ctx, job.PayloadString("ticketId"))
			if err != nil {
				return err
			}
			if t.Status != shared.StatusQuarantined {
				return nil
			}
			if err := s.Mailer.Send(ctx, mail.QuarantineMail(data, []string{rq.Email})); err != nil {
				return err
			}
			return event(ctx, s.DB, t.ID, "", "email.quarantine_sent", nil)
		},

		"purge": func(ctx context.Context, job outbox.Job) error {
			t, err := loadTicket(ctx, s.DB, job.PayloadString("ticketId"), false)
			if err != nil {
				return err
			}
			switch t.Status {
			case shared.StatusRejected, shared.StatusRevoked, shared.StatusQuarantined, shared.StatusExpired, shared.StatusAborted:
				return s.purgeTicket(ctx, t, "terminal-status")
			}
			return nil
		},

		"rescan": func(ctx context.Context, job outbox.Job) error {
			_, err := s.Rescan(ctx, job.PayloadString("ticketId"))
			return err
		},
	}
}

// OnDead marks the ticket's notification as ERROR when an email job is dead-lettered, and audits it.
func (s *Service) OnDead(ctx context.Context, job outbox.Job, jerr error) {
	id := job.PayloadString("ticketId")
	if job.Type == "scan" && id != "" {
		if t, err := loadTicket(ctx, s.DB, id, false); err == nil {
			msg := ""
			if jerr != nil {
				msg = jerr.Error()
			}
			if err := s.sysAuditT(ctx, s.DB, "transfer.scan_failed", t, map[string]any{"attempts": job.Attempts, "reason": inspect.SanitizeName(msg, 200), "result": "error"}); err != nil {
				slog.Error("audit transfer.scan_failed failed", "err", err.Error())
			}
		}
		return
	}
	if !strings.HasPrefix(job.Type, "email.") || id == "" {
		return
	}
	if job.Type == "email.approval" {
		_, _ = s.DB.Exec(ctx, "UPDATE tickets SET notify_state='ERROR' WHERE id=$1", id)
	}
	if err := s.sysAudit(ctx, s.DB, "notify.dead", id, map[string]any{"job": job.Type}); err != nil {
		slog.Error("audit notify.dead failed", "err", err.Error())
	}
}

// SweepExpired expires overdue tickets and purges their content. Run periodically; returns how many were expired.
func (s *Service) SweepExpired(ctx context.Context) (int, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT t.id::text, t.status FROM tickets t WHERE (t.status IN ('PENDING_APPROVAL','APPROVED','DOWNLOADED') AND t.expires_at <= now())
		   OR (t.status='UPLOADING' AND t.created_at < now() - interval '24 hours')`)
	if err != nil {
		return 0, err
	}
	type r struct{ id, status string }
	var list []r
	for rows.Next() {
		var x r
		if err := rows.Scan(&x.id, &x.status); err != nil {
			rows.Close()
			return 0, err
		}
		list = append(list, x)
	}
	rows.Close()
	n := 0
	for _, x := range list {
		from := shared.TicketStatus(x.status)
		to := shared.StatusExpired
		if from == shared.StatusUploading {
			to = shared.StatusAborted
		}
		err := s.DB.InTx(ctx, func(tx db.Runner) error {
			if err := setStatus(ctx, tx, x.id, from, to); err != nil {
				return err
			}
			if err := event(ctx, tx, x.id, "", "expired", nil); err != nil {
				return err
			}
			ex := map[string]any{"from": x.status, "reason": "ttl", "downloadCount": 0}
			if from == shared.StatusUploading {
				ex["reason"] = "upload-abandoned"
			}
			if tk, lerr := loadTicket(ctx, tx, x.id, false); lerr == nil {
				ex["downloadCount"] = tk.DownloadCount
				if tk.ExpiresAt != nil {
					ex["expiresAt"] = isoMillis(*tk.ExpiresAt)
				}
				if err := s.sysAuditT(ctx, tx, "transfer.expire", tk, ex); err != nil {
					return err
				}
			} else if err := s.sysAudit(ctx, tx, "transfer.expire", x.id, ex); err != nil {
				return err
			}
			return outbox.Enqueue(ctx, tx, "purge", map[string]any{"ticketId": x.id}, outbox.EnqueueOpts{DedupeKey: "purge:" + x.id})
		})
		if err == nil {
			n++
		} // concurrent change: next sweep
	}
	return n, nil
}

// Rescan re-scans approved files (e.g. signatures updated). Infected => QUARANTINED and all download rights die with the status.
func (s *Service) Rescan(ctx context.Context, ticketID string) (string, error) {
	t, err := loadTicket(ctx, s.DB, ticketID, false)
	if err != nil {
		return "", err
	}
	switch t.Status {
	case shared.StatusPendingApproval, shared.StatusApproved, shared.StatusDownloaded:
	default:
		return string(t.Status), nil
	}
	rd, err := s.plaintext(t)
	if err != nil {
		return "", err
	}
	r := s.Scanner.Scan(ctx, rd)
	if r.Status != scan.Infected {
		return string(r.Status), nil
	}
	err = s.DB.InTx(ctx, func(tx db.Runner) error {
		cur, err := loadTicket(ctx, tx, ticketID, true)
		if err != nil {
			return err
		}
		if !shared.CanTransition(cur.Status, shared.StatusQuarantined) {
			return nil
		}
		if err := setStatus(ctx, tx, ticketID, cur.Status, shared.StatusQuarantined, setCol{"scan_result", "infected:" + r.Signature}, setCol{"scanned_at", s.Now()}); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "UPDATE download_tokens SET used_at=now() WHERE ticket_id=$1 AND used_at IS NULL", ticketID); err != nil {
			return err
		}
		if err := event(ctx, tx, ticketID, "", "scan.infected_after_upload", map[string]any{"signature": r.Signature}); err != nil {
			return err
		}
		if err := s.sysAuditT(ctx, tx, "transfer.quarantine", cur, map[string]any{"signature": inspect.SanitizeName(r.Signature, 200), "late": true, "engine": scan.EngineName(s.Scanner), "result": "infected", "fromStatus": string(cur.Status)}); err != nil {
			return err
		}
		if err := s.queueMail(ctx, tx, "quarantine", ticketID, ""); err != nil {
			return err
		}
		return outbox.Enqueue(ctx, tx, "purge", map[string]any{"ticketId": ticketID}, outbox.EnqueueOpts{DedupeKey: "purge:" + ticketID})
	})
	if err != nil {
		return "", err
	}
	return "quarantined", nil
}

var _ = apperr.NotFound

// purgeTicket deletes a ticket's ciphertext and records it (storage.purge) when something was actually on disk.
func (s *Service) purgeTicket(ctx context.Context, t *Ticket, reason string) error {
	parts, bytes, err := s.deleteParts(ctx, t)
	if err != nil {
		return err
	}
	if parts > 0 {
		return s.sysAuditT(ctx, s.DB, "storage.purge", t, map[string]any{"reason": reason, "status": string(t.Status), "parts": parts, "bytes": bytes})
	}
	return nil
}

// PurgeTerminalStorage deletes leftover ciphertext of tickets that can never be downloaded again (rejected, revoked,
// quarantined, expired, aborted). Normally the purge job already did it; the disk janitor calls this under pressure.
func (s *Service) PurgeTerminalStorage(ctx context.Context, reason string) (int, int64, error) {
	rows, err := s.DB.Query(ctx, `SELECT DISTINCT t.id::text FROM tickets t JOIN upload_parts p ON p.ticket_id=t.id
		WHERE t.status IN ('REJECTED','REVOKED','QUARANTINED','EXPIRED','ABORTED')`)
	if err != nil {
		return 0, 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	n := 0
	var total int64
	for _, id := range ids {
		t, err := loadTicket(ctx, s.DB, id, false)
		if err != nil {
			continue
		}
		parts, bytes, err := s.deleteParts(ctx, t)
		if err != nil {
			return n, total, err
		}
		if parts > 0 {
			n++
			total += bytes
			if err := s.sysAuditT(ctx, s.DB, "storage.purge", t, map[string]any{"reason": reason, "status": string(t.Status), "parts": parts, "bytes": bytes}); err != nil {
				return n, total, err
			}
		}
	}
	return n, total, nil
}

// AuditSystem writes a system audit entry that is not about one ticket (e.g. storage.pressure).
func (s *Service) AuditSystem(ctx context.Context, action, resType, resID string, detail map[string]any) error {
	return audit.Write(ctx, s.DB, audit.Entry{ActorLabel: "system", Action: action, ResourceType: resType, ResourceID: resID, Detail: detail})
}
