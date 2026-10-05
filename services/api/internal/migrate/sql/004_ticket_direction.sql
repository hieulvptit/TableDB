-- Transfers now go both ways: desktop (jump host) -> office, and web BO (office) -> jump host.
-- The server derives the direction from the uploader's session kind; existing tickets were all desktop uploads.
ALTER TABLE tickets ADD COLUMN direction text NOT NULL DEFAULT 'JUMP_TO_OFFICE' CHECK (direction IN ('JUMP_TO_OFFICE','OFFICE_TO_JUMP'));
ALTER TABLE tickets ALTER COLUMN direction DROP DEFAULT;
