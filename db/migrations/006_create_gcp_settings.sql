CREATE TABLE IF NOT EXISTS gcp_settings (
  id VARCHAR(50) PRIMARY KEY DEFAULT 'default',
  bucket VARCHAR(255) NOT NULL DEFAULT 'vc-pdf-generator-storage',
  project_id VARCHAR(255) NOT NULL DEFAULT 'aibt-244204',
  base_path VARCHAR(255) NOT NULL DEFAULT 'templates',
  generated_path VARCHAR(255) NOT NULL DEFAULT 'generated',
  service_account_key TEXT,
  encrypted_service_account_key TEXT,
  access_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
