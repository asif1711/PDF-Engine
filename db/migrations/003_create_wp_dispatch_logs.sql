CREATE TABLE IF NOT EXISTS wp_dispatch_logs (
  id VARCHAR(120) PRIMARY KEY,
  form_id VARCHAR(50),
  entry_id VARCHAR(50),
  action VARCHAR(50) DEFAULT 'manual',
  wordpress_url TEXT,
  gcp_pdf_url TEXT,
  wp_filename VARCHAR(255),
  file_size BIGINT DEFAULT 0,
  notification_sent BOOLEAN DEFAULT FALSE,
  cleanup_status VARCHAR(50) DEFAULT 'retained',
  status VARCHAR(50) DEFAULT 'success',
  message TEXT,
  payload_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wp_dispatch_logs_entry ON wp_dispatch_logs(entry_id);
CREATE INDEX IF NOT EXISTS idx_wp_dispatch_logs_created ON wp_dispatch_logs(created_at DESC);
