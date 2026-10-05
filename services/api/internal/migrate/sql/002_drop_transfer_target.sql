-- Uploads no longer pick a destination system (files go from the jump host to the office).
-- Keep the column and transfer_targets table so historical tickets/audit stay intact.
ALTER TABLE tickets ALTER COLUMN target_id DROP NOT NULL;
