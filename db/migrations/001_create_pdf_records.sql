CREATE TABLE IF NOT EXISTS pdf_templates (
  id text PRIMARY KEY,
  filename text NOT NULL DEFAULT '',
  pdf_template_url text,
  analysis_json jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS form_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id text NOT NULL,
  template_id text NOT NULL REFERENCES pdf_templates(id) ON DELETE CASCADE,
  mapping_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT form_mappings_form_template_unique UNIQUE (form_id, template_id)
);

CREATE INDEX IF NOT EXISTS form_mappings_template_id_idx ON form_mappings(template_id);