-- Audit trail / compliance trace (additive).
-- 1) who/when/where trace fields on the ticket; 2) immutable file-content manifest (METADATA ONLY: no content, no cell values).

ALTER TABLE tickets ADD COLUMN upload_started_at timestamptz;
ALTER TABLE tickets ADD COLUMN upload_completed_at timestamptz;
ALTER TABLE tickets ADD COLUMN client_ip text;
ALTER TABLE tickets ADD COLUMN client_user_agent text;
ALTER TABLE tickets ADD COLUMN client_kind text CHECK (client_kind IN ('web','desktop'));
ALTER TABLE tickets ADD COLUMN scan_engine text;
ALTER TABLE tickets ADD COLUMN scan_ms integer;

CREATE TABLE ticket_manifests (
  ticket_id uuid PRIMARY KEY REFERENCES tickets(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('ok','error')),
  inspect_error text,
  summary jsonb NOT NULL,
  entry_count integer NOT NULL,
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  duration_ms integer NOT NULL
);

CREATE TABLE ticket_manifest_entries (
  ticket_id uuid NOT NULL REFERENCES ticket_manifests(ticket_id),
  idx integer NOT NULL,
  entry jsonb NOT NULL,
  PRIMARY KEY (ticket_id, idx)
);

-- a manifest is evidence: written once, never changed or removed (same discipline as audit_log / approvals)
CREATE FUNCTION manifest_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'ticket manifests are immutable'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER manifests_no_change BEFORE UPDATE OR DELETE ON ticket_manifests FOR EACH ROW EXECUTE FUNCTION manifest_immutable();
CREATE TRIGGER manifests_no_truncate BEFORE TRUNCATE ON ticket_manifests FOR EACH STATEMENT EXECUTE FUNCTION manifest_immutable();
CREATE TRIGGER manifest_entries_no_change BEFORE UPDATE OR DELETE ON ticket_manifest_entries FOR EACH ROW EXECUTE FUNCTION manifest_immutable();
CREATE TRIGGER manifest_entries_no_truncate BEFORE TRUNCATE ON ticket_manifest_entries FOR EACH STATEMENT EXECUTE FUNCTION manifest_immutable();

-- audit lookups by resource / ticket code / actor label
CREATE INDEX audit_resource_idx ON audit_log (resource_id, seq);
CREATE INDEX audit_at_idx ON audit_log (at);
