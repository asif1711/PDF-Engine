import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { generateFilledPdf } from './pdf-mapper/src/pdfGenerator.js';
import { normalizeSavedMappings } from './pdf-mapper/src/mappingUtils.js';
import { analyzePdfBytes } from './analyze-template.js';

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
async function getGoogleAccessToken(explicitTokenOrKey) {
  if (explicitTokenOrKey && !explicitTokenOrKey.trim().startsWith('{')) {
    return explicitTokenOrKey.trim();
  }
  if (process.env.GCS_ACCESS_TOKEN) {
    return process.env.GCS_ACCESS_TOKEN.trim();
  }

  let saJsonStr = null;
  if (explicitTokenOrKey && explicitTokenOrKey.trim().startsWith('{')) {
    saJsonStr = explicitTokenOrKey.trim();
  } else if (process.env.GCS_SERVICE_ACCOUNT_JSON) {
    saJsonStr = process.env.GCS_SERVICE_ACCOUNT_JSON;
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      if (fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
        saJsonStr = fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf-8');
      } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS.trim().startsWith('{')) {
        saJsonStr = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      }
    } catch {
      // Continue if read fails
    }
  }

  if (!saJsonStr) return null;

  try {
    const sa = JSON.parse(saJsonStr);
    if (!sa.client_email || !sa.private_key) return null;

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/devstorage.read_write',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    })).toString('base64url');

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    const signature = signer.sign(sa.private_key, 'base64url');
    const jwt = `${header}.${payload}.${signature}`;

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token || null;
  } catch (err) {
    console.warn('Service Account token minting error:', err);
    return null;
  }
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

    // 1. Locate saved mapping file
    const mappingsDir = path.join(__dirname, 'mappings');
    let mappingData = null;

    const formDir = path.join(mappingsDir, `form-${formId}`);
    if (fs.existsSync(formDir)) {
      const files = fs.readdirSync(formDir).filter(f => f.endsWith('.json'));
      if (files.length > 0) {
        mappingData = JSON.parse(fs.readFileSync(path.join(formDir, files[0]), 'utf-8'));
      }
    }

    if (!mappingData && fs.existsSync(mappingsDir)) {
      const allItems = fs.readdirSync(mappingsDir, { recursive: true });
      for (const item of allItems) {
        if (typeof item === 'string' && item.endsWith('.json')) {
          try {
            const parsed = JSON.parse(fs.readFileSync(path.join(mappingsDir, item), 'utf-8'));
            if (String(parsed.formId) === formId) {
              mappingData = parsed;
              break;
            }
          } catch {}
        }
      }
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
    const wpFormsUrl = payload.wordpress_url || payload.forms_url || process.env.WORDPRESS_FORMS_URL || "";
    const apiKey = payload.wordpress_api_key || payload.api_key || req.headers['x-pdf-api-key'] || process.env.WORDPRESS_API_KEY || "";
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

// API: Save Mapping
const handleSaveMapping = (req, res) => {
  try {
    const payload = req.body || {};
    const formId = String(payload.formId || '1');
    const templateId = String(payload.templateId || 'Template').replace(/[^a-zA-Z0-9._-]/g, '_');
    const formDir = path.join(__dirname, 'mappings', `form-${formId}`);
    fs.mkdirSync(formDir, { recursive: true });
    const targetFile = path.join(formDir, `${templateId}.json`);
    fs.writeFileSync(targetFile, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`[Server] Saved mapping configuration for Form #${formId} to ${targetFile}`);
    res.json({ success: true, path: `mappings/form-${formId}/${templateId}.json` });
  } catch (err) {
    console.error('[Server] Failed to save mapping:', err);
    res.status(500).json({ error: err.message });
  }
};

app.post('/api/save-mapping', handleSaveMapping);
app.post('/api/mappings', handleSaveMapping);

app.get('/api/mappings', (req, res) => {
  try {
    const { formId, templateId } = req.query;
    const mappingsDir = path.join(__dirname, 'mappings');
    if (formId && templateId) {
      const filePath = path.join(mappingsDir, `form-${formId}`, `${templateId}.json`);
      if (fs.existsSync(filePath)) {
        return res.json(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
      }
      if (fs.existsSync(mappingsDir)) {
        const folders = fs.readdirSync(mappingsDir);
        for (const folder of folders) {
          const fullDir = path.join(mappingsDir, folder);
          if (fs.statSync(fullDir).isDirectory()) {
            const candidate = path.join(fullDir, `${templateId}.json`);
            if (fs.existsSync(candidate)) {
              try {
                const data = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
                if (String(data.formId) === String(formId)) {
                  return res.json(data);
                }
              } catch {}
            }
          }
        }
      }
      return res.status(404).json({ error: 'Mapping not found' });
    }
    const results = [];
    if (fs.existsSync(mappingsDir)) {
      const folders = fs.readdirSync(mappingsDir);
      for (const f of folders) {
        const fullDir = path.join(mappingsDir, f);
        if (fs.statSync(fullDir).isDirectory()) {
          const files = fs.readdirSync(fullDir).filter((file) => file.endsWith('.json'));
          for (const file of files) {
            try {
              results.push(JSON.parse(fs.readFileSync(path.join(fullDir, file), 'utf-8')));
            } catch {}
          }
        }
      }
    }
    res.json(results);
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
  const hasEnvSa = Boolean(process.env.GCS_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS);

  res.json({
    bucket: GCS_BUCKET,
    projectId: GCS_PROJECT_ID,
    baseFolder: GCS_BASE_PATH,
    allowedCategories: ALLOWED_CATEGORIES,
    hasEnvCredentials: hasEnvToken || hasEnvSa,
    credentialsType: hasEnvToken ? 'access_token' : (hasEnvSa ? 'service_account' : 'none'),
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
