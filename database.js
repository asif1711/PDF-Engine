import dotenv from 'dotenv';
import pg from 'pg';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptCredential, decryptCredential, isEncryptedCredential } from './server/credentialEncryption.js';

const { Pool } = pg;
const rootDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(rootDir, '.env'), override: false, quiet: true });

let runtimePool;
let schemaInitialized = false;
let schemaInitPromise = null;

// =========================================================
// IN-MEMORY DATA STORE (Active when PostgreSQL is offline)
// =========================================================
const memTemplates = new Map();
const memMappings = new Map();
const memConnections = new Map();
const memForms = new Map();
const memApiKeys = new Map();

function seedInMemoryFromRegistry() {
  try {
    const registryPath = path.join(rootDir, 'sources-and-templates.json');
    if (fsSync.existsSync(registryPath)) {
      const data = JSON.parse(fsSync.readFileSync(registryPath, 'utf8'));
      if (Array.isArray(data.gravityFormSources)) {
        for (const src of data.gravityFormSources) {
          const id = String(src.id || '').trim();
          if (id) {
            memConnections.set(id, {
              id,
              name: src.name || id,
              connection_type: src.type || 'wordpress',
              site_url: src.url || '',
              config_json: { isDefault: Boolean(src.isDefault), notes: src.notes || '' },
              encrypted_api_key: src.apiKey ? encryptCredential(src.apiKey) : null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              archived_at: null,
            });
            if (src.apiKey) {
              memApiKeys.set(id, src.apiKey);
            }
          }
        }
      }
      if (Array.isArray(data.pdfTemplates)) {
        for (const tpl of data.pdfTemplates) {
          const id = String(tpl.id || '').trim();
          if (id) {
            memTemplates.set(id, {
              id,
              filename: tpl.filename || `${id}.pdf`,
              pdf_template_url: tpl.url || tpl.cdnUrl || tpl.localUrl || '',
              analysis_json: tpl.analysis || null,
              metadata_json: {
                name: tpl.name || id,
                category: tpl.category || 'NPA',
                isBuiltin: Boolean(tpl.isBuiltin),
                cdnUrl: tpl.cdnUrl || '',
                gcsPath: tpl.gcsPath || '',
                gcsUri: tpl.gcsUri || '',
                consoleUrl: tpl.consoleUrl || '',
              },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn('[DB] Could not seed in-memory store from registry:', err.message);
  }

  // Ensure default NPA template is present
  if (!memTemplates.has('default-npa')) {
    memTemplates.set('default-npa', {
      id: 'default-npa',
      filename: 'NPA_Credit Transfer Forms_V2.1.pdf',
      pdf_template_url: '/templates/NPA/NPA_Credit_Transfer_Forms_V2.1.pdf',
      analysis_json: null,
      metadata_json: {
        name: 'NPA_Credit Transfer Forms_V2.1.pdf',
        category: 'NPA',
        isBuiltin: true,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
}

// Seed on startup
seedInMemoryFromRegistry();

function getConnectionString() {
  return process.env.DATABASE_URL || process.env.DATABASE_URL_POOLED || process.env.DIRECT_DATABASE_URL;
}

function getRuntimePool() {
  const connectionString = getConnectionString();
  if (!connectionString) {
    return null;
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
  if (!getConnectionString()) return;
  if (schemaInitPromise) return schemaInitPromise;

  schemaInitPromise = (async () => {
    try {
      await runDatabaseMigrations();
      schemaInitialized = true;
    } catch (err) {
      schemaInitPromise = null;
      console.warn('Database schema migration warning:', err.message);
    }
  })();

  return schemaInitPromise;
}

async function queryRuntime(sql, values = []) {
  const connectionString = getConnectionString();
  if (!connectionString) {
    return null;
  }
  if (!schemaInitialized) {
    try {
      await ensureDatabaseSchema();
    } catch (err) {
      console.warn('Database schema migration warning:', err.message);
    }
  }
  const pool = getRuntimePool();
  if (!pool) return null;
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

function persistTemplateToRegistryFile(record) {
  try {
    const registryPath = path.join(rootDir, 'sources-and-templates.json');
    const publicPath = path.join(rootDir, 'pdf-mapper', 'public', 'sources-and-templates.json');
    const distPath = path.join(rootDir, 'pdf-mapper', 'dist', 'sources-and-templates.json');
    let data = { version: 1, pdfTemplates: [], gravityFormSources: [] };
    if (fsSync.existsSync(registryPath)) {
      try {
        data = JSON.parse(fsSync.readFileSync(registryPath, 'utf8'));
      } catch {}
    }
    if (!Array.isArray(data.pdfTemplates)) data.pdfTemplates = [];

    const templateId = String(record.templateId || record.id || '').trim();
    const meta = record.metadata && typeof record.metadata === 'object' ? record.metadata : {};
    const name = meta.name || record.filename || record.name || templateId;
    const filename = record.filename || meta.name || `${templateId}.pdf`;
    const url = record.url || meta.cdnUrl || meta.sourceUrl || '';

    const item = {
      id: templateId,
      name,
      filename,
      category: meta.category || 'Others',
      isBuiltin: Boolean(meta.isBuiltin),
      url,
      gcsPath: meta.gcsPath || '',
      gcsUri: meta.gcsUri || '',
      cdnUrl: meta.cdnUrl || (url.startsWith('http') ? url : ''),
      consoleUrl: meta.consoleUrl || '',
      analysis: record.analysis || null,
      metadata: meta,
      updatedAt: new Date().toISOString(),
    };

    const idx = data.pdfTemplates.findIndex((t) => String(t.id).trim() === templateId);
    if (idx >= 0) {
      data.pdfTemplates[idx] = { ...data.pdfTemplates[idx], ...item };
    } else {
      data.pdfTemplates.push(item);
    }
    data.lastUpdated = new Date().toISOString();
    const serialized = JSON.stringify(data, null, 2);
    fsSync.writeFileSync(registryPath, serialized, 'utf8');
    if (fsSync.existsSync(path.dirname(publicPath))) {
      fsSync.writeFileSync(publicPath, serialized, 'utf8');
    }
    if (fsSync.existsSync(path.dirname(distPath))) {
      fsSync.writeFileSync(distPath, serialized, 'utf8');
    }
  } catch (err) {
    console.warn('[DB] Could not sync template to sources-and-templates.json:', err.message);
  }
}

export async function deletePdfTemplateRecord(templateId) {
  const id = String(templateId || '').trim();
  if (!id) return false;
  memTemplates.delete(id);

  try {
    const registryPath = path.join(rootDir, 'sources-and-templates.json');
    const publicPath = path.join(rootDir, 'pdf-mapper', 'public', 'sources-and-templates.json');
    const distPath = path.join(rootDir, 'pdf-mapper', 'dist', 'sources-and-templates.json');
    if (fsSync.existsSync(registryPath)) {
      const data = JSON.parse(fsSync.readFileSync(registryPath, 'utf8'));
      if (Array.isArray(data.pdfTemplates)) {
        data.pdfTemplates = data.pdfTemplates.filter((t) => String(t.id).trim() !== id);
        data.lastUpdated = new Date().toISOString();
        const serialized = JSON.stringify(data, null, 2);
        fsSync.writeFileSync(registryPath, serialized, 'utf8');
        if (fsSync.existsSync(path.dirname(publicPath))) {
          fsSync.writeFileSync(publicPath, serialized, 'utf8');
        }
        if (fsSync.existsSync(path.dirname(distPath))) {
          fsSync.writeFileSync(distPath, serialized, 'utf8');
        }
      }
    }
  } catch (err) {
    console.warn('[DB] Could not remove template from sources-and-templates.json:', err.message);
  }

  try {
    const result = await queryRuntime(`DELETE FROM pdf_templates WHERE id = $1`, [id]);
    if (result) return true;
  } catch (err) {
    console.warn('[DB] Error deleting from PostgreSQL pdf_templates:', err.message);
  }
  return true;
}

export async function upsertPdfTemplateRecord(record = {}) {
  const templateId = String(record.templateId || record.id || '').trim();
  if (!templateId) return false;

  // Always update in-memory cache
  const existing = memTemplates.get(templateId) || {};
  const meta = { ...(existing.metadata_json || {}), ...templateMetadata(record) };
  const targetUrl = persistableUrl(record) || existing.pdf_template_url || null;
  const analysisObj = record.analysis && typeof record.analysis === 'object' ? record.analysis : (existing.analysis_json || null);

  memTemplates.set(templateId, {
    ...existing,
    id: templateId,
    filename: String(record.filename || existing.filename || ''),
    pdf_template_url: targetUrl,
    analysis_json: analysisObj,
    metadata_json: meta,
    updated_at: new Date().toISOString(),
    created_at: existing.created_at || new Date().toISOString(),
  });

  // Sync to disk file sources-and-templates.json
  persistTemplateToRegistryFile({
    id: templateId,
    templateId,
    filename: String(record.filename || existing.filename || ''),
    url: targetUrl,
    analysis: analysisObj,
    metadata: meta,
  });

  try {
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
        String(record.filename || existing.filename || ''),
        targetUrl,
        analysisObj ? JSON.stringify(analysisObj) : null,
        JSON.stringify(meta || {}),
      ],
    );
    if (result) return true;
  } catch (err) {
    console.warn('[DB] Falling back to in-memory/file store for upsertPdfTemplateRecord:', err.message);
  }

  return true;
}

function formatTemplateRow(row) {
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
}

export async function listPdfTemplateRecords() {
  try {
    const result = await queryRuntime(
      `SELECT * FROM pdf_templates ORDER BY updated_at DESC, filename ASC`,
    );
    if (result && result.rows) {
      return result.rows.map(formatTemplateRow);
    }
  } catch (err) {
    console.warn('[DB] Falling back to in-memory store for listPdfTemplateRecords:', err.message);
  }

  // In-memory fallback
  return Array.from(memTemplates.values()).map(formatTemplateRow);
}

export async function getPdfTemplateRecord(templateId) {
  try {
    const result = await queryRuntime(
      `SELECT id, filename, pdf_template_url, analysis_json, metadata_json
       FROM pdf_templates WHERE id = $1`,
      [String(templateId)],
    );
    const row = result?.rows[0];
    if (row) {
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
  } catch (err) {
    console.warn('[DB] Falling back to in-memory store for getPdfTemplateRecord:', err.message);
  }

  // In-memory fallback
  const row = memTemplates.get(String(templateId));
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
    id: row.mapping_record_id || row.id,
    name: row.mapping_name || row.name,
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
  try {
    const sourceClause = sourceConnectionId ? ' AND m.source_connection_id = $3' : '';
    const result = await queryRuntime(
      `${mappingSelect} WHERE m.form_id = $1 AND m.template_id = $2${sourceClause} ORDER BY m.updated_at DESC LIMIT 1`,
      sourceConnectionId ? [String(formId), String(templateId), String(sourceConnectionId)] : [String(formId), String(templateId)],
    );
    if (result?.rows[0]) {
      return mappingRecord(result.rows[0]);
    }
  } catch (err) {
    console.warn('[DB] Falling back to in-memory store for getFormMappingRecord:', err.message);
  }

  // In-memory fallback
  for (const m of memMappings.values()) {
    if (String(m.form_id) === String(formId) && String(m.template_id) === String(templateId)) {
      if (!sourceConnectionId || String(m.source_connection_id) === String(sourceConnectionId)) {
        const t = memTemplates.get(m.template_id);
        return mappingRecord({
          ...m,
          filename: t?.filename || m.mapping_json?.templateFilename,
          pdf_template_url: t?.pdf_template_url,
          analysis_json: t?.analysis_json,
          metadata_json: t?.metadata_json,
        });
      }
    }
  }
  return null;
}

export async function listFormMappingRecords(formId = null, templateId = null, sourceConnectionId = null) {
  try {
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
    if (result && result.rows) {
      return result.rows.map(mappingRecord);
    }
  } catch (err) {
    console.warn('[DB] Falling back to in-memory store for listFormMappingRecords:', err.message);
  }

  // In-memory fallback
  const list = [];
  for (const m of memMappings.values()) {
    if (formId !== null && String(m.form_id) !== String(formId)) continue;
    if (templateId !== null && String(m.template_id) !== String(templateId)) continue;
    if (sourceConnectionId !== null && String(m.source_connection_id) !== String(sourceConnectionId)) continue;
    const t = memTemplates.get(m.template_id);
    list.push(mappingRecord({
      ...m,
      filename: t?.filename || m.mapping_json?.templateFilename,
      pdf_template_url: t?.pdf_template_url,
      analysis_json: t?.analysis_json,
      metadata_json: t?.metadata_json,
    }));
  }
  return list;
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

  const recordId = `map-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  const memoryRecord = {
    id: recordId,
    mapping_record_id: recordId,
    name: normalizedName,
    mapping_name: normalizedName,
    form_id: normalizedFormId,
    template_id: normalizedTemplateId,
    mapping_json: mapping,
    source_connection_id: sourceConnectionId ? String(sourceConnectionId) : null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  memMappings.set(recordId, memoryRecord);

  try {
    const result = await queryRuntime(
      `INSERT INTO form_mappings (name, form_id, template_id, mapping_json, source_connection_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id, name, form_id, template_id, mapping_json, source_connection_id`,
      [normalizedName, normalizedFormId, normalizedTemplateId, mapping, sourceConnectionId ? String(sourceConnectionId) : null],
    );
    const row = result?.rows[0];
    if (row) {
      return {
        id: row.id,
        name: row.name,
        formId: row.form_id,
        sourceConnectionId: row.source_connection_id,
        templateId: row.template_id,
        mapping: row.mapping_json,
      };
    }
  } catch (err) {
    console.warn('[DB] Falling back to in-memory store for createFormMappingRecord:', err.message);
  }

  return {
    id: recordId,
    name: normalizedName,
    formId: normalizedFormId,
    sourceConnectionId: sourceConnectionId ? String(sourceConnectionId) : null,
    templateId: normalizedTemplateId,
    mapping,
  };
}

function sourceConnectionRecord(row) {
  const hasApiKey = row.encrypted_api_key && isEncryptedCredential(row.encrypted_api_key);
  return {
    id: row.id,
    name: row.name,
    type: row.connection_type,
    url: row.site_url,
    apiKeyConfigured: Boolean(hasApiKey || memApiKeys.has(row.id)),
    ...((row.config_json && typeof row.config_json === 'object') ? row.config_json : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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
      memApiKeys.set(id, record.apiKey.trim());
    } catch (err) {
      console.error('[DB] Failed to encrypt API key:', err.message);
      memApiKeys.set(id, record.apiKey.trim());
    }
  }

  // Update in-memory cache
  const existing = memConnections.get(id) || {};
  const inMemoryConn = {
    ...existing,
    id,
    name,
    connection_type: String(record.type || record.connectionType || 'wordpress'),
    site_url: url,
    config_json: config,
    encrypted_api_key: encryptedApiKey || existing.encrypted_api_key || null,
    archived_at: null,
    updated_at: new Date().toISOString(),
    created_at: existing.created_at || new Date().toISOString(),
  };
  memConnections.set(id, inMemoryConn);

  try {
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
      [id, name, inMemoryConn.connection_type, url, config, encryptedApiKey],
    );
    if (result?.rows[0]) {
      return sourceConnectionRecord(result.rows[0]);
    }
  } catch (err) {
    console.warn('[DB] Falling back to in-memory store for upsertSourceConnection:', err.message);
  }

  return sourceConnectionRecord(inMemoryConn);
}

export async function getSourceConnection(id) {
  try {
    const result = await queryRuntime(
      `SELECT id, name, connection_type, site_url, config_json, encrypted_api_key, created_at, updated_at
       FROM source_connections WHERE id = $1 AND archived_at IS NULL`,
      [String(id)],
    );
    if (result?.rows[0]) {
      return sourceConnectionRecord(result.rows[0]);
    }
  } catch (err) {
    console.warn('[DB] Falling back to in-memory store for getSourceConnection:', err.message);
  }

  // In-memory fallback
  const conn = memConnections.get(String(id));
  if (!conn || conn.archived_at) return null;
  return sourceConnectionRecord(conn);
}

export async function getSourceConnectionApiKey(id) {
  // Check memory store first
  if (memApiKeys.has(String(id))) {
    return memApiKeys.get(String(id));
  }

  try {
    const result = await queryRuntime(
      `SELECT encrypted_api_key FROM source_connections WHERE id = $1 AND archived_at IS NULL`,
      [String(id)],
    );
    const row = result?.rows[0];
    if (row && row.encrypted_api_key) {
      try {
        const decrypted = decryptCredential(row.encrypted_api_key);
        if (decrypted) {
          memApiKeys.set(String(id), decrypted);
          return decrypted;
        }
      } catch (err) {
        console.error(`[DB] Failed to decrypt API key for source ${id}:`, err.message);
      }
    }
  } catch (err) {
    console.warn('[DB] Falling back to in-memory store for getSourceConnectionApiKey:', err.message);
  }

  const conn = memConnections.get(String(id));
  if (conn?.encrypted_api_key) {
    try {
      return decryptCredential(conn.encrypted_api_key);
    } catch {}
  }

  return null;
}

export async function listSourceConnections() {
  try {
    const result = await queryRuntime(
      `SELECT id, name, connection_type, site_url, config_json, created_at, updated_at
       FROM source_connections WHERE archived_at IS NULL ORDER BY updated_at DESC, name ASC`,
    );
    if (result && result.rows) {
      return result.rows.map(sourceConnectionRecord);
    }
  } catch (err) {
    console.warn('[DB] Falling back to in-memory store for listSourceConnections:', err.message);
  }

  // In-memory fallback
  const active = [];
  for (const conn of memConnections.values()) {
    if (!conn.archived_at) {
      active.push(sourceConnectionRecord(conn));
    }
  }
  return active;
}

export async function archiveSourceConnection(id) {
  const strId = String(id);
  const conn = memConnections.get(strId);
  if (conn) {
    conn.archived_at = new Date().toISOString();
    conn.updated_at = new Date().toISOString();
  }

  try {
    const result = await queryRuntime(
      `UPDATE source_connections SET archived_at = now(), updated_at = now()
       WHERE id = $1 AND archived_at IS NULL RETURNING id`,
      [strId],
    );
    if (result?.rows[0]) return true;
  } catch (err) {
    console.warn('[DB] Falling back to in-memory store for archiveSourceConnection:', err.message);
  }

  return Boolean(conn);
}

export async function upsertSourceForms(sourceConnectionId, forms = []) {
  if (!sourceConnectionId || !Array.isArray(forms)) return false;

  for (const form of forms) {
    const formId = String(form?.id || form?.form_id || '').trim();
    if (!formId) continue;
    const key = `${sourceConnectionId}:${formId}`;
    memForms.set(key, {
      id: formId,
      name: String(form.title || form.name || form.label || ''),
      snapshot: form,
      sourceConnectionId: String(sourceConnectionId),
      updatedAt: new Date().toISOString(),
    });
  }

  try {
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
  } catch (err) {
    console.warn('[DB] Falling back to in-memory store for upsertSourceForms:', err.message);
  }

  return true;
}

export async function listSourceForms(sourceConnectionId) {
  try {
    const result = await queryRuntime(
      `SELECT form_id, form_name, form_snapshot_json, updated_at
       FROM source_forms WHERE source_connection_id = $1 ORDER BY form_name ASC`,
      [String(sourceConnectionId)],
    );
    if (result && result.rows) {
      return result.rows.map((row) => ({
        id: row.form_id,
        name: row.form_name,
        snapshot: row.form_snapshot_json,
        updatedAt: row.updated_at,
      }));
    }
  } catch (err) {
    console.warn('[DB] Falling back to in-memory store for listSourceForms:', err.message);
  }

  // In-memory fallback
  const list = [];
  for (const form of memForms.values()) {
    if (form.sourceConnectionId === String(sourceConnectionId)) {
      list.push({
        id: form.id,
        name: form.name,
        snapshot: form.snapshot,
        updatedAt: form.updatedAt,
      });
    }
  }
  return list;
}

export async function runDatabaseMigrations() {
  const connectionString = getConnectionString();
  if (!connectionString) {
    console.warn('[DB] No PostgreSQL connection configured. Running in in-memory mode.');
    return;
  }

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

// In-memory logs store
const memWpDispatchLogs = [];
let memWpAutomationSettings = {
  enabled: false,
  formId: '',
  sourceConnectionId: '',
  pollIntervalSeconds: 15,
  cleanAfterSend: true,
  deleteDelaySeconds: 30,
  sendNotification: true,
};

export async function addWpDispatchLog(entry) {
  const logItem = {
    id: entry.id || `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: entry.timestamp || new Date().toISOString(),
    formId: String(entry.formId || ''),
    entryId: String(entry.entryId || ''),
    action: entry.action || 'manual',
    wordpressUrl: entry.wordpressUrl || '',
    gcpPdfUrl: entry.gcpPdfUrl || '',
    wpFilename: entry.wpFilename || '',
    fileSize: entry.fileSize || 0,
    notificationRequested: Boolean(entry.notificationRequested),
    notificationSent: Boolean(entry.notificationSent),
    notificationError: entry.notificationError || null,
    cleanupStatus: entry.cleanupStatus || 'retained',
    cleanupTime: entry.cleanupTime || null,
    status: entry.status || 'success',
    message: entry.message || '',
  };

  memWpDispatchLogs.unshift(logItem);
  if (memWpDispatchLogs.length > 300) {
    memWpDispatchLogs.pop();
  }

  try {
    await queryRuntime(
      `INSERT INTO wp_dispatch_logs (id, form_id, entry_id, action, wordpress_url, gcp_pdf_url, wp_filename, file_size, notification_sent, cleanup_status, status, message, payload_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         cleanup_status = EXCLUDED.cleanup_status,
         notification_sent = EXCLUDED.notification_sent,
         status = EXCLUDED.status,
         message = EXCLUDED.message,
         payload_json = EXCLUDED.payload_json,
         updated_at = NOW()`,
      [
        logItem.id,
        logItem.formId,
        logItem.entryId,
        logItem.action,
        logItem.wordpressUrl,
        logItem.gcpPdfUrl,
        logItem.wpFilename,
        logItem.fileSize,
        logItem.notificationSent,
        logItem.cleanupStatus,
        logItem.status,
        logItem.message,
        JSON.stringify(logItem),
      ]
    );
  } catch {
    // In-memory fallback
  }

  return logItem;
}

export async function updateWpDispatchLog(id, patch) {
  const item = memWpDispatchLogs.find(l => l.id === id);
  if (item) {
    Object.assign(item, patch);
  }
  try {
    if (patch.cleanupStatus) {
      await queryRuntime(
        `UPDATE wp_dispatch_logs SET cleanup_status = $1, updated_at = NOW() WHERE id = $2`,
        [patch.cleanupStatus, id]
      );
    }
  } catch {}
  return item;
}

export async function listWpDispatchLogs(limit = 100) {
  try {
    const res = await queryRuntime(
      `SELECT * FROM wp_dispatch_logs ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    if (res && res.rows && res.rows.length > 0) {
      return res.rows.map(r => ({
        id: r.id,
        timestamp: r.created_at,
        formId: r.form_id,
        entryId: r.entry_id,
        action: r.action,
        wordpressUrl: r.wordpress_url,
        gcpPdfUrl: r.gcp_pdf_url,
        wpFilename: r.wp_filename,
        fileSize: Number(r.file_size) || 0,
        notificationSent: r.notification_sent,
        cleanupStatus: r.cleanup_status,
        status: r.status,
        message: r.message,
        ...(r.payload_json || {}),
      }));
    }
  } catch {}
  return memWpDispatchLogs.slice(0, limit);
}

export async function clearWpDispatchLogs() {
  memWpDispatchLogs.length = 0;
  try {
    await queryRuntime(`DELETE FROM wp_dispatch_logs`);
  } catch {}
  return true;
}

export function getWpAutomationSettings() {
  return { ...memWpAutomationSettings };
}

export function saveWpAutomationSettings(settings) {
  memWpAutomationSettings = {
    ...memWpAutomationSettings,
    ...settings,
  };
  return { ...memWpAutomationSettings };
}
