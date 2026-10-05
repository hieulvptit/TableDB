-- OpenMetadata MCP for the Agent: admin sets the MCP endpoint, each user stores their own OpenMetadata token (encrypted).
ALTER TABLE agent_settings ADD COLUMN openmetadata_url text;
CREATE TABLE openmetadata_tokens (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_enc text NOT NULL,
  last_verified_at timestamptz
);
