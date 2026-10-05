-- Persist non-secret WordPress/Gravity Forms source metadata. Credentials remain
-- in the existing browser-local connection storage.
CREATE TABLE IF NOT EXISTS source_connections (
  id text PRIMARY KEY,
  name text NOT NULL,
  connection_type text NOT NULL DEFAULT 'wordpress',
  site_url text NOT NULL,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_connections_type_check CHECK (connection_type <> '')
);

CREATE INDEX IF NOT EXISTS source_connections_type_idx
  ON source_connections(connection_type);
CREATE INDEX IF NOT EXISTS source_connections_site_url_idx
  ON source_connections(site_url);

-- Gravity Form IDs are scoped to their WordPress source, not globally.
CREATE TABLE IF NOT EXISTS source_forms (
  source_connection_id text NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
  form_id text NOT NULL,
  form_name text,
  form_snapshot_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_connection_id, form_id)
);

CREATE INDEX IF NOT EXISTS source_forms_form_id_idx ON source_forms(form_id);

-- Existing mappings remain valid. New mappings can be unambiguously scoped to a
-- persisted source while legacy records continue to have a NULL source.
ALTER TABLE form_mappings
  ADD COLUMN IF NOT EXISTS source_connection_id text
  REFERENCES source_connections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS form_mappings_source_form_template_idx
  ON form_mappings(source_connection_id, form_id, template_id);
