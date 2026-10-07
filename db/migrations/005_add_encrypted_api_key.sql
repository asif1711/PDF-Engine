-- Add encrypted WordPress API key column to source_connections
-- Stores AES-256-GCM encrypted API keys. Decryption happens server-side only.
-- The column is nullable so existing source connections continue to work.

ALTER TABLE source_connections
  ADD COLUMN IF NOT EXISTS encrypted_api_key text;

CREATE INDEX IF NOT EXISTS source_connections_encrypted_api_key_idx
  ON source_connections(encrypted_api_key)
  WHERE encrypted_api_key IS NOT NULL;