CREATE TABLE email_approval_links (
 token_hash text PRIMARY KEY,
 ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
 approver_id uuid NOT NULL REFERENCES users(id),
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_approval_links_ticket_idx ON email_approval_links(ticket_id);
