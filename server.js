import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateFilledPdf } from './pdf-mapper/src/pdfGenerator.js';
import { normalizeSavedMappings } from './pdf-mapper/src/mappingUtils.js';
import { analyzePdfBytes } from './analyze-template.js';
import {
  getFormMappingRecord,
  getPdfTemplateRecord,
  getSourceConnection,
  getSourceConnectionApiKey,
  listPdfTemplateRecords,
  listFormMappingRecords,
  listSourceConnections,
  upsertSourceConnection,
  createFormMappingRecord,
  archiveSourceConnection,
  upsertSourceForms,
} from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const GCS_BUCKET = process.env.GCS_BUCKET_NAME || 'cdn.vconsultancy.com.au';
const GCS_PROJECT_ID = process.env.GCS_PROJECT_ID || 'aibt-244204';
const GCS_BASE_PATH = 'pdf-generator/templates';
const ALLOWED_CATEGORIES = ['AIBT', 'AIBT-I', 'AVTA', 'NPA', 'BIC', 'REACH', 'HJ', 'Pivot', 'Profound', 'Others'];

// CORS and Preflight
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-PDF-API-Key, ngrok-skip-browser-warning, x-gcs-token');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// JSON and URL-encoded body parser
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Helper: Get Google Access Token for GCS
// Supports an explicitly supplied token (x-gcs-token header / customToken) or the
// GCS_ACCESS_TOKEN environment variable. Service-account credential fallbacks
// (GCS_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS) are not supported;
// GCS endpoints report `credentials_needed` when no token is available.
async function getGoogleAccessToken(explicitToken) {
  if (explicitToken && explicitToken.trim()) {
    return explicitToken.trim();
  }
  if (process.env.GCS_ACCESS_TOKEN) {
    return process.env.GCS_ACCESS_TOKEN.trim();
  }
  return null;
}

// Health check
app.get(['/health', '/api/health'], (req, res) => {
  res.json({ status: 'ok', service: 'pdf-generator', time: new Date().toISOString() });
});

// API: Generate PDF (Webhook & On-Demand Dispatch)
// Supports GET (test/ping) and POST (generate)
app.all(['/api/generate-pdf', '/api/generate-pdf/'], async (req, res) => {
  if (req.method === 'GET') {
    return res.json({
      status: 'ready',
      endpoint: '/api/generate-pdf',
      method: 'POST',
      message: 'PDF generation webhook is operational. Send a POST request with form_id and entry data to generate filled PDFs.',
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
  }

  try {
    const payload = req.body || {};
    const formId = String(payload.form_id || payload.formId || (payload.entry && payload.entry.form_id) || '1');
    const entryId = String(payload.entry_id || payload.entryId || (payload.entry && payload.entry.id) || '0');
    const entry = payload.entry || payload;

    // Handle test ping from WordPress Admin "⚡ Test Webhook Connection"
    if (entryId === 'test-ping' || payload.is_test || entryId === '0') {
      return res.json({
        success: true,
        test: true,
        message: 'Webhook Test Ping Successful! PDF Generator endpoint is connected and responding.',
        form_id: formId,
        entry_id: entryId,
      });
    }

    // 1. Load the saved mapping from PostgreSQL (the only source of truth)
    let mappingData = null;
    let databaseTemplateUrl = null;
    const sourceConnectionId = payload.sourceConnectionId || payload.source_connection_id || null;
    const databaseMappings = await listFormMappingRecords(formId, null, sourceConnectionId);
    if (databaseMappings?.length) {
      const record = databaseMappings[0];
      mappingData = {
        ...record.templateMetadata,
        ...record.mapping,
        formId: record.formId,
        templateId: record.templateId,
        templateFilename: record.templateFilename || record.mapping.templateFilename,
      };
      databaseTemplateUrl = record.pdfTemplateUrl;
    }

    if (!mappingData) {
      return res.status(404).json({ error: `No saved mapping found for Form #${formId}` });
    }

    // 2. Locate PDF Template file bytes
    let templateBytes = null;
    const candidates = [
      path.join(__dirname, mappingData.templateFilename || ''),
      path.join(__dirname, `${mappingData.templateId || ''}.pdf`),
      path.join(__dirname, 'NPA_Credit Transfer Forms_V2.1.pdf'),
      path.join(__dirname, 'pdf-mapper', 'public', 'templates', 'NPA', mappingData.templateFilename || ''),
      path.join(__dirname, 'pdf-mapper', 'public', 'templates', 'AIBT', mappingData.templateFilename || ''),
    ];

    if (mappingData.category) {
      candidates.push(path.join(__dirname, 'pdf-mapper', 'public', 'templates', mappingData.category, mappingData.templateFilename || ''));
      candidates.push(path.join(__dirname, 'pdf-mapper', 'public', 'templates', mappingData.category, `${mappingData.templateId}.pdf`));
    }

    const tplRoot = path.join(__dirname, 'pdf-mapper', 'public', 'templates');
    if (fs.existsSync(tplRoot)) {
      try {
        const catFolders = fs.readdirSync(tplRoot);
        for (const cat of catFolders) {
          const catDir = path.join(tplRoot, cat);
          if (fs.statSync(catDir).isDirectory()) {
            if (mappingData.templateFilename) {
              candidates.push(path.join(catDir, mappingData.templateFilename));
              candidates.push(path.join(catDir, mappingData.templateFilename.replace(/ /g, '_')));
            }
            if (mappingData.templateId) {
              candidates.push(path.join(catDir, `${mappingData.templateId}.pdf`));
            }
          }
        }
      } catch {}
    }

    for (const p of candidates) {
      if (p && fs.existsSync(p)) {
        templateBytes = fs.readFileSync(p);
        break;
      }
    }

    if (!templateBytes && databaseTemplateUrl && /^https?:\/\//i.test(databaseTemplateUrl)) {
      try {
        const templateRes = await fetch(databaseTemplateUrl);
        if (templateRes.ok) templateBytes = Buffer.from(await templateRes.arrayBuffer());
      } catch {
        databaseTemplateUrl = null;
      }
    }

    if (!templateBytes && mappingData.templateFilename) {
      try {
        const category = mappingData.category || 'NPA';
        const cdnUrl = `https://storage.googleapis.com/${GCS_BUCKET}/pdf-generator/templates/${encodeURIComponent(category)}/${encodeURIComponent(mappingData.templateFilename)}`;
        const cdnRes = await fetch(cdnUrl);
        if (cdnRes.ok) {
          templateBytes = Buffer.from(await cdnRes.arrayBuffer());
        }
      } catch (e) {
        console.warn('Could not fetch template from GCS:', e);
      }
    }

    if (!templateBytes) {
      return res.status(404).json({ error: `Template PDF file not found for ${mappingData.templateFilename || mappingData.templateId}` });
    }

    // 3. Generate filled PDF with exact normalized mapping
    const activeMappings = payload.mappings
      ? normalizeSavedMappings({ mappings: payload.mappings })
      : normalizeSavedMappings(mappingData);

    const result = await generateFilledPdf({
      templateBytes: new Uint8Array(templateBytes),
      mappings: activeMappings,
      submission: entry,
      flatten: false,
      attachUploadedFiles: true,
    });

    const pdfBuffer = Buffer.from(result.pdfBytes);
    const filename = `form-${formId}-entry-${entryId}.pdf`;

    // Cache locally in generated/
    const generatedFolder = path.join(__dirname, 'generated');
    fs.mkdirSync(generatedFolder, { recursive: true });
    fs.writeFileSync(path.join(generatedFolder, filename), pdfBuffer);

    // If destination path is on disk (payload.pdf_destination from WordPress webhook)
    if (payload.pdf_destination) {
      try {
        const destDir = path.dirname(payload.pdf_destination);
        if (fs.existsSync(destDir)) {
          fs.writeFileSync(payload.pdf_destination, pdfBuffer);
          console.log(`[Server] Saved PDF directly to destination: ${payload.pdf_destination}`);
        }
      } catch (destErr) {
        console.warn('[Server] Could not write directly to pdf_destination:', destErr.message);
      }
    }

    // If WordPress forms URL is known and entry is valid, also push to WordPress REST and trigger email
    // Use source connection from mapping record for multi-source architecture
    let wpFormsUrl = "";
    let apiKey = "";

    if (templateId) {
      const mappingRecords = await listFormMappingRecords(formId, templateId);
      if (mappingRecords?.length && mappingRecords[0].sourceConnectionId) {
        const conn = await getSourceConnection(mappingRecords[0].sourceConnectionId);
        if (conn) {
          wpFormsUrl = conn.url || "";
          const dbApiKey = await getSourceConnectionApiKey(mappingRecords[0].sourceConnectionId);
          if (dbApiKey) apiKey = dbApiKey;
        }
      }
    }
    if (wpFormsUrl && entryId && entryId !== '0') {
      try {
        const rawBase = wpFormsUrl.replace(/\/$/, "");
        const restBase = rawBase.endsWith("/forms") ? rawBase.replace(/\/forms$/, "") : (rawBase.includes("/wp-json") ? rawBase : `${rawBase}/wp-json/pdf-generator/v1`);
        const uploadUrl = `${restBase}/entries/${entryId}/pdf?send_notification=1`;
        const headers = { 'Content-Type': 'application/pdf', 'ngrok-skip-browser-warning': '1' };
        if (apiKey) headers['X-PDF-API-Key'] = apiKey;

        console.log(`[Server] Pushing PDF to WordPress REST: ${uploadUrl}`);
        const wpRes = await fetch(uploadUrl, { method: 'POST', headers, body: pdfBuffer });
        if (wpRes.ok) {
          console.log(`[Server] WordPress accepted PDF and dispatched email notifications successfully!`);
        } else {
          console.warn(`[Server] WordPress upload returned status: ${wpRes.status}`);
        }
      } catch (pushErr) {
        console.warn(`[Server] Could not push to WordPress REST endpoint:`, pushErr.message);
      }
    }

    // Check Accept header
    const accept = req.headers['accept'] || '';
    if (accept.includes('application/json')) {
      return res.json({
        success: true,
        filename,
        filledCount: result.filledCount,
        pdfBytesBase64: pdfBuffer.toString('base64'),
      });
    }

    // Default binary PDF stream (for WordPress file_put_contents)
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(pdfBuffer.length));
    res.setHeader('X-Filled-Fields', String(result.filledCount || 0));
    res.end(pdfBuffer);
  } catch (err) {
    console.error('PDF Generation API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// API: Push PDF to WordPress (server-side to avoid browser CORS)
app.post('/api/push-pdf-to-wp', async (req, res) => {
  try {
    const payload = req.body || {};
    const pdfBytesBase64 = payload.pdfBytesBase64;
    const formId = String(payload.formId || '1');
    const entryId = String(payload.entryId || '0');
    const templateId = payload.templateId || null;
    const sourceConnectionId = payload.sourceConnectionId || null;
    const sendNotification = payload.sendNotification !== false; // default true

    if (!pdfBytesBase64) {
      return res.status(400).json({ error: 'pdfBytesBase64 is required' });
    }
    if (!entryId || entryId === '0') {
      return res.status(400).json({ error: 'entryId is required' });
    }

    // Load source connection to get WordPress URL
    let wpFormsUrl = "";
    let apiKey = "";

    if (sourceConnectionId) {
      const conn = await getSourceConnection(sourceConnectionId);
      if (conn) {
        wpFormsUrl = conn.url || "";
        // Use DB-backed encrypted API key
        const dbApiKey = await getSourceConnectionApiKey(sourceConnectionId);
        if (dbApiKey) {
          apiKey = dbApiKey;
        }
      }
    } else if (templateId) {
      // Fallback: try to find sourceConnectionId from the mapping record
      const mappingRecords = await listFormMappingRecords(formId, templateId);
      if (mappingRecords?.length && mappingRecords[0].sourceConnectionId) {
        const conn = await getSourceConnection(mappingRecords[0].sourceConnectionId);
        if (conn) {
          wpFormsUrl = conn.url || wpFormsUrl;
          const dbApiKey = await getSourceConnectionApiKey(mappingRecords[0].sourceConnectionId);
          if (dbApiKey) {
            apiKey = dbApiKey;
          }
        }
      }
    }

    if (!wpFormsUrl) {
      return res.status(400).json({ error: 'No WordPress URL configured for this source connection' });
    }

    // Check if API key is available for the selected source
    if (!apiKey) {
      // If we got here without a DB-backed key, it's not configured
      if (sourceConnectionId) {
        return res.status(400).json({
          error: 'API key not configured for this source connection',
          errorType: 'api_key_not_configured',
        });
      }
    }

    const pdfBuffer = Buffer.from(pdfBytesBase64, 'base64');

    // Validate PDF header
    const header = pdfBuffer.subarray(0, 5).toString('ascii');
    if (header !== '%PDF-') {
      return res.status(400).json({
        error: 'Invalid PDF data: missing %PDF- header',
        receivedHeader: header,
      });
    }

    const rawBase = wpFormsUrl.replace(/\/$/, '');
    const restBase = rawBase.endsWith('/forms')
      ? rawBase.replace(/\/forms$/, '')
      : rawBase.includes('/wp-json')
        ? rawBase
        : `${rawBase}/wp-json/pdf-generator/v1`;
    const uploadUrl = `${restBase}/entries/${entryId}/pdf?send_notification=${sendNotification ? '1' : '0'}`;

    const headers = { 'Content-Type': 'application/pdf', 'ngrok-skip-browser-warning': '1' };
    if (apiKey) headers['X-PDF-API-Key'] = apiKey;

    console.log(`[Server] Pushing PDF to WordPress REST: ${uploadUrl}`);
    const wpRes = await fetch(uploadUrl, { method: 'POST', headers, body: pdfBuffer });

    const responseText = await wpRes.text();
    const contentType = wpRes.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');

    if (!wpRes.ok) {
      console.warn(`[Server] WordPress upload returned status: ${wpRes.status}, content-type: ${contentType}`);

      // Parse WordPress error if JSON
      let wpError = null;
      let errorCode = null;
      if (isJson) {
        try {
          wpError = JSON.parse(responseText);
          errorCode = wpError.code || null;
        } catch {}
      }

      // Map WordPress status codes to user-friendly messages
      let userMessage = 'WordPress could not process the PDF.';
      let errorType = 'unknown_error';

      if (wpRes.status === 401) {
        userMessage = 'WordPress authentication failed. Check the API key for the selected source connection.';
        errorType = 'auth_failed';
      } else if (wpRes.status === 403) {
        userMessage = 'WordPress rejected the request because the API user/API key does not have permission.';
        errorType = 'permission_denied';
      } else if (wpRes.status === 404) {
        userMessage = 'PDF Generator REST endpoint was not found on WordPress. Check that the plugin is active.';
        errorType = 'endpoint_not_found';
      } else if (wpRes.status === 400) {
        if (errorCode === 'invalid_pdf_data') {
          userMessage = 'WordPress rejected the generated PDF because the uploaded PDF data is invalid.';
          errorType = 'invalid_pdf';
        } else {
          userMessage = 'WordPress rejected the PDF because the PDF data is invalid or incomplete.';
          errorType = 'bad_request';
        }
      } else if (wpRes.status === 500 || wpRes.status === 502 || wpRes.status === 503) {
        if (errorCode === 'pdf_write_failed' || errorCode === 'directory_create_failed' || errorCode === 'directory_not_writable') {
          userMessage = 'PDF generation succeeded, but WordPress could not write the PDF to disk.';
          errorType = 'storage_failed';
        } else if (errorCode === 'gravity_forms_unavailable') {
          userMessage = 'Gravity Forms is not available on the WordPress site.';
          errorType = 'gf_unavailable';
        } else {
          userMessage = 'WordPress received the PDF but could not store it on the server.';
          errorType = 'server_error';
        }
      }

      return res.status(502).json({
        error: userMessage,
        errorType,
        wordpressStatus: wpRes.status,
        wordpressErrorCode: errorCode,
        contentType,
        responsePreview: responseText.substring(0, 500),
      });
    }

    let json;
    try {
      json = isJson ? JSON.parse(responseText) : { rawResponse: responseText };
    } catch (parseErr) {
      console.warn(`[Server] Failed to parse WordPress response as JSON: ${parseErr.message}`);
      return res.status(502).json({
        error: 'WordPress returned a non-JSON response',
        errorType: 'non_json_response',
        wordpressStatus: wpRes.status,
        contentType,
        responsePreview: responseText.substring(0, 500),
      });
    }

    // Verify WordPress explicitly confirmed PDF storage
    const pdfStored = json.pdf_stored === true;
    const notificationSent = json.notification_sent === true;
    const notificationRequested = json.notification_requested === true;
    const notificationError = json.notification_error || null;

    if (!pdfStored) {
      console.warn(`[Server] WordPress did not confirm PDF storage:`, json);
      return res.status(502).json({
        error: 'WordPress did not confirm the PDF was stored.',
        errorType: 'storage_not_confirmed',
        wordpressStatus: wpRes.status,
        wordpressResponse: json,
      });
    }

    console.log(`[Server] WordPress accepted PDF (stored: ${pdfStored}, notification: ${notificationSent})`);
    res.json({
      success: true,
      pdfStored: pdfStored,
      filename: json.filename,
      fileSize: json.file_size,
      notificationRequested,
      notificationSent,
      notificationError,
    });
  } catch (err) {
    console.error('[Server] Push PDF to WordPress error:', err);
    res.status(500).json({ error: err.message });
  }
});

// API: Save Mapping
const handleSaveMapping = async (req, res) => {
  try {
    const payload = req.body || {};
    const formId = String(payload.formId || '1');
    const templateId = String(payload.templateId || 'Template').replace(/[^a-zA-Z0-9._-]/g, '_');
    const { _templateRecord, name, sourceConnectionId, ...mappingPayload } = payload;
    const mappingName = String(name || '').trim();
    if (!mappingName) return res.status(400).json({ error: 'Mapping name is required' });

    const mappingRecord = await createFormMappingRecord({
      formId,
      templateId,
      name: mappingName,
      mapping: mappingPayload,
      templateRecord: _templateRecord || { templateId, filename: mappingPayload.templateFilename },
      sourceConnectionId: sourceConnectionId || null,
    });
    if (mappingRecord) {
      return res.json({ success: true, mapping: mappingRecord, databasePersisted: true });
    }

    return res.status(500).json({ error: 'Mapping could not be persisted to PostgreSQL.' });
  } catch (err) {
    console.error('[Server] Failed to save mapping:', err);
    res.status(500).json({ error: err.message });
  }
};

app.post('/api/save-mapping', handleSaveMapping);
app.post('/api/mappings', handleSaveMapping);

// Persist only non-secret WordPress connection metadata. The frontend retains
// API keys and Basic Auth in its existing local storage fallback.
app.get('/api/source-connections', async (req, res) => {
  const connections = await listSourceConnections();
  res.json({ connections: connections || [], databaseAvailable: connections !== null });
});

app.get('/api/source-connections/:id', async (req, res) => {
  const connection = await getSourceConnection(req.params.id);
  if (!connection) return res.status(404).json({ error: 'Source connection not found' });
  res.json(connection);
});

app.post('/api/source-connections', async (req, res) => {
  const connection = await upsertSourceConnection(req.body || {});
  if (!connection) {
    return res.status(503).json({ error: 'Source connection was not persisted; local fallback remains available.' });
  }
  res.json({ success: true, connection });
});

app.post('/api/source-connections/:id/forms', async (req, res) => {
  const saved = await upsertSourceForms(req.params.id, req.body?.forms || []);
  res.json({ success: true, databasePersisted: saved });
});

app.delete('/api/source-connections/:id', async (req, res) => {
  const archived = await archiveSourceConnection(req.params.id);
  res.json({ success: true, databasePersisted: archived });
});

app.get('/api/template-records', async (req, res) => {
  const templateId = req.query.templateId;
  if (!templateId) {
    const templates = await listPdfTemplateRecords();
    return res.json({ templates: templates || [] });
  }
  if (req.query.formId) {
    const mappingRecord = await getFormMappingRecord(req.query.formId, templateId, req.query.sourceConnectionId || null);
    if (mappingRecord) {
      return res.json({
        templateId: mappingRecord.templateId,
        filename: mappingRecord.templateFilename,
        url: mappingRecord.pdfTemplateUrl,
        analysis: mappingRecord.analysis,
        metadata: mappingRecord.templateMetadata,
      });
    }
  }
  const record = await getPdfTemplateRecord(templateId);
  if (!record) return res.status(404).json({ error: 'Template record not found' });
  res.json(record);
});

app.post('/api/template-records', async (req, res) => {
  const saved = await upsertPdfTemplateRecord(req.body || {});
  res.json({ success: true, databasePersisted: saved });
});

app.get('/api/mappings', async (req, res) => {
  try {
    const { formId, templateId, sourceConnectionId } = req.query;
    if (formId && templateId) {
      const databaseRecords = await listFormMappingRecords(formId, templateId, sourceConnectionId || null);
      if (databaseRecords?.length) {
        return res.json({
          records: databaseRecords.map((record) => ({
            id: record.id,
            name: record.name,
            formId: record.formId,
            templateId: record.templateId,
            mapping: record.mapping,
          })),
        });
      }
      return res.status(404).json({ error: 'Mapping not found' });
    }
    const databaseRecords = await listFormMappingRecords();
    res.json((databaseRecords || []).map((record) => record.mapping));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// API: Sources & Templates JSON Database Registry
// =========================================================
const REGISTRY_FILE = path.join(__dirname, 'sources-and-templates.json');

function readRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    }
  } catch (err) {
    console.warn('[Server] Failed to parse sources-and-templates.json:', err.message);
  }
  return null;
}

function writeRegistry(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), 'utf-8');
  const publicCopy = path.join(__dirname, 'pdf-mapper', 'public', 'sources-and-templates.json');
  try {
    fs.writeFileSync(publicCopy, JSON.stringify(data, null, 2), 'utf-8');
  } catch {}
  return data;
}

app.get('/api/registry', (req, res) => {
  try {
    const data = readRegistry();
    if (!data) {
      return res.status(500).json({ error: 'Registry file not found' });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/registry', (req, res) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }
    const saved = writeRegistry(payload);
    res.json({ success: true, registry: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/registry/download', (req, res) => {
  try {
    const data = readRegistry();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="sources-and-templates.json"');
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: GCS Status
app.get('/api/gcs-status', (req, res) => {
  const hasEnvToken = Boolean(process.env.GCS_ACCESS_TOKEN);

  res.json({
    bucket: GCS_BUCKET,
    projectId: GCS_PROJECT_ID,
    baseFolder: GCS_BASE_PATH,
    allowedCategories: ALLOWED_CATEGORIES,
    hasEnvCredentials: hasEnvToken,
    credentialsType: hasEnvToken ? 'access_token' : 'none',
    consoleUrl: `https://console.cloud.google.com/storage/browser/${GCS_BUCKET}/${GCS_BASE_PATH}?project=${GCS_PROJECT_ID}`,
  });
});

// API: GCS Upload
app.post('/api/gcs-upload', async (req, res) => {
  try {
    const payload = req.body || {};
    const filename = String(payload.filename || 'template.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    let category = String(payload.category || 'AIBT').trim();
    if (!ALLOWED_CATEGORIES.includes(category)) category = 'Others';

    const fileBuffer = Buffer.from(payload.fileBytesBase64, 'base64');
    if (fileBuffer.length === 0) {
      return res.status(400).json({ error: 'Empty file buffer' });
    }

    const localFolder = path.join(__dirname, 'pdf-mapper', 'public', 'templates', category);
    fs.mkdirSync(localFolder, { recursive: true });
    fs.writeFileSync(path.join(localFolder, filename), fileBuffer);
    const localUrl = `/templates/${encodeURIComponent(category)}/${encodeURIComponent(filename)}`;

    const gcsObjectPath = `${GCS_BASE_PATH}/${category}/${filename}`;
    const gcsUri = `gs://${GCS_BUCKET}/${gcsObjectPath}`;
    const publicCdnUrl = `https://${GCS_BUCKET}/${gcsObjectPath}`;
    const consoleUrl = `https://console.cloud.google.com/storage/browser/${GCS_BUCKET}/${GCS_BASE_PATH}/${encodeURIComponent(category)}?project=${GCS_PROJECT_ID}`;
    const gcloudCommand = `gcloud storage cp "${filename}" "${gcsUri}"`;

    const explicitToken = req.headers['x-gcs-token'] || payload.customToken || '';
    const token = await getGoogleAccessToken(explicitToken);

    if (!token) {
      return res.json({
        success: false,
        status: 'credentials_needed',
        message: `Google Cloud credentials needed to write directly to Google Cloud Storage bucket ${GCS_BUCKET}`,
        targetGcsPath: gcsObjectPath,
        gcsUri,
        publicCdnUrl,
        consoleUrl,
        localUrl,
        gcloudCommand,
        bucket: GCS_BUCKET,
        projectId: GCS_PROJECT_ID,
        category,
        filename,
      });
    }

    const gcsUploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(GCS_BUCKET)}/o?uploadType=media&name=${encodeURIComponent(gcsObjectPath)}`;
    const gcsRes = await fetch(gcsUploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/pdf',
      },
      body: fileBuffer,
    });

    if (gcsRes.ok) {
      const uploadResult = await gcsRes.json();
      return res.json({
        success: true,
        status: 'uploaded',
        message: `Template successfully uploaded to Google Cloud Storage under child folder ${category}`,
        gcsData: uploadResult,
        targetGcsPath: gcsObjectPath,
        gcsUri,
        publicCdnUrl,
        consoleUrl,
        localUrl,
        category,
        filename,
      });
    } else {
      const errText = await gcsRes.text();
      return res.json({
        success: false,
        status: 'upload_failed',
        message: `Google Cloud Storage upload returned HTTP ${gcsRes.status}: ${errText}`,
        targetGcsPath: gcsObjectPath,
        gcsUri,
        publicCdnUrl,
        consoleUrl,
        localUrl,
        gcloudCommand,
        category,
        filename,
      });
    }
  } catch (err) {
    console.error('GCS upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// API: Analyze Template
app.post('/api/analyze-template', async (req, res) => {
  try {
    const payload = req.body || {};
    const filename = payload.filename || 'template.pdf';
    const buffer = Buffer.from(payload.fileBytesBase64, 'base64');
    const result = await analyzePdfBytes(new Uint8Array(buffer), filename);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: WordPress Proxy
app.all('/api/wp-proxy', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    const apiKey = req.query.apiKey || '';
    const basicUser = req.query.basicUser || '';
    const basicPass = req.query.basicPass || '';

    if (!targetUrl) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    const headers = {
      Accept: '*/*',
      'ngrok-skip-browser-warning': 'true',
      'User-Agent': 'PDFMapper/1.0',
    };
    if (apiKey) headers['X-PDF-API-Key'] = apiKey;
    if (basicUser || basicPass) {
      headers['Authorization'] = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`;
    }

    let body = undefined;
    if (req.method === 'POST' || req.method === 'PUT') {
      if (req.body && Buffer.isBuffer(req.body)) {
        body = req.body;
      } else if (typeof req.body === 'object' && Object.keys(req.body).length > 0) {
        body = JSON.stringify(req.body);
        headers['Content-Type'] = 'application/json';
      } else if (typeof req.body === 'string') {
        body = req.body;
      }
      if (req.headers['content-type']) {
        headers['Content-Type'] = req.headers['content-type'];
      }
    }

    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
    });
    const contentType = upstreamRes.headers.get('content-type') || 'application/octet-stream';
    const arrayBuffer = await upstreamRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.status(upstreamRes.status);
    res.setHeader('Content-Type', contentType);
    res.end(buffer);
  } catch (err) {
    res.status(502).json({ error: `Proxy failed: ${err.message}` });
  }
});

// Serve frontend static build files
const distPath = path.join(__dirname, 'pdf-mapper', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  // Wildcard SPA fallback for GET requests
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      return res.sendFile(path.join(distPath, 'index.html'));
    }
    next();
  });
}

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint Not Found' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[PDF Generator Server] Running on http://0.0.0.0:${PORT}`);
  console.log(`[PDF Generator Server] Webhook Endpoint: http://0.0.0.0:${PORT}/api/generate-pdf`);
});
