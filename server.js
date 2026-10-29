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
  upsertPdfTemplateRecord,
  deletePdfTemplateRecord,
  addWpDispatchLog,
  listWpDispatchLogs,
  updateWpDispatchLog,
  clearWpDispatchLogs,
  getWpAutomationSettings,
  saveWpAutomationSettings,
  getGcpSettingsRecord,
  saveGcpSettingsRecord,
  getAdminByEmail,
  getAdminById,
  getRuntimePool,
} from './database.js';

import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import bcrypt from 'bcryptjs';
import {
  requireAuth,
  requireAdmin,
  validateWebhookAuth,
  validateCsrf,
  loginRateLimiter,
} from './server/authMiddleware.js';

import {
  getGoogleAccessToken,
  getGcsConfig,
  uploadBufferToGcs,
  listGcsFolderObjects,
  deleteGcsObject,
  setInMemoryServiceAccountKey,
  setGcsBucket,
  setGcsProjectId,
} from './server/gcpAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

const GCS_BUCKET = (process.env.GCS_BUCKET_NAME && process.env.GCS_BUCKET_NAME !== 'cdn.vconsultancy.com.au') ? process.env.GCS_BUCKET_NAME : 'vc-pdf-generator-storage';
const GCS_PROJECT_ID = process.env.GCS_PROJECT_ID || 'aibt-244204';
const GCS_BASE_PATH = 'templates';
const GCS_GENERATED_PATH = 'generated';
const ALLOWED_CATEGORIES = ['AIBT', 'AIBT-I', 'AVTA', 'NPA', 'BIC', 'REACH', 'HJ', 'Pivot', 'Profound', 'Others'];

// Hydrate GCP settings from PostgreSQL / Disk on server initialization
async function initGcpFromDb() {
  try {
    const record = await getGcpSettingsRecord();
    if (record) {
      if (record.bucket) setGcsBucket(record.bucket);
      if (record.projectId) setGcsProjectId(record.projectId);
      if (record.serviceAccountKey) setInMemoryServiceAccountKey(record.serviceAccountKey);
      console.log(`[Server] Hydrated GCP settings from database (Bucket: ${record.bucket || GCS_BUCKET}, Project: ${record.projectId || GCS_PROJECT_ID}, SA configured: ${Boolean(record.serviceAccountKey)})`);
    }
  } catch (err) {
    console.warn('[Server] Could not hydrate GCP settings from DB:', err.message);
  }
}
initGcpFromDb();


// Trust proxy for Render deployment topology (HTTPS termination and secure cookies)
app.set('trust proxy', 1);

// CORS and Preflight configuration (supports credentials)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-PDF-API-Key, X-Webhook-Secret, ngrok-skip-browser-warning, x-gcs-token, x-gcs-sa-key');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// JSON and URL-encoded body parser
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// PostgreSQL-backed Session Store
const PgSession = connectPgSimple(session);
let sessionStore = undefined;
try {
  const pgPool = getRuntimePool();
  if (pgPool) {
    sessionStore = new PgSession({
      pool: pgPool,
      tableName: 'session',
      createTableIfMissing: false,
    });
  }
} catch (err) {
  console.warn('[Server] Could not initialize PostgreSQL session store:', err.message);
}

const isHttpsEnvironment = Boolean(
  process.env.NODE_ENV === 'production' ||
  process.env.K_SERVICE ||
  process.env.APP_URL?.startsWith('https') ||
  process.env.RENDER
);
const sessionSecret = process.env.SESSION_SECRET || 'pdf-generator-secure-admin-session-secret-default-key-change-in-prod';

app.use(session({
  store: sessionStore,
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  name: 'pdf_admin_sid',
  proxy: true,
  cookie: {
    httpOnly: true,
    secure: 'auto',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

// Ensure session cookie on incoming HTTPS requests uses SameSite=None and Secure
// so cookies persist across cross-origin iframe embedding in the AI Studio environment,
// while allowing standard sameSite: 'lax' on plain HTTP dev connections.
app.use((req, res, next) => {
  if (req.session && req.session.cookie) {
    const isReqHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    if (isReqHttps) {
      req.session.cookie.secure = true;
      req.session.cookie.sameSite = 'none';
    } else {
      req.session.cookie.secure = false;
      req.session.cookie.sameSite = 'lax';
    }
  }
  next();
});

// CSRF Protection for state-changing requests
app.use(validateCsrf);

// -------------------------------------------------------------
// Public Monitoring & Authentication Endpoints
// -------------------------------------------------------------

// Health check (public for Render deployment monitoring)
app.get(['/health', '/api/health'], (req, res) => {
  res.json({ status: 'ok', service: 'pdf-generator', time: new Date().toISOString() });
});

// Administrator Login
app.post('/api/auth/login', loginRateLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const admin = await getAdminByEmail(cleanEmail);
    if (!admin) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (!admin.isActive) {
      return res.status(403).json({ error: 'Account has been deactivated. Please contact an administrator.' });
    }

    const isMatch = await bcrypt.compare(password, admin.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Regenerate session ID to prevent session fixation attacks
    req.session.regenerate((err) => {
      if (err) {
        console.error('[Auth] Session regeneration failed:', err);
        return res.status(500).json({ error: 'Failed to create authenticated session.' });
      }

      const isReqHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
      if (isReqHttps) {
        req.session.cookie.secure = true;
        req.session.cookie.sameSite = 'none';
      } else {
        req.session.cookie.secure = false;
        req.session.cookie.sameSite = 'lax';
      }

      req.session.userId = admin.id;
      req.session.userEmail = admin.email;
      req.session.userRole = admin.role || 'admin';

      return res.json({
        success: true,
        user: {
          id: admin.id,
          email: admin.email,
          role: admin.role,
        },
      });
    });
  } catch (err) {
    console.error('[Auth] Login error:', err);
    return res.status(500).json({ error: 'An unexpected error occurred during login.' });
  }
});

// Check Current Session Status
app.get('/api/auth/me', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated.', authenticated: false });
  }
  return res.json({
    authenticated: true,
    user: {
      id: req.session.userId,
      email: req.session.userEmail,
      role: req.session.userRole || 'admin',
    },
  });
});

// Logout and Destroy Session
app.post('/api/auth/logout', (req, res) => {
  if (!req.session) {
    res.clearCookie('pdf_admin_sid');
    return res.json({ success: true, message: 'Logged out successfully.' });
  }

  req.session.destroy((err) => {
    if (err) {
      console.warn('[Auth] Session destruction warning:', err);
    }
    res.clearCookie('pdf_admin_sid');
    return res.json({ success: true, message: 'Logged out successfully.' });
  });
});

// -------------------------------------------------------------
// Global API Guard: Protect all /api/* routes except public endpoints
// Note: /api/generate-pdf uses dedicated validateWebhookAuth
// -------------------------------------------------------------
app.use('/api', (req, res, next) => {
  const publicApiPaths = [
    '/health',
    '/api/health',
    '/auth/login',
    '/api/auth/login',
    '/auth/logout',
    '/api/auth/logout',
    '/auth/me',
    '/api/auth/me',
  ];
  if (publicApiPaths.includes(req.path) || req.path === '/generate-pdf' || req.path === '/generate-pdf/') {
    return next();
  }
  return requireAuth(req, res, next);
});

// API: Generate PDF (WordPress Webhook & Test Ping)
// Protected by validateWebhookAuth (supports X-PDF-API-Key, WEBHOOK_SECRET, and admin session)
app.all(['/api/generate-pdf', '/api/generate-pdf/'], validateWebhookAuth, async (req, res) => {
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

    // Store in Cloud (Google Cloud Storage) replacing legacy WordPress push & email
    const explicitToken = req.headers['x-gcs-token'] || payload.customToken || '';
    const serviceAccountKey = req.headers['x-gcs-sa-key'] || payload.serviceAccountKey || null;
    if (payload.bucket) setGcsBucket(payload.bucket);
    if (payload.projectId) setGcsProjectId(payload.projectId);
    if (serviceAccountKey) setInMemoryServiceAccountKey(serviceAccountKey);

    const gcsConfig = getGcsConfig(payload.bucket, payload.projectId);
    const gcsObjectPath = `${gcsConfig.generatedPath}/${filename}`;
    const gcsUri = `gs://${gcsConfig.bucket}/${gcsObjectPath}`;
    const publicUrl = `https://storage.googleapis.com/${gcsConfig.bucket}/${gcsObjectPath}`;
    const consoleUrl = `https://console.cloud.google.com/storage/browser/${gcsConfig.bucket}/${gcsConfig.generatedPath}?project=${gcsConfig.projectId}`;

    let cloudStored = false;
    let cloudMessage = `Saved locally in generated/ folder`;
    let gcsData = null;

    try {
      const token = await getGoogleAccessToken(explicitToken, serviceAccountKey);
      if (token) {
        const uploadResult = await uploadBufferToGcs({
          bucket: gcsConfig.bucket,
          objectPath: gcsObjectPath,
          buffer: pdfBuffer,
          contentType: 'application/pdf',
          token,
        });
        if (uploadResult.ok) {
          cloudStored = true;
          cloudMessage = `Stored in Google Cloud Storage at ${gcsUri}`;
          gcsData = uploadResult.data;
          console.log(`[Server] Automatically stored generated PDF in Cloud: ${gcsUri}`);
        } else {
          console.warn(`[Server] Cloud upload returned HTTP ${uploadResult.status}:`, uploadResult.errorText);
          cloudMessage = `Cloud upload returned HTTP ${uploadResult.status}: ${uploadResult.errorText}`;
        }
      } else {
        console.log(`[Server] PDF cached locally at ${filename}. No active GCP credentials for bucket ${gcsConfig.bucket}.`);
      }
    } catch (cloudErr) {
      console.warn(`[Server] Cloud storage error:`, cloudErr.message);
      cloudMessage = `Cloud storage error: ${cloudErr.message}`;
    }

    // Check Accept header
    const accept = req.headers['accept'] || '';
    if (accept.includes('application/json')) {
      return res.json({
        success: true,
        filename,
        filledCount: result.filledCount,
        pdfBytesBase64: pdfBuffer.toString('base64'),
        cloudStored,
        gcsUri,
        publicUrl,
        consoleUrl,
        targetGcsPath: gcsObjectPath,
        bucket: gcsConfig.bucket,
        projectId: gcsConfig.projectId,
        message: cloudMessage,
        gcsData,
      });
    }

    // Default binary PDF stream (for WordPress file_put_contents)
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(pdfBuffer.length));
    res.setHeader('X-Filled-Fields', String(result.filledCount || 0));
    res.setHeader('X-Cloud-Stored', cloudStored ? '1' : '0');
    res.setHeader('X-GCS-URI', gcsUri);
    res.end(pdfBuffer);
  } catch (err) {
    console.error('PDF Generation API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// API: Store Generated PDF in Cloud (Google Cloud Storage)
// =========================================================
async function processStorePdfInCloud(payload = {}, reqHeaders = {}) {
  const pdfBytesBase64 = payload.pdfBytesBase64;
  const formId = String(payload.formId || '1');
  const entryId = String(payload.entryId || '0');
  const templateId = String(payload.templateId || 'Template').replace(/[^a-zA-Z0-9._-]/g, '_');
  const explicitToken = reqHeaders['x-gcs-token'] || payload.customToken || payload.accessToken || '';
  const serviceAccountKey = reqHeaders['x-gcs-sa-key'] || payload.serviceAccountKey || null;
  const customFilename = payload.filename ? String(payload.filename).replace(/[^a-zA-Z0-9._-]/g, '_') : null;

  if (payload.bucket) setGcsBucket(payload.bucket);
  if (payload.projectId) setGcsProjectId(payload.projectId);
  if (serviceAccountKey) setInMemoryServiceAccountKey(serviceAccountKey);

  if (!pdfBytesBase64) {
    throw new Error('pdfBytesBase64 is required');
  }

  const pdfBuffer = Buffer.from(pdfBytesBase64, 'base64');
  const header = pdfBuffer.subarray(0, 5).toString('ascii');
  if (header !== '%PDF-') {
    throw new Error('Invalid PDF data: missing %PDF- header');
  }

  const filename = customFilename || `Filled_${templateId}_Entry_${entryId}.pdf`;

  // 1. Always save a local copy in generated/
  const generatedFolder = path.join(__dirname, 'generated');
  fs.mkdirSync(generatedFolder, { recursive: true });
  fs.writeFileSync(path.join(generatedFolder, filename), pdfBuffer);

  // Also mirror to public/generated if public exists
  const publicGenFolder = path.join(__dirname, 'pdf-mapper', 'public', 'generated');
  try {
    fs.mkdirSync(publicGenFolder, { recursive: true });
    fs.writeFileSync(path.join(publicGenFolder, filename), pdfBuffer);
  } catch {}

  const gcsConfig = getGcsConfig(payload.bucket, payload.projectId);
  const gcsObjectPath = `${gcsConfig.generatedPath}/${filename}`;
  const gcsUri = `gs://${gcsConfig.bucket}/${gcsObjectPath}`;
  const publicUrl = `https://storage.googleapis.com/${gcsConfig.bucket}/${gcsObjectPath}`;
  const consoleUrl = `https://console.cloud.google.com/storage/browser/${gcsConfig.bucket}/${gcsConfig.generatedPath}?project=${gcsConfig.projectId}`;
  const localUrl = `/generated/${encodeURIComponent(filename)}`;
  const gcloudCommand = `gcloud storage cp "${filename}" "${gcsUri}"`;

  // 2. Check for GCP credentials (Service Account JSON or Access Token)
  const token = await getGoogleAccessToken(explicitToken, serviceAccountKey);

  if (!token) {
    return {
      success: true,
      status: 'credentials_needed',
      cloudStored: false,
      pdfStored: true,
      filename,
      fileSize: pdfBuffer.length,
      targetGcsPath: gcsObjectPath,
      gcsUri,
      publicUrl,
      consoleUrl,
      localUrl,
      gcloudCommand,
      bucket: gcsConfig.bucket,
      projectId: gcsConfig.projectId,
      message: `PDF generated and cached locally (${filename}). To store directly in Google Cloud Storage, configure your Service Account credentials in the Google Cloud Credentials modal.`,
    };
  }

  // 3. Upload to Google Cloud Storage
  const uploadResult = await uploadBufferToGcs({
    bucket: gcsConfig.bucket,
    objectPath: gcsObjectPath,
    buffer: pdfBuffer,
    contentType: 'application/pdf',
    token,
  });

  if (uploadResult.ok) {
    console.log(`[Server] Stored PDF in Google Cloud Storage: ${gcsUri}`);
    return {
      success: true,
      status: 'uploaded',
      cloudStored: true,
      pdfStored: true,
      filename,
      fileSize: pdfBuffer.length,
      targetGcsPath: gcsObjectPath,
      gcsUri,
      publicUrl,
      consoleUrl,
      localUrl,
      gcsData: uploadResult.data,
      bucket: gcsConfig.bucket,
      projectId: gcsConfig.projectId,
      message: `PDF successfully stored in Google Cloud Storage at ${gcsUri}`,
    };
  } else {
    console.warn(`[Server] GCS upload returned HTTP ${uploadResult.status}:`, uploadResult.errorText);
    return {
      success: true,
      status: 'upload_failed',
      cloudStored: false,
      pdfStored: true,
      filename,
      fileSize: pdfBuffer.length,
      targetGcsPath: gcsObjectPath,
      gcsUri,
      publicUrl,
      consoleUrl,
      localUrl,
      gcloudCommand,
      bucket: gcsConfig.bucket,
      projectId: gcsConfig.projectId,
      error: `Google Cloud Storage upload returned HTTP ${uploadResult.status}`,
      message: `PDF generated and saved locally. Cloud upload failed (${uploadResult.status}): ${uploadResult.errorText}`,
    };
  }
}

app.post('/api/store-pdf-in-cloud', async (req, res) => {
  try {
    const result = await processStorePdfInCloud(req.body || {}, req.headers);
    res.json(result);
  } catch (err) {
    console.error('[Server] Store PDF in Cloud error:', err);
    res.status(400).json({ error: err.message });
  }
});

// Helper to resolve PDF buffer from payload (base64, local /generated, or remote GCS URL)
async function resolvePdfBufferFromPayload(payload, reqHeaders = {}) {
  if (payload.pdfBytesBase64) {
    return Buffer.from(payload.pdfBytesBase64, 'base64');
  }

  const pdfUrl = payload.pdfUrl || payload.gcpPdfUrl || payload.url;
  if (!pdfUrl) {
    throw new Error('No PDF content provided. Specify pdfBytesBase64 or pdfUrl.');
  }

  // If local generated path
  if (pdfUrl.startsWith('/generated/')) {
    const filename = decodeURIComponent(pdfUrl.replace('/generated/', ''));
    const localPath = path.join(__dirname, 'generated', filename);
    if (fs.existsSync(localPath)) {
      return fs.readFileSync(localPath);
    }
  }

  // If GCS or remote URL
  if (pdfUrl.startsWith('http://') || pdfUrl.startsWith('https://')) {
    const cleanUrl = pdfUrl.replace(/([^:]\/)\/+/g, '$1');
    const headers = {};
    if (cleanUrl.includes('storage.googleapis.com') || cleanUrl.includes('vconsultancy.com.au')) {
      const explicitToken = reqHeaders['x-gcs-token'] || payload.customToken;
      const saKey = reqHeaders['x-gcs-sa-key'] || payload.serviceAccountKey;
      const token = await getGoogleAccessToken(explicitToken, saKey);
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }
    let resp = await fetch(cleanUrl, { headers });
    if (!resp.ok && (resp.status === 403 || resp.status === 404) && !cleanUrl.toLowerCase().endsWith('.pdf')) {
      try {
        const retry = await fetch(`${cleanUrl}.pdf`, { headers });
        if (retry.ok) resp = retry;
      } catch {}
    }

    if (resp.ok) {
      const arrayBuf = await resp.arrayBuffer();
      return Buffer.from(arrayBuf);
    }

    // Check if filename exists locally in generated/
    const parsedName = path.basename(decodeURIComponent(new URL(cleanUrl).pathname));
    const localCandidates = [
      path.join(__dirname, 'generated', parsedName),
      path.join(__dirname, 'generated', `${parsedName}.pdf`),
      path.join(__dirname, 'generated', `form-${payload.formId || '1'}-entry-${payload.entryId || '0'}.pdf`),
    ];
    for (const cand of localCandidates) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        return fs.readFileSync(cand);
      }
    }

    throw new Error(`Failed to fetch PDF from ${cleanUrl} (HTTP ${resp.status})`);
  }

  throw new Error(`Unable to resolve PDF buffer from URL: ${pdfUrl}`);
}

// 4th Step: Push generated PDF from GCP to WordPress storage (temporary store until notification email sent)
app.post('/api/push-pdf-to-wp', async (req, res) => {
  try {
    const payload = req.body || {};
    const formId = String(payload.formId || '1');
    const entryId = String(payload.entryId || '').trim();
    if (!entryId) {
      return res.status(400).json({ error: 'entryId is required' });
    }

    let wordpressUrl = String(payload.wordpressUrl || '').trim();
    let apiKey = String(payload.apiKey || '').trim();
    const sourceConnectionId = payload.sourceConnectionId;

    if (sourceConnectionId && (!wordpressUrl || !apiKey)) {
      try {
        const conn = await getSourceConnection(sourceConnectionId);
        if (conn && conn.url && !wordpressUrl) {
          wordpressUrl = conn.url;
        }
        if (!apiKey) {
          apiKey = (await getSourceConnectionApiKey(sourceConnectionId)) || '';
        }
      } catch (e) {
        console.warn('[Server] Could not lookup source connection for WP push:', e.message);
      }
    }

    if (!wordpressUrl) {
      return res.status(400).json({ error: 'Target WordPress URL is required.' });
    }

    const cleanWpUrl = wordpressUrl.replace(/\/+$/, '');
    const sendNotification = payload.sendNotification !== false;
    const cleanAfterSend = payload.cleanAfterSend !== false;
    const deleteDelaySeconds = Number.isInteger(payload.deleteDelaySeconds) ? payload.deleteDelaySeconds : 30;

    // Resolve PDF buffer (from GCP URL, local generated, or base64)
    const pdfBuffer = await resolvePdfBufferFromPayload(payload, req.headers);
    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error('PDF content was empty.');
    }
    const pdfBytesBase64 = pdfBuffer.toString('base64');

    // Build WP endpoint
    const queryParams = new URLSearchParams();
    queryParams.set('send_notification', sendNotification ? '1' : '0');
    if (cleanAfterSend) {
      queryParams.set('clean_after_send', '1');
      queryParams.set('delete_delay_seconds', String(deleteDelaySeconds));
    }

    const primaryWpEndpoint = `${cleanWpUrl}/wp-json/pdf-generator/v1/entries/${encodeURIComponent(entryId)}/pdf?${queryParams.toString()}`;
    const fallbackWpEndpoint = `${cleanWpUrl}/?rest_route=/pdf-generator/v1/entries/${encodeURIComponent(entryId)}/pdf&${queryParams.toString()}`;

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (apiKey) {
      headers['X-PDF-API-Key'] = apiKey;
    }

    console.log(`[Server] Pushing PDF for Entry #${entryId} to WordPress: ${primaryWpEndpoint}`);

    let wpResponse = await fetch(primaryWpEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ pdfBytesBase64 }),
    });

    let wpData = await wpResponse.json().catch(() => ({}));

    // If 404 or rest_no_route, try the plain permalink fallback (?rest_route=)
    if (!wpResponse.ok && (wpResponse.status === 404 || wpData?.code === 'rest_no_route')) {
      console.log(`[Server] Primary route returned 404 / rest_no_route. Attempting Plain permalink fallback: ${fallbackWpEndpoint}`);
      const fallbackRes = await fetch(fallbackWpEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ pdfBytesBase64 }),
      });
      const fallbackData = await fallbackRes.json().catch(() => ({}));
      if (fallbackRes.ok || fallbackRes.status !== 404) {
        wpResponse = fallbackRes;
        wpData = fallbackData;
      }
    }

    if (!wpResponse.ok) {
      let errMsg = wpData.message || wpData.error || `WordPress rejected PDF push (HTTP ${wpResponse.status})`;
      if (wpResponse.status === 404 || wpData?.code === 'rest_no_route') {
        errMsg += ' — Route not found on WordPress. Please verify that the "Gravity Forms Reader" plugin v1.5.0 is installed and activated. If using Microsoft login (WPO360), ensure /wp-json/pdf-generator/v1/* is added to WPO360 path exclusions.';
      } else if (wpResponse.status === 401 || wpResponse.status === 403) {
        errMsg += ' — Authorization rejected. Check your X-PDF-API-Key in wp-config.php or exclude /wp-json/pdf-generator/v1/* in WPO360 plugin settings.';
      }

      // Log failure
      await addWpDispatchLog({
        formId,
        entryId,
        action: payload.action || 'manual',
        wordpressUrl: cleanWpUrl,
        gcpPdfUrl: payload.gcpPdfUrl || payload.pdfUrl || '',
        wpFilename: `form-${formId}-entry-${entryId}.pdf`,
        fileSize: pdfBuffer.length,
        notificationRequested: sendNotification,
        notificationSent: false,
        notificationError: errMsg,
        cleanupStatus: 'failed',
        status: 'error',
        message: errMsg,
      });
      return res.status(wpResponse.status).json({
        success: false,
        error: errMsg,
        wpData,
      });
    }

    // Success response
    const notificationSent = Boolean(wpData.notification_sent);
    const notificationError = wpData.notification_error || null;
    const cleanupStatus = cleanAfterSend ? (deleteDelaySeconds > 0 ? 'scheduled' : 'cleaned') : 'retained';

    const logEntry = await addWpDispatchLog({
      formId,
      entryId,
      action: payload.action || 'manual',
      wordpressUrl: cleanWpUrl,
      gcpPdfUrl: payload.gcpPdfUrl || payload.pdfUrl || '',
      wpFilename: wpData.filename || `form-${formId}-entry-${entryId}.pdf`,
      fileSize: wpData.file_size || pdfBuffer.length,
      notificationRequested: sendNotification,
      notificationSent,
      notificationError,
      cleanupStatus,
      status: notificationError ? 'warning' : 'success',
      message: notificationSent
        ? `PDF pushed to WordPress. Gravity Forms notification dispatched successfully!${cleanAfterSend ? ` (Temporary storage cleanup: ${deleteDelaySeconds > 0 ? `scheduled in ${deleteDelaySeconds}s` : 'completed'})` : ''}`
        : `PDF stored on WordPress.${notificationError ? ` Notification error: ${notificationError}` : ' (Notification not requested)'}`,
    });

    // Server-side cleanup timer guarantee (deletes the temporary file after delay)
    if (cleanAfterSend) {
      const waitMs = Math.max(1500, (deleteDelaySeconds || 0) * 1000);
      setTimeout(async () => {
        try {
          const deleteUrl = `${cleanWpUrl}/wp-json/pdf-generator/v1/entries/${encodeURIComponent(entryId)}/pdf`;
          let delRes = await fetch(deleteUrl, {
            method: 'DELETE',
            headers: apiKey ? { 'X-PDF-API-Key': apiKey } : {},
          });
          if (!delRes.ok && delRes.status === 404) {
            const fallbackDeleteUrl = `${cleanWpUrl}/?rest_route=/pdf-generator/v1/entries/${encodeURIComponent(entryId)}/pdf`;
            delRes = await fetch(fallbackDeleteUrl, {
              method: 'DELETE',
              headers: apiKey ? { 'X-PDF-API-Key': apiKey } : {},
            });
          }
          const delData = await delRes.json().catch(() => ({}));
          console.log(`[Server] Automated cleanup for Entry #${entryId} on WP:`, delData?.message || delRes.status);
          await updateWpDispatchLog(logEntry.id, {
            cleanupStatus: 'cleaned',
            cleanupTime: new Date().toISOString(),
          });
        } catch (delErr) {
          console.warn(`[Server] Automated cleanup check for Entry #${entryId} notice:`, delErr.message);
        }
      }, waitMs);
    }

    return res.json({
      success: true,
      pdfStored: true,
      entryId,
      formId,
      filename: wpData.filename || `form-${formId}-entry-${entryId}.pdf`,
      fileSize: wpData.file_size || pdfBuffer.length,
      notificationRequested: sendNotification,
      notificationSent,
      notificationError,
      cleanupStatus,
      deleteDelaySeconds,
      wpData,
      logId: logEntry.id,
      message: logEntry.message,
    });
  } catch (err) {
    console.error('[Server] Push PDF to WP failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Manual cleanup of temporary generated PDF from WordPress site storage
app.delete('/api/cleanup-wp-pdf', async (req, res) => {
  try {
    const { entryId, wordpressUrl, apiKey, sourceConnectionId } = req.body || req.query || {};
    if (!entryId) {
      return res.status(400).json({ error: 'entryId is required' });
    }

    let targetWpUrl = wordpressUrl;
    let targetApiKey = apiKey;
    if (sourceConnectionId && (!targetWpUrl || !targetApiKey)) {
      try {
        const conn = await getSourceConnection(sourceConnectionId);
        if (conn?.url && !targetWpUrl) targetWpUrl = conn.url;
        if (!targetApiKey) targetApiKey = (await getSourceConnectionApiKey(sourceConnectionId)) || '';
      } catch {}
    }

    if (!targetWpUrl) {
      return res.status(400).json({ error: 'wordpressUrl is required' });
    }

    const cleanWpUrl = targetWpUrl.replace(/\/+$/, '');
    const deleteUrl = `${cleanWpUrl}/wp-json/pdf-generator/v1/entries/${encodeURIComponent(entryId)}/pdf`;
    let delRes = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: targetApiKey ? { 'X-PDF-API-Key': targetApiKey } : {},
    });
    if (!delRes.ok && delRes.status === 404) {
      const fallbackDeleteUrl = `${cleanWpUrl}/?rest_route=/pdf-generator/v1/entries/${encodeURIComponent(entryId)}/pdf`;
      delRes = await fetch(fallbackDeleteUrl, {
        method: 'DELETE',
        headers: targetApiKey ? { 'X-PDF-API-Key': targetApiKey } : {},
      });
    }

    const delData = await delRes.json().catch(() => ({}));
    return res.json({
      success: delRes.ok,
      status: delRes.status,
      deleted: Boolean(delData.deleted),
      message: delData.message || (delRes.ok ? 'Temporary PDF cleaned from WordPress storage.' : `Delete request returned HTTP ${delRes.status}`),
      details: delData,
    });
  } catch (err) {
    console.error('[Server] Cleanup WP PDF error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Mail & Operation Logs Endpoints
app.get('/api/wp-dispatch-logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const logs = await listWpDispatchLogs(limit);
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/wp-dispatch-logs', async (req, res) => {
  try {
    await clearWpDispatchLogs();
    res.json({ success: true, message: 'Logs cleared successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Automated Send Daemon Settings
app.get('/api/wp-automation/settings', (req, res) => {
  res.json({ success: true, settings: getWpAutomationSettings() });
});

app.post('/api/wp-automation/settings', (req, res) => {
  const updated = saveWpAutomationSettings(req.body || {});
  res.json({ success: true, settings: updated });
});

// Download plugin zip
app.get('/api/download-plugin', (req, res) => {
  const zipPath = path.join(__dirname, 'gravity-forms-reader.zip');
  if (fs.existsSync(zipPath)) {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="gravity-forms-reader.zip"');
    return fs.createReadStream(zipPath).pipe(res);
  }
  res.status(404).json({ error: 'Plugin archive not found' });
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
  try {
    const payload = req.body || {};
    const templateId = String(payload.templateId || payload.id || '').trim();
    if (!templateId) {
      return res.status(400).json({ error: 'Missing templateId in request body' });
    }
    const saved = await upsertPdfTemplateRecord(payload);
    res.json({ success: true, databasePersisted: saved, templateId });
  } catch (err) {
    console.error('[Server] Failed to save template record:', err);
    res.status(500).json({ error: err.message || 'Failed to persist template record' });
  }
});

app.delete('/api/template-records/:id', async (req, res) => {
  try {
    const deleted = await deletePdfTemplateRecord(req.params.id);
    res.json({ success: true, databasePersisted: deleted });
  } catch (err) {
    console.error('[Server] Failed to delete template record:', err);
    res.status(500).json({ error: err.message || 'Failed to delete template record' });
  }
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
  const config = getGcsConfig();
  res.json({
    ...config,
    baseFolder: GCS_BASE_PATH,
    allowedCategories: ALLOWED_CATEGORIES,
  });
});

// API: GCP Settings Persistence (Get from Database)
app.get('/api/gcp-settings', async (req, res) => {
  try {
    const record = await getGcpSettingsRecord();
    const config = getGcsConfig();
    let clientEmail = '';
    if (record?.serviceAccountKey) {
      try {
        const parsed = typeof record.serviceAccountKey === 'string' ? JSON.parse(record.serviceAccountKey) : record.serviceAccountKey;
        clientEmail = parsed.client_email || '';
      } catch {}
    }
    res.json({
      success: true,
      bucket: record?.bucket || config.bucket,
      projectId: record?.projectId || config.projectId,
      basePath: record?.basePath || config.basePath,
      generatedPath: record?.generatedPath || config.generatedPath,
      hasServiceAccount: Boolean(record?.serviceAccountKey),
      clientEmail,
      hasAccessToken: Boolean(record?.accessToken),
      credentialsType: config.credentialsType,
      updatedAt: record?.updatedAt,
      databasePersisted: true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: GCP Settings Persistence (Save to Database)
app.post('/api/gcp-settings', async (req, res) => {
  try {
    const payload = req.body || {};
    if (payload.bucket) setGcsBucket(payload.bucket);
    if (payload.projectId) setGcsProjectId(payload.projectId);
    if (payload.serviceAccountKey) setInMemoryServiceAccountKey(payload.serviceAccountKey);

    const saved = await saveGcpSettingsRecord({
      bucket: payload.bucket,
      projectId: payload.projectId,
      basePath: payload.basePath,
      generatedPath: payload.generatedPath,
      serviceAccountKey: payload.serviceAccountKey,
      accessToken: payload.accessToken,
    });

    const config = getGcsConfig();
    res.json({
      success: true,
      message: `Google Cloud settings saved to database! Bucket: ${saved.bucket}`,
      bucket: saved.bucket,
      projectId: saved.projectId,
      credentialsType: config.credentialsType,
      updatedAt: saved.updatedAt,
      databasePersisted: true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: List Generated PDFs from Google Cloud Storage (Bucket: vc-pdf-generator-storage/generated)
app.get('/api/gcs-generated-pdfs', async (req, res) => {
  try {
    const config = getGcsConfig();
    const explicitToken = req.headers['x-gcs-token'] || req.query.customToken || '';
    const serviceAccountKey = req.headers['x-gcs-sa-key'] || null;
    const token = await getGoogleAccessToken(explicitToken, serviceAccountKey);

    const gcsResult = await listGcsFolderObjects({
      bucket: config.bucket,
      prefix: config.generatedPath,
      token,
    });

    const items = [];
    if (gcsResult.ok && Array.isArray(gcsResult.items)) {
      for (const obj of gcsResult.items) {
        if (!obj.name || obj.name.endsWith('/')) continue;
        const filename = path.basename(obj.name);
        const matchEntry = filename.match(/entry[_-](\d+)/i) || filename.match(/form-(\d+)-entry-(\d+)/i);
        const entryId = matchEntry ? (matchEntry[2] || matchEntry[1]) : '';
        const formId = matchEntry && matchEntry[2] ? matchEntry[1] : '';

        items.push({
          id: obj.id || obj.name,
          name: obj.name,
          filename,
          size: Number(obj.size) || 0,
          updated: obj.updated || obj.timeCreated,
          timeCreated: obj.timeCreated,
          contentType: obj.contentType || 'application/pdf',
          mediaLink: obj.mediaLink,
          gcsUri: `gs://${config.bucket}/${obj.name}`,
          publicUrl: `https://storage.googleapis.com/${config.bucket}/${obj.name}`,
          consoleUrl: `https://console.cloud.google.com/storage/browser/${config.bucket}/${obj.name}?project=${config.projectId}`,
          entryId,
          formId,
          source: 'gcs',
        });
      }
    }

    // Also include any local generated files from generated/
    const localDir = path.join(__dirname, 'generated');
    if (fs.existsSync(localDir)) {
      try {
        const files = fs.readdirSync(localDir);
        for (const file of files) {
          if (!file.endsWith('.pdf')) continue;
          const stat = fs.statSync(path.join(localDir, file));
          const existing = items.find((it) => it.filename === file);
          if (existing) {
            existing.hasLocalCopy = true;
          } else {
            const matchEntry = file.match(/entry[_-](\d+)/i) || file.match(/form-(\d+)-entry-(\d+)/i);
            const entryId = matchEntry ? (matchEntry[2] || matchEntry[1]) : '';
            const formId = matchEntry && matchEntry[2] ? matchEntry[1] : '';
            items.push({
              id: `local-${file}`,
              name: `${config.generatedPath}/${file}`,
              filename: file,
              size: stat.size,
              updated: stat.mtime.toISOString(),
              timeCreated: stat.birthtime.toISOString(),
              contentType: 'application/pdf',
              localUrl: `/generated/${encodeURIComponent(file)}`,
              gcsUri: `gs://${config.bucket}/${config.generatedPath}/${file}`,
              publicUrl: `https://storage.googleapis.com/${config.bucket}/${config.generatedPath}/${file}`,
              consoleUrl: `https://console.cloud.google.com/storage/browser/${config.bucket}/${config.generatedPath}?project=${config.projectId}`,
              entryId,
              formId,
              source: 'local_cached',
            });
          }
        }
      } catch {}
    }

    // Sort descending by updated time
    items.sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());

    res.json({
      success: true,
      bucket: config.bucket,
      projectId: config.projectId,
      folder: config.generatedPath,
      consoleUrl: config.consoleUrl,
      count: items.length,
      items,
      gcsStatus: gcsResult.ok ? 'connected' : (token ? 'empty_or_error' : 'unauthenticated'),
      gcsError: gcsResult.error || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Delete Generated PDF from GCS & Local Storage
app.delete('/api/gcs-generated-pdfs', async (req, res) => {
  try {
    const objectPath = req.query.objectPath || req.body?.objectPath;
    const filename = req.query.filename || req.body?.filename;
    const config = getGcsConfig();
    const token = await getGoogleAccessToken();

    const targetPath = objectPath || `${config.generatedPath}/${filename}`;
    if (!targetPath) {
      return res.status(400).json({ error: 'objectPath or filename required' });
    }

    let gcsDeleted = false;
    if (token) {
      const del = await deleteGcsObject({
        bucket: config.bucket,
        objectPath: targetPath,
        token,
      });
      gcsDeleted = del.ok;
    }

    // Also remove from local generated/ folder if present
    const baseName = path.basename(targetPath);
    const localFile = path.join(__dirname, 'generated', baseName);
    let localDeleted = false;
    if (fs.existsSync(localFile)) {
      try {
        fs.unlinkSync(localFile);
        localDeleted = true;
      } catch {}
    }

    res.json({
      success: true,
      gcsDeleted,
      localDeleted,
      message: `Successfully deleted ${baseName}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Validate GCS Credentials & Auto-Persist to Database
app.post('/api/gcs-validate', async (req, res) => {
  try {
    const payload = req.body || {};
    const explicitToken = req.headers['x-gcs-token'] || payload.accessToken || '';
    const serviceAccountKey = req.headers['x-gcs-sa-key'] || payload.serviceAccountKey || null;

    if (payload.bucket) {
      setGcsBucket(payload.bucket);
    }
    if (payload.projectId) {
      setGcsProjectId(payload.projectId);
    }

    if (serviceAccountKey) {
      setInMemoryServiceAccountKey(serviceAccountKey);
    }

    const token = await getGoogleAccessToken(explicitToken, serviceAccountKey);
    const gcsConfig = getGcsConfig(payload.bucket, payload.projectId);

    if (token) {
      // Auto-persist valid credentials to database!
      try {
        await saveGcpSettingsRecord({
          bucket: gcsConfig.bucket,
          projectId: gcsConfig.projectId,
          serviceAccountKey: serviceAccountKey || undefined,
          accessToken: explicitToken || undefined,
        });
      } catch (dbErr) {
        console.warn('[Server] Could not auto-persist validated GCP credentials to DB:', dbErr.message);
      }

      return res.json({
        ok: true,
        authenticated: true,
        bucket: gcsConfig.bucket,
        projectId: gcsConfig.projectId,
        credentialsType: serviceAccountKey ? 'service_account' : (explicitToken ? 'access_token' : gcsConfig.credentialsType),
        message: `Authentication successful! Connected to Google Cloud Storage bucket ${gcsConfig.bucket} (Project: ${gcsConfig.projectId}) and persisted to database.`,
      });
    }

    return res.json({
      ok: false,
      authenticated: false,
      bucket: gcsConfig.bucket,
      projectId: gcsConfig.projectId,
      message: `No active credentials detected for bucket ${gcsConfig.bucket}. Please paste a Service Account JSON key or Access Token.`,
    });
  } catch (err) {
    return res.json({
      ok: false,
      authenticated: false,
      error: err.message,
      message: `Validation failed: ${err.message}`,
    });
  }
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
    const serviceAccountKey = req.headers['x-gcs-sa-key'] || payload.serviceAccountKey || null;
    const token = await getGoogleAccessToken(explicitToken, serviceAccountKey);

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

// API: WordPress Proxy & Remote Asset Proxy (with GCS Auth & URL Normalization)
app.all('/api/wp-proxy', async (req, res) => {
  try {
    const rawTargetUrl = req.query.url;
    const sourceConnectionId = req.query.sourceConnectionId || null;
    const apiKeyFromQuery = req.query.apiKey || '';
    const basicUser = req.query.basicUser || '';
    const basicPass = req.query.basicPass || '';

    if (!rawTargetUrl) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    // Clean up double slashes in URL pathname (e.g. templates//AVTA -> templates/AVTA)
    let cleanTargetUrl = rawTargetUrl.replace(/([^:]\/)\/+/g, '$1');

    // Validate URL - only allow same-origin or known external endpoints
    let parsedTarget;
    try {
      parsedTarget = new URL(cleanTargetUrl);
    } catch {
      return res.status(400).json({ error: 'Invalid target URL' });
    }

    // Security: block private/internal IPs
    const hostname = parsedTarget.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' ||
        hostname.endsWith('.local') || hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') || hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) {
      return res.status(400).json({ error: 'Blocked: private/internal URL not allowed' });
    }

    let apiKey = apiKeyFromQuery;

    // If sourceConnectionId provided, resolve API key from DB
    if (sourceConnectionId) {
      const conn = await getSourceConnection(sourceConnectionId);
      if (!conn) {
        return res.status(404).json({ error: 'Source connection not found' });
      }
      const dbApiKey = await getSourceConnectionApiKey(sourceConnectionId);
      if (!dbApiKey) {
        return res.status(401).json({ error: 'API key not configured for this source connection', errorType: 'api_key_not_configured' });
      }
      apiKey = dbApiKey;
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

    // If proxying to GCS / Cloud storage bucket, inject Bearer token
    if (cleanTargetUrl.includes('storage.googleapis.com') || cleanTargetUrl.includes('vconsultancy.com.au')) {
      try {
        const explicitToken = req.headers['x-gcs-token'] || '';
        const token = await getGoogleAccessToken(explicitToken);
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
      } catch {}
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

    let upstreamRes = await fetch(cleanTargetUrl, {
      method: req.method,
      headers,
      body,
    });

    // Fallback 1: If 403 or 404, check if appending .pdf resolves the template
    if (!upstreamRes.ok && (upstreamRes.status === 403 || upstreamRes.status === 404) && !cleanTargetUrl.toLowerCase().endsWith('.pdf')) {
      const pdfCandidateUrl = `${cleanTargetUrl}.pdf`;
      try {
        const retryRes = await fetch(pdfCandidateUrl, { method: req.method, headers, body });
        if (retryRes.ok) {
          upstreamRes = retryRes;
        }
      } catch {}
    }

    // Fallback 2: Check local templates folder if remote returns 403/404 for a template
    if (!upstreamRes.ok && (upstreamRes.status === 403 || upstreamRes.status === 404)) {
      const urlPathname = decodeURIComponent(parsedTarget.pathname);
      const urlFilename = path.basename(urlPathname);
      const possibleFilenames = [
        urlFilename,
        `${urlFilename}.pdf`,
        urlFilename.replace(/ /g, '_'),
        `${urlFilename.replace(/ /g, '_')}.pdf`,
      ];

      const templateDirs = [
        path.join(__dirname, 'pdf-mapper', 'public', 'templates'),
        path.join(__dirname, 'pdf-mapper', 'dist', 'templates'),
        path.join(__dirname, 'generated'),
      ];

      for (const tDir of templateDirs) {
        if (!fs.existsSync(tDir)) continue;
        for (const fName of possibleFilenames) {
          // Check direct or in subcategory folders
          const directFile = path.join(tDir, fName);
          if (fs.existsSync(directFile) && fs.statSync(directFile).isFile()) {
            const buf = fs.readFileSync(directFile);
            res.status(200);
            res.setHeader('Content-Type', 'application/pdf');
            return res.end(buf);
          }
          // Scan category folders
          try {
            const subdirs = fs.readdirSync(tDir);
            for (const sub of subdirs) {
              const subPath = path.join(tDir, sub, fName);
              if (fs.existsSync(subPath) && fs.statSync(subPath).isFile()) {
                const buf = fs.readFileSync(subPath);
                res.status(200);
                res.setHeader('Content-Type', 'application/pdf');
                return res.end(buf);
              }
            }
          } catch {}
        }
      }
    }

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

// Serve local generated PDF directory
app.use('/generated', express.static(path.join(__dirname, 'generated')));
app.use('/templates', express.static(path.join(__dirname, 'pdf-mapper', 'public', 'templates')));
app.use('/templates', express.static(path.join(__dirname, 'pdf-mapper', 'dist', 'templates')));

// Serve frontend static build files or Vite middleware
const distPath = path.join(__dirname, 'pdf-mapper', 'dist');

let viteMiddlewareMounted = false;
if (process.env.NODE_ENV !== 'production' && !fs.existsSync(distPath)) {
  try {
    const viteModule = await import('./pdf-mapper/node_modules/vite/dist/node/index.js');
    const vite = await viteModule.createServer({
      server: { middlewareMode: true },
      root: path.join(__dirname, 'pdf-mapper'),
      appType: 'spa',
    });
    app.use(vite.middlewares);
    viteMiddlewareMounted = true;
    console.log('[Server] Vite middleware mounted for development mode');
  } catch (err) {
    console.warn('[Server] Could not initialize Vite middleware:', err.message);
  }
}

if (!viteMiddlewareMounted && fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  // Wildcard SPA fallback for GET requests (exclude static assets and API routes)
  app.use((req, res, next) => {
    if (
      req.method === 'GET' &&
      !req.path.startsWith('/api/') &&
      !req.path.startsWith('/templates/') &&
      !req.path.startsWith('/generated/') &&
      !req.path.endsWith('.pdf') &&
      !req.path.endsWith('.json') &&
      !req.path.endsWith('.mjs') &&
      !req.path.endsWith('.js') &&
      !req.path.endsWith('.css')
    ) {
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
