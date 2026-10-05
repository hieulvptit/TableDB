-- The Agent runs in the desktop app (LLM / OpenMetadata tokens live in the OS credential store on the user's machine).
-- The server-side settings and the encrypted per-user tokens are no longer used.
DROP TABLE IF EXISTS openmetadata_tokens;
DROP TABLE IF EXISTS agent_tokens;
DROP TABLE IF EXISTS agent_settings;
