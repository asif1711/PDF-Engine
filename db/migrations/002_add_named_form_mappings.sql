ALTER TABLE form_mappings
  ADD COLUMN IF NOT EXISTS name text;

UPDATE form_mappings
  SET name = 'Default Mapping'
  WHERE name IS NULL OR btrim(name) = '';

ALTER TABLE form_mappings
  ALTER COLUMN name SET NOT NULL;

ALTER TABLE form_mappings
  DROP CONSTRAINT IF EXISTS form_mappings_form_template_unique;

CREATE INDEX IF NOT EXISTS form_mappings_form_template_idx
  ON form_mappings(form_id, template_id);
