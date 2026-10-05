-- Keep source removal non-destructive so a user-deleted source does not return
-- from Neon after a browser reload.
ALTER TABLE source_connections
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS source_connections_active_idx
  ON source_connections(updated_at DESC)
  WHERE archived_at IS NULL;
