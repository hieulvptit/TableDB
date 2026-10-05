-- App database schema (PostgreSQL 14+; also runs on PGlite for dev/test)

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  subject text NOT NULL,
  email text NOT NULL,
  name text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);
CREATE UNIQUE INDEX users_email_idx ON users (lower(email));

CREATE TABLE role_assignments (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','leader','admin','service')),
  PRIMARY KEY (user_id, role)
);
CREATE TABLE user_grants (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission text NOT NULL,
  PRIMARY KEY (user_id, permission)
);
CREATE TABLE leaders (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE delegations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid NOT NULL REFERENCES users(id),
  to_user_id uuid NOT NULL REFERENCES users(id),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to > valid_from AND from_user_id <> to_user_id)
);

CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('web','desktop')),
  csrf text NOT NULL,
  auth_time timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  refresh_hash text,
  refresh_expires_at timestamptz
);
CREATE INDEX sessions_refresh_idx ON sessions (refresh_hash);
CREATE TABLE auth_states (
  state_hash text PRIMARY KEY,
  provider text NOT NULL,
  code_verifier text NOT NULL,
  nonce text NOT NULL,
  return_to text NOT NULL,
  stepup boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE db_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  driver text NOT NULL CHECK (driver IN ('oracle','trino','postgresql')),
  host text NOT NULL,
  port int NOT NULL,
  database text,
  allow_write boolean NOT NULL DEFAULT false,
  auth_modes text[] NOT NULL DEFAULT ARRAY['password'],
  proxy jsonb,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE db_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  target_id uuid NOT NULL REFERENCES db_targets(id) ON DELETE CASCADE,
  username text,
  default_schema text,
  UNIQUE (user_id, name)
);
CREATE TABLE db_sessions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES db_targets(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE TABLE agent_settings (
  id int PRIMARY KEY CHECK (id = 1),
  endpoints jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_endpoint_id text,
  default_model text,
  budget_chars int NOT NULL DEFAULT 12000
);
INSERT INTO agent_settings (id) VALUES (1);
CREATE TABLE agent_tokens (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  endpoint_id text NOT NULL,
  model text NOT NULL,
  token_enc text NOT NULL,
  last_verified_at timestamptz
);

CREATE TABLE transfer_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true
);

CREATE SEQUENCE ticket_code_seq START 1;
CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  requester_id uuid NOT NULL REFERENCES users(id),
  approver_id uuid NOT NULL REFERENCES users(id),
  target_id uuid NOT NULL REFERENCES transfer_targets(id),
  recipient_ids uuid[] NOT NULL DEFAULT '{}',
  file_name text NOT NULL,
  size bigint NOT NULL CHECK (size > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  purpose text NOT NULL,
  status text NOT NULL CHECK (status IN ('UPLOADING','SCANNING','PENDING_APPROVAL','APPROVED','DOWNLOADED','REJECTED','EXPIRED','REVOKED','QUARANTINED','ABORTED')),
  notify_state text NOT NULL DEFAULT 'PENDING' CHECK (notify_state IN ('PENDING','SENT','ERROR')),
  part_bytes int NOT NULL,
  total_parts int NOT NULL,
  dek_wrapped text NOT NULL,
  complete_idem_key text,
  scan_result text,
  scanned_at timestamptz,
  decision_reason text,
  expires_at timestamptz,
  download_count int NOT NULL DEFAULT 0,
  max_downloads int NOT NULL DEFAULT 3,
  first_downloaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approver_not_requester CHECK (approver_id <> requester_id)
);
CREATE INDEX tickets_requester_idx ON tickets (requester_id, created_at DESC);
CREATE INDEX tickets_approver_idx ON tickets (approver_id, status);

CREATE TABLE upload_parts (
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  n int NOT NULL,
  size int NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  PRIMARY KEY (ticket_id, n)
);
CREATE TABLE ticket_events (
  id bigserial PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,
  kind text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ticket_events_idx ON ticket_events (ticket_id, id);
CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL UNIQUE REFERENCES tickets(id),
  decided_by uuid NOT NULL REFERENCES users(id),
  on_behalf_of uuid,
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  reason text,
  decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE download_tokens (
  token_hash text PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE TABLE downloads (
  id bigserial PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  user_id uuid NOT NULL REFERENCES users(id),
  at timestamptz NOT NULL DEFAULT now(),
  ip text,
  sha256 text NOT NULL,
  bytes bigint NOT NULL
);

CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  dedupe_key text UNIQUE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','done','dead')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 8,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_due_idx ON outbox (state, next_run_at);
CREATE TABLE idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status_code int,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE TABLE audit_log (
  seq bigserial PRIMARY KEY,
  at timestamptz NOT NULL,
  actor_id uuid,
  actor_label text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL DEFAULT '',
  resource_id text NOT NULL DEFAULT '',
  ip text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash text NOT NULL,
  hash text NOT NULL
);
CREATE INDEX audit_actor_idx ON audit_log (actor_id, seq DESC);
CREATE INDEX audit_action_idx ON audit_log (action, seq DESC);
CREATE FUNCTION audit_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_immutable();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_immutable();

CREATE FUNCTION approvals_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'approvals are immutable'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER approvals_no_change BEFORE UPDATE OR DELETE ON approvals FOR EACH ROW EXECUTE FUNCTION approvals_immutable();
