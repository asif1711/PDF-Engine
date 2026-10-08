import dotenv from 'dotenv';
import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptCredential, decryptCredential, isEncryptedCredential } from './server/credentialEncryption.js';

const { Pool } = pg;
const rootDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(rootDir, '.env'), override: false, quiet: true });

let runtimePool;
let schemaInitialized = false;
let schemaInitPromise = null;

function getConnectionString() {
  return process.env.DATABASE_URL || process.env.DATABASE_URL_POOLED || process.env.DIRECT_DATABASE_URL;
}

function getRuntimePool() {
  const connectionString = getConnectionString();
  if (!connectionString) {
    throw new Error('Database connection string is not configured. Please set DATABASE_URL, DATABASE_URL_POOLED, or DIRECT_DATABASE_URL.');
  }
  if (runtimePool) return runtimePool;

  const isNeonOrSsl = connectionString.includes('neon.tech') || connectionString.includes('sslmode=require');
  runtimePool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: isNeonOrSsl ? { rejectUnauthorized: false } : undefined,
  });
  return runtimePool;
}

export async function ensureDatabaseSchema() {
  if (schemaInitialized) return;
  if (schemaInitPromise) return schemaInitPromise;

  schemaInitPromise = (async () => {
    try {
      await runDatabaseMigrations();
      schemaInitialized = true;
    } catch (err) {
      schemaInitPromise = null;
      throw err;
    }
  })();

  return schemaInitPromise;
}

async function queryRuntime(sql, values = []) {
  if (!schemaInitialized) {
    try {
      await ensureDatabaseSchema();
    } catch (err) {
      // If schema migration fails, let runtime pool query proceed so the precise database error surfaces to callers
      console.warn('Database schema migration warning:', err.message);
    }
  }
  const pool = getRuntimePool();
  return await pool.query(sql, values);
}

function persistableUrl(record) {
  const candidates = [record?.pdfTemplateUrl, record?.url, record?.localUrl, record?.sourceUrl, record?.cdnUrl];
  return candidates.find((value) => typeof value === 'string' && value && !value.startsWith('blob:')) || null;
}

function templateMetadata(record) {
  if (record?.metadata && typeof record.metadata === 'object') return record.metadata;
  const metadata = {};
  for (const key of ['name', 'category', 'localUrl', 'sourceUrl', 'gcsPath', 'gcsUri', 'cdnUrl', 'isBuiltin', 'createdAt', 'uploadStatus', 'notes']) {
    if (record?.[key] !== undefined) metadata[key] = record[key];
  }
  return metadata;
}

export async function upsertPdfTemplateRecord(record = {}) {
  const templateId = String(record.templateId || record.id || '').trim();
  if (!templateId) return false;

  const result = await queryRuntime(
    `INSERT INTO pdf_templates (id, filename, pdf_template_url, analysis_json, metadata_json)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       filename = COALESCE(NULLIF(EXCLUDED.filename, ''), pdf_templates.filename),
       pdf_template_url = COALESCE(EXCLUDED.pdf_template_url, pdf_templates.pdf_template_url),
       analysis_json = COALESCE(EXCLUDED.analysis_json, pdf_templates.analysis_json),
       metadata_json = COALESCE(EXCLUDED.metadata_json, pdf_templates.metadata_json),
       updated_at = now()`,
    [
      templateId,
      String(record.filename || ''),
      persistableUrl(record),
      record.analysis && typeof record.analysis === 'object' ? record.analysis : null,
      templateMetadata(record),
    ],
  );

  return Boolean(result);
}

export async function listPdfTemplateRecords() {
  const result = await queryRuntime(
    `SELECT * FROM pdf_templates ORDER BY updated_at DESC, filename ASC`,
  );
  return result.rows.map((row) => {
    const meta = row.metadata_json && typeof row.metadata_json === 'object' ? row.metadata_json : {};
    const name = row.metadata_name || meta.name || row.name || row.filename;
    const url = row.pdf_template_url || row.url || meta.url || meta.cdnUrl || meta.sourceUrl || '';
    const category = row.category !== undefined ? row.category : (meta.category !== undefined ? meta.category : null);
    const rawBuiltin = row.is_builtin !== undefined ? row.is_builtin : meta.isBuiltin;
    const isBuiltin = rawBuiltin === true || rawBuiltin === 'true' || rawBuiltin === 1 || rawBuiltin === '1';

    return {
      id: row.id,
      templateId: row.id,
      filename: row.filename || name,
      url,
      pdf_template_url: url,
      pdfTemplateUrl: url,
      name,
      metadata_name: name,
      category,
      isBuiltin,
      is_builtin: isBuiltin ? 'true' : null,
      analysis: row.analysis_json,
      metadata: meta,
      ...meta,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export async function getPdfTemplateRecord(templateId) {
  const result = await queryRuntime(
    `SELECT id, filename, pdf_template_url, analysis_json, metadata_json
     FROM pdf_templates WHERE id = $1`,
    [String(templateId)],
  );
  const row = result?.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    templateId: row.id,
    filename: row.filename,
    url: row.pdf_template_url,
    analysis: row.analysis_json,
    metadata: row.metadata_json || {},
    ...(row.metadata_json || {}),
  };
}

function mappingRecord(row) {
  return {
    id: row.mapping_record_id,
    name: row.mapping_name,
    formId: row.form_id,
    sourceConnectionId: row.source_connection_id,
    templateId: row.template_id,
    mapping: row.mapping_json,
    templateFilename: row.filename,
    pdfTemplateUrl: row.pdf_template_url,
    analysis: row.analysis_json,
    templateMetadata: row.metadata_json || {},
  };
}

const mappingSelect = `SELECT
    m.id AS mapping_record_id,
    m.name AS mapping_name,
    m.form_id,
    m.source_connection_id,
    m.template_id,
    m.mapping_json,
    t.filename,
    t.pdf_template_url,
    t.analysis_json,
    t.metadata_json
  FROM form_mappings m
  LEFT JOIN pdf_templates t ON t.id = m.template_id`;

export async function getFormMappingRecord(formId, templateId, sourceConnectionId = null) {
  const sourceClause = sourceConnectionId ? ' AND m.source_connection_id = $3' : '';
  const result = await queryRuntime(
    `${mappingSelect} WHERE m.form_id = $1 AND m.template_id = $2${sourceClause} ORDER BY m.updated_at DESC LIMIT 1`,
    sourceConnectionId ? [String(formId), String(templateId), String(sourceConnectionId)] : [String(formId), String(templateId)],
  );
  return result?.rows[0] ? mappingRecord(result.rows[0]) : null;
}

export async function listFormMappingRecords(formId = null, templateId = null, sourceConnectionId = null) {
  const clauses = [];
  const values = [];
  if (formId !== null) {
    values.push(String(formId));
    clauses.push(`m.form_id = $${values.length}`);
  }
  if (templateId !== null) {
    values.push(String(templateId));
    clauses.push(`m.template_id = $${values.length}`);
  }
  if (sourceConnectionId !== null) {
    values.push(String(sourceConnectionId));
    clauses.push(`m.source_connection_id = $${values.length}`);
  }
  const query = `${mappingSelect}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY m.updated_at DESC`;
  const result = await queryRuntime(query, values);
  return result ? result.rows.map(mappingRecord) : null;
}

export async function createFormMappingRecord({ formId, templateId, name, mapping, templateRecord = {}, sourceConnectionId = null }) {
  const normalizedFormId = String(formId || '').trim();
  const normalizedTemplateId = String(templateId || '').trim();
  const normalizedName = String(name || '').trim();
  if (!normalizedFormId || !normalizedTemplateId || !normalizedName || !mapping || typeof mapping !== 'object') {
    throw new Error('Invalid mapping parameters: formId, templateId, name, and mapping are required.');
  }

  await upsertPdfTemplateRecord({
    ...templateRecord,
    templateId: normalizedTemplateId,
    filename: templateRecord.filename || mapping.templateFilename,
  });

  const result = await queryRuntime(
    `INSERT INTO form_mappings (name, form_id, template_id, mapping_json, source_connection_id)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id, name, form_id, template_id, mapping_json, source_connection_id`,
    [normalizedName, normalizedFormId, normalizedTemplateId, mapping, sourceConnectionId ? String(sourceConnectionId) : null],
  );
  const row = result?.rows[0];
  if (!row) throw new Error('Failed to insert form mapping record into database.');
  return {
    id: row.id,
    name: row.name,
    formId: row.form_id,
    sourceConnectionId: row.source_connection_id,
    templateId: row.template_id,
    mapping: row.mapping_json,
  };
}

function sourceConnectionRecord(row) {
    const hasApiKey = row.encrypted_api_key && isEncryptedCredential(row.encrypted_api_key);
    return {
        id: row.id,
        name: row.name,
        type: row.connection_type,
        url: row.site_url,
        apiKeyConfigured: hasApiKey,
        ...((row.config_json && typeof row.config_json === 'object') ? row.config_json : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

// Intentionally accept only non-secret connection metadata. API keys are encrypted
// and stored server-side. Basic Auth credentials continue to use the existing local browser storage.
export async function upsertSourceConnection(record = {}) {
    const id = String(record.id || '').trim();
    const name = String(record.name || '').trim();
    const url = String(record.url || record.siteUrl || '').trim();
    if (!id || !name || !url) return null;
    const config = {};
    if (typeof record.isDefault === 'boolean') config.isDefault = record.isDefault;

    // Encrypt API key if provided
    let encryptedApiKey = null;
    if (record.apiKey && typeof record.apiKey === 'string' && record.apiKey.trim()) {
        try {
            encryptedApiKey = encryptCredential(record.apiKey.trim());
        } catch (err) {
            console.error('[DB] Failed to encrypt API key:', err.message);
            throw new Error('Failed to encrypt API key. Check CREDENTIAL_ENCRYPTION_KEY configuration.');
        }
    }

    const result = await queryRuntime(
        `INSERT INTO source_connections (id, name, connection_type, site_url, config_json, encrypted_api_key)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           connection_type = EXCLUDED.connection_type,
           site_url = EXCLUDED.site_url,
           config_json = EXCLUDED.config_json,
           encrypted_api_key = COALESCE(EXCLUDED.encrypted_api_key, source_connections.encrypted_api_key),
           archived_at = NULL,
           updated_at = now()
         RETURNING id, name, connection_type, site_url, config_json, encrypted_api_key, created_at, updated_at`,
        [id, name, String(record.type || record.connectionType || 'wordpress'), url, config, encryptedApiKey],
    );
    return result?.rows[0] ? sourceConnectionRecord(result.rows[0]) : null;
}

export async function getSourceConnection(id) {
    const result = await queryRuntime(
        `SELECT id, name, connection_type, site_url, config_json, encrypted_api_key, created_at, updated_at
         FROM source_connections WHERE id = $1 AND archived_at IS NULL`,
        [String(id)],
    );
    return result?.rows[0] ? sourceConnectionRecord(result.rows[0]) : null;
}

/**
 * Get the decrypted API key for a source connection.
 * Only for server-side use (e.g., /api/push-pdf-to-wp).
 * Returns null if no key is configured or decryption fails.
 */
export async function getSourceConnectionApiKey(id) {
    const result = await queryRuntime(
        `SELECT encrypted_api_key FROM source_connections WHERE id = $1 AND archived_at IS NULL`,
        [String(id)],
    );
    const row = result?.rows[0];
    if (!row || !row.encrypted_api_key) return null;

    try {
        return decryptCredential(row.encrypted_api_key);
    } catch (err) {
        console.error(`[DB] Failed to decrypt API key for source ${id}:`, err.message);
        return null;
    }
}

export async function listSourceConnections() {
  const result = await queryRuntime(
    `SELECT id, name, connection_type, site_url, config_json, created_at, updated_at
     FROM source_connections WHERE archived_at IS NULL ORDER BY updated_at DESC, name ASC`,
  );
  return result ? result.rows.map(sourceConnectionRecord) : null;
}

export async function archiveSourceConnection(id) {
  const result = await queryRuntime(
    `UPDATE source_connections SET archived_at = now(), updated_at = now()
     WHERE id = $1 AND archived_at IS NULL RETURNING id`,
    [String(id)],
  );
  return Boolean(result?.rows[0]);
}

export async function upsertSourceForms(sourceConnectionId, forms = []) {
  if (!sourceConnectionId || !Array.isArray(forms)) return false;
  for (const form of forms) {
    const formId = String(form?.id || form?.form_id || '').trim();
    if (!formId) continue;
    await queryRuntime(
      `INSERT INTO source_forms (source_connection_id, form_id, form_name, form_snapshot_json)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (source_connection_id, form_id) DO UPDATE SET
         form_name = EXCLUDED.form_name,
         form_snapshot_json = EXCLUDED.form_snapshot_json,
         updated_at = now()`,
      [String(sourceConnectionId), formId, String(form.title || form.name || form.label || ''), form],
    );
  }
  return true;
}

export async function listSourceForms(sourceConnectionId) {
  const result = await queryRuntime(
    `SELECT form_id, form_name, form_snapshot_json, updated_at
     FROM source_forms WHERE source_connection_id = $1 ORDER BY form_name ASC`,
    [String(sourceConnectionId)],
  );
  return result.rows.map((row) => ({
    id: row.form_id,
    name: row.form_name,
    snapshot: row.form_snapshot_json,
    updatedAt: row.updated_at,
  }));
}

export async function runDatabaseMigrations() {
  const connectionString = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || process.env.DATABASE_URL_POOLED;
  if (!connectionString) throw new Error('Database connection string is not configured (DIRECT_DATABASE_URL, DATABASE_URL, or DATABASE_URL_POOLED).');

  const isNeonOrSsl = connectionString.includes('neon.tech') || connectionString.includes('sslmode=require');
  const migrationPool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    ssl: isNeonOrSsl ? { rejectUnauthorized: false } : undefined,
  });

  try {
    const migrationsDir = path.join(rootDir, 'db', 'migrations');
    const migrationFiles = (await fs.readdir(migrationsDir))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const file of migrationFiles) {
      const migration = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      await migrationPool.query(migration);
    }
  } finally {
    await migrationPool.end();
  }
}
