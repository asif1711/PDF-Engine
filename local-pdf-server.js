/**
 * Standalone Local PDF Generation Worker
 * Run this on your computer alongside LocalWP:
 * 
 *   node local-pdf-server.js
 * 
 * It runs on http://127.0.0.1:4000/api/generate-pdf
 * Then set your Webhook URL in WordPress to:
 *   http://127.0.0.1:4000/api/generate-pdf
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateFilledPdf } from './pdf-mapper/src/pdfGenerator.js';
import { normalizeSavedMappings } from './pdf-mapper/src/mappingUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.WORKER_PORT || 4000;

// CLI helper: If run with --check or --check-mapping, inspect and print the mapping file details and exit
if (process.argv.includes('--check') || process.argv.includes('--check-mapping')) {
  const mappingsDir = path.join(__dirname, 'mappings');
  console.log('\n=======================================================');
  console.log('  PDF Generator Worker - Mapping Inspector');
  console.log('=======================================================');
  console.log(`Directory: ${mappingsDir}\n`);

  if (!fs.existsSync(mappingsDir)) {
    console.error(`[!] Mappings directory not found at ${mappingsDir}`);
    process.exit(1);
  }

  const folders = fs.readdirSync(mappingsDir);
  let totalFound = 0;

  for (const folder of folders) {
    const fullDir = path.join(mappingsDir, folder);
    if (fs.statSync(fullDir).isDirectory()) {
      const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        totalFound++;
        const filePath = path.join(fullDir, file);
        const stats = fs.statSync(filePath);
        try {
          const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          const normalized = normalizeSavedMappings(content);
          const rules = Object.values(normalized);

          console.log(`-------------------------------------------------------`);
          console.log(`[Form #${content.formId || '?'}] ${content.formTitle || 'Untitled Form'}`);
          console.log(`  File Path:      ${path.relative(process.cwd(), filePath)}`);
          console.log(`  Last Modified:  ${stats.mtime.toLocaleString()} (${stats.mtime.toISOString()})`);
          console.log(`  PDF Template:   ${content.templateFilename || content.templateId || 'Unknown'}`);
          console.log(`  Total Rules:    ${rules.length} mapped field(s)`);
          console.log(`\n  Configured Field Mappings:`);
          for (const item of rules) {
            const src = item.sourceInputId
              ? `GF Field ${item.sourceFieldId} (Input ${item.sourceInputId})`
              : (item.sourceFieldId ? `GF Field ${item.sourceFieldId}` : item.source?.systemKey || item.id || 'Custom');
            const label = item.gravityFieldLabel || item.inputLabel || '';
            const tgt = item.targetField || item.pdfField || (item.children ? `Repeat [${item.children.map(c => c.targetPattern).join(', ')}]` : '');
            console.log(`    • ${src}${label ? ` "${label}"` : ''} ➔ PDF "${tgt}"`);
          }
          console.log('');
        } catch (e) {
          console.error(`  [!] Error parsing ${file}: ${e.message}`);
        }
      }
    }
  }

  if (totalFound === 0) {
    console.log('No mapping JSON files found in mappings/ directory.');
  }
  console.log('=======================================================\n');
  process.exit(0);
}

function formatDate(dateValue, format = "DD/MM/YYYY") {
  if (!dateValue) return "";
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return String(dateValue);

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthName = monthNames[date.getMonth()] || month;

  if (format === "YYYY-MM-DD") return `${year}-${month}-${day}`;
  if (format === "DD Month YYYY") return `${day} ${monthName} ${year}`;
  return `${day}/${month}/${year}`;
}

function parseListRows(rawData) {
  if (!rawData) return [];
  if (Array.isArray(rawData)) return rawData;
  if (typeof rawData === "object" && rawData !== null) {
    return Object.values(rawData);
  }
  if (typeof rawData !== "string") return [];

  const trimmed = rawData.trim();
  if (!trimmed) return [];

  // Attempt JSON parse
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed === "object" && parsed !== null) return Object.values(parsed);
    } catch {}
  }

  // Parse PHP serialized array (standard Gravity Forms list field format)
  if (trimmed.startsWith("a:") || trimmed.includes("s:")) {
    const rows = [];
    const itemRegex = /a:\d+:\{([^}]+)\}/g;
    let match;
    while ((match = itemRegex.exec(trimmed)) !== null) {
      const inner = match[1];
      const pairs = {};
      const pairRegex = /s:\d+:"([^"]*)";s:\d+:"([^"]*)";/g;
      let pm;
      while ((pm = pairRegex.exec(inner)) !== null) {
        pairs[pm[1]] = pm[2];
      }
      if (Object.keys(pairs).length > 0) {
        rows.push(pairs);
      }
    }
    if (rows.length > 0) return rows;
  }

  return [];
}

function normalizeSubmissionData(rawSubmission) {
  if (!rawSubmission || typeof rawSubmission !== "object") return {};
  let base = { ...rawSubmission };
  if (rawSubmission.entry && typeof rawSubmission.entry === "object") {
    base = { ...rawSubmission, ...rawSubmission.entry };
  }
  return base;
}

function extractEntryValue(entry, fieldId, inputId) {
  if (!entry || typeof entry !== "object") return "";

  const strInputId = inputId !== undefined && inputId !== null ? String(inputId).trim() : "";
  const strFieldId = fieldId !== undefined && fieldId !== null ? String(fieldId).trim() : "";

  // 1. Explicit Sub-Input ID (e.g. "1.3", "19.1", "8.1")
  // Look up entry[inputId]. If the key exists in the entry, return its value (even if it is "").
  if (strInputId) {
    if (strInputId in entry && entry[strInputId] !== undefined && entry[strInputId] !== null) {
      return String(entry[strInputId]);
    }
  }

  // 2. Direct Field ID (e.g. "4", "3", "19", "26")
  if (strFieldId) {
    // If entry[fieldId] exists as a primitive string or number, return it directly.
    // If it is "" (empty / hidden), return "". Never cross over to another field ID.
    if (strFieldId in entry && entry[strFieldId] !== undefined && entry[strFieldId] !== null) {
      const directVal = entry[strFieldId];
      if (typeof directVal !== "object") {
        return String(directVal);
      }
    }

    // If not a direct primitive, inspect ONLY compound sub-keys that belong strictly to this field: `${strFieldId}.*`
    const subKeys = Object.keys(entry)
      .filter((k) => k.startsWith(`${strFieldId}.`))
      .sort((a, b) => parseFloat(a) - parseFloat(b));

    if (subKeys.length > 0) {
      const nonEmpties = subKeys
        .map((k) => entry[k])
        .filter((v) => v !== "" && v !== null && v !== undefined && typeof v !== "object");
      if (nonEmpties.length > 0) {
        return nonEmpties.join(" ");
      }
      return "";
    }
  }

  return "";
}

/**
 * Core PDF generation engine
 */
async function localGenerateFilledPdf({ templateBytes, mappings, submission: rawSubmission, flatten = false }) {
  if (typeof sharedGenerateFilledPdf === 'function') {
    return sharedGenerateFilledPdf({
      templateBytes,
      mappings,
      submission: rawSubmission,
      flatten,
      attachUploadedFiles: true,
    });
  }

  const submission = normalizeSubmissionData(rawSubmission);
  const pdfDoc = await PDFDocument.load(templateBytes);
  const form = pdfDoc.getForm();
  const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const mappedPdfFieldNames = new Set();
  const actuallyFilledFieldNames = new Set();
  let filledCount = 0;

  const mappingList = Array.isArray(mappings)
    ? mappings
    : Object.values(mappings || {}).filter(Boolean);

  function fillAcroField(targetName, value) {
    if (!targetName) return;
    mappedPdfFieldNames.add(targetName);
    try {
      const field = form.getField(targetName);
      if (!field) return;

      const strVal = value !== undefined && value !== null ? String(value).trim() : "";
      // Exception 2: If field is empty or unmapped or hidden, keep untouched in template so it stays fillable
      if (!strVal) return;

      if (field instanceof PDFTextField) {
        field.setText(strVal);
        actuallyFilledFieldNames.add(targetName);
        let calculatedFontSize = 9.5;
        const standardFontSize = 9.5;
        try {
          const widgets = field.acroField.getWidgets();
          if (widgets.length > 0 && strVal) {
            const rect = widgets[0].getRectangle();
            const availableWidth = rect.width - 4;
            const textWidthAt10 = helveticaFont.widthOfTextAtSize(strVal, standardFontSize);
            if (textWidthAt10 > availableWidth && availableWidth > 15) {
              calculatedFontSize = Math.max(6.5, Math.floor((availableWidth / textWidthAt10) * standardFontSize * 10) / 10);
            }
          }
        } catch {}
        try { field.setFontSize(calculatedFontSize); } catch {}
        filledCount++;
      } else if (field instanceof PDFCheckBox) {
        const isChecked = strVal === "1" || strVal.toLowerCase() === "true" || strVal.toLowerCase() === "yes" || strVal.toLowerCase() === "on";
        if (isChecked) {
          field.check();
          actuallyFilledFieldNames.add(targetName);
          filledCount++;
        }
      } else if (field instanceof PDFRadioGroup) {
        try { field.select(strVal); actuallyFilledFieldNames.add(targetName); filledCount++; } catch {}
      }
    } catch (err) {
      console.warn(`[Local Worker] Could not fill field "${targetName}":`, err.message);
    }
  }

  for (const item of mappingList) {
    if (!item) continue;

    // DIRECT MAPPING
    if (item.type === "direct" || (!item.type && (item.pdfField || item.targetField || item.target?.fieldName))) {
      const targetPdfField = item.pdfField || item.target?.fieldName || item.targetField;
      const sourceFieldId = item.sourceFieldId || item.gravityFieldId || item.source?.fieldId;
      const sourceInputId = item.sourceInputId || item.source?.inputId;
      let val = extractEntryValue(submission, sourceFieldId, sourceInputId);

      if (item.gravityFieldType === "date" && val) {
        val = formatDate(val);
      }

      fillAcroField(targetPdfField, val);
    }

    // COMPOSE MAPPING
    else if (item.type === "compose") {
      const targetPdfField = item.pdfField || item.target?.fieldName;
      const sources = item.sources || [];
      const separator = item.literal || " ";
      const combinedValue = sources
        .map((s) => extractEntryValue(submission, s.fieldId, s.inputId))
        .filter((v) => v !== "" && v !== null && v !== undefined)
        .join(separator);
      fillAcroField(targetPdfField, combinedValue);
    }

    // SYSTEM MAPPING
    else if (item.type === "system") {
      const targetPdfField = item.pdfField || item.target?.fieldName;
      const rawDate = submission?.date_created || submission?.submitted_at || new Date().toISOString();
      const formatted = formatDate(rawDate, item.source?.format || "DD/MM/YYYY");
      fillAcroField(targetPdfField, formatted);
    }

    // REPEATING LIST / TABLE MAPPING
    else if (item.type === "repeat") {
      const sourceFieldId = item.sourceFieldId || item.gravityFieldId || item.source?.fieldId;
      let rawList = submission?.[sourceFieldId] || submission?.[item.repeatCountFieldId] || submission?.units || submission?.["8"] || submission?.["9"];

      if (!rawList) {
        for (const [, v] of Object.entries(submission)) {
          if (typeof v === "string" && (v.startsWith("a:") || v.startsWith("[{") || v.startsWith('{"'))) {
            rawList = v;
            break;
          }
        }
      }

      const rows = parseListRows(rawList);
      const children = item.children || [];

      rows.forEach((row, rowIndex) => {
        const oneBasedIndex = rowIndex + 1;
        children.forEach((child) => {
          const targetName = String(child.targetPattern || "").replace("{index}", oneBasedIndex);
          let val = "";
          if (typeof row === "object" && row !== null) {
            if (child.inputLabel && row[child.inputLabel] !== undefined) {
              val = row[child.inputLabel];
            } else if (child.sourceInputId && row[child.sourceInputId] !== undefined) {
              val = row[child.sourceInputId];
            } else {
              const targetNorm = String(child.inputLabel || "").toLowerCase().replace(/[^a-z0-9]/g, "");
              const labelKey = Object.keys(row).find((k) => {
                const kNorm = k.toLowerCase().replace(/[^a-z0-9]/g, "");
                if (kNorm === targetNorm) return true;
                if ((targetNorm.includes("title") || targetNorm.includes("name")) && (kNorm.includes("title") || kNorm.includes("name"))) return true;
                if (targetNorm.includes("code") && kNorm.includes("code")) return true;
                return false;
              });
              if (labelKey) val = row[labelKey];
            }
          } else if (typeof row === "string") {
            val = row;
          }
          fillAcroField(targetName, val);
        });
      });
    }
  }

  // Lock only actually filled fields as read-only.
  // Empty, hidden, or unmapped fields remain fillable and editable.
  try {
    const allPdfFields = form.getFields();
    for (const field of allPdfFields) {
      if (actuallyFilledFieldNames.has(field.getName())) {
        try { field.enableReadOnly(); } catch {}
      } else {
        try { field.disableReadOnly(); } catch {}
      }
    }
  } catch {}

  try {
    form.updateFieldAppearances(helveticaFont);
  } catch {}

  if (flatten) {
    try { form.flatten(); } catch {}
  }

  const pdfBytes = await pdfDoc.save();
  return { pdfBytes, filledCount, totalMappings: mappingList.length };
}

// HTTP Server
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = parsedUrl.pathname;

  // Log incoming requests
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] Incoming: ${req.method} ${pathname}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-PDF-API-Key, ngrok-skip-browser-warning');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  // API: Save Mapping
  if ((pathname === '/api/save-mapping' || pathname === '/api/mappings') && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        const formId = String(payload.formId || '1');
        const templateId = String(payload.templateId || 'Template').replace(/[^a-zA-Z0-9._-]/g, '_');
        const formDir = path.join(__dirname, 'mappings', `form-${formId}`);
        fs.mkdirSync(formDir, { recursive: true });
        const targetFile = path.join(formDir, `${templateId}.json`);
        fs.writeFileSync(targetFile, JSON.stringify(payload, null, 2), 'utf-8');
        console.log(`[Local Worker] Saved mapping configuration for Form #${formId} to ${targetFile}`);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, path: `mappings/form-${formId}/${templateId}.json` }));
      } catch (err) {
        console.error('[Local Worker] Failed to save mapping:', err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: Check Mapping endpoint for easy browser inspection
  if ((pathname === '/api/check-mapping' || pathname === '/api/mapping-info') && req.method === 'GET') {
    try {
      const requestedFormId = parsedUrl.searchParams.get('formId') || '1';
      const mappingsDir = path.join(__dirname, 'mappings');
      const formDir = path.join(mappingsDir, `form-${requestedFormId}`);
      let foundFile = null;
      let foundData = null;

      if (fs.existsSync(formDir)) {
        const files = fs.readdirSync(formDir).filter(f => f.endsWith('.json'));
        if (files.length > 0) {
          foundFile = path.join(formDir, files[0]);
          foundData = JSON.parse(fs.readFileSync(foundFile, 'utf-8'));
        }
      }

      if (!foundData) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: `No mapping file found for Form #${requestedFormId} in ${formDir}`,
          availableForms: fs.existsSync(mappingsDir) ? fs.readdirSync(mappingsDir) : []
        }, null, 2));
        return;
      }

      const stats = fs.statSync(foundFile);
      const normalized = normalizeSavedMappings(foundData);
      const rules = Object.values(normalized).map(r => ({
        sourceFieldId: r.sourceFieldId,
        sourceInputId: r.sourceInputId,
        gravityFieldLabel: r.gravityFieldLabel || r.inputLabel || '',
        targetPdfField: r.targetField || r.pdfField || (r.children ? `Repeat: ${r.children.map(c => c.targetPattern).join(', ')}` : ''),
        type: r.type
      }));

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        status: 'ok',
        formId: foundData.formId,
        formTitle: foundData.formTitle,
        mappingFilePath: path.relative(process.cwd(), foundFile),
        fileLastModified: stats.mtime.toISOString(),
        pdfTemplate: foundData.templateFilename || foundData.templateId,
        totalMappedRules: rules.length,
        rules: rules
      }, null, 2));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: List Mappings
  if (pathname === '/api/mappings' && req.method === 'GET') {
    try {
      const formId = parsedUrl.searchParams.get('formId');
      const templateId = parsedUrl.searchParams.get('templateId');
      const mappingsDir = path.join(__dirname, 'mappings');
      if (formId && templateId) {
        const filePath = path.join(mappingsDir, `form-${formId}`, `${templateId}.json`);
        if (fs.existsSync(filePath)) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(fs.readFileSync(filePath, 'utf-8'));
          return;
        }
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Mapping not found' }));
        return;
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
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(results));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Generate PDF
  if (pathname === '/api/generate-pdf' || pathname === '/generate-pdf') {
    if (req.method === 'GET') {
      const accept = req.headers['accept'] || '';
      if (accept.includes('text/html')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <title>PDF Generation Worker</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; margin: 0; padding: 40px 20px; color: #1a202c; }
              .card { max-width: 600px; margin: 0 auto; background: #fff; padding: 32px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
              .badge { display: inline-block; background: #def7ec; color: #03543f; padding: 4px 12px; border-radius: 999px; font-weight: 600; font-size: 14px; margin-bottom: 16px; }
              h1 { margin: 0 0 8px 0; font-size: 24px; }
              p { line-height: 1.6; color: #4a5568; }
              code { background: #edf2f7; padding: 4px 8px; border-radius: 4px; font-family: monospace; font-size: 14px; }
              .box { background: #f7fafc; border: 1px solid #e2e8f0; padding: 16px; border-radius: 6px; margin-top: 20px; }
            </style>
          </head>
          <body>
            <div class="card">
              <span class="badge">● Worker Online</span>
              <h1>PDF Generation Worker is Running!</h1>
              <p>This worker is running locally and ready to accept Gravity Forms submission webhooks.</p>
              <div class="box">
                <strong>Your WordPress Webhook URL:</strong><br>
                <code style="display:block; margin-top:8px; font-size:15px; color:#2b6cb0;">http://127.0.0.1:${PORT}/api/generate-pdf</code>
              </div>
              <p style="margin-top:20px; font-size:13px; color:#718096;">
                Copy the URL above and paste it into WordPress Admin: <strong>Tools &rarr; Gravity Forms Reader &rarr; Webhook URL</strong>.
              </p>
            </div>
          </body>
          </html>
        `);
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        status: 'ready',
        service: 'Local PDF Generation Worker',
        port: PORT,
        endpoint: `/api/generate-pdf`,
        message: 'Local PDF worker is online and listening. Ready to generate PDFs from Gravity Forms.',
      }));
      return;
    }

    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        try {
          const bodyStr = Buffer.concat(chunks).toString('utf-8');
          const payload = JSON.parse(bodyStr || '{}');
          const formId = String(payload.form_id || payload.formId || (payload.entry && payload.entry.form_id) || '1');
          const entryId = String(payload.entry_id || payload.entryId || (payload.entry && payload.entry.id) || '0');
          const entry = payload.entry || payload;

          console.log(`[Local Worker] Received generate request for Form #${formId}, Entry #${entryId}`);

          // Instant response for test ping from WordPress Admin
          if (entryId === 'test-ping' || payload.is_test) {
            console.log(`[Local Worker] Responded to Webhook Test Ping from WordPress.`);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              success: true,
              test: true,
              message: 'Webhook Test Ping Successful! Local PDF Worker is active and connected to WordPress.',
              form_id: formId,
            }));
            return;
          }

          // 1. Resolve mapping configuration (exact same system as "Push PDF to WP & Email" button)
          let mappingData = null;
          let mappingFilePath = null;
          if (payload.mappings) {
            mappingData = { mappings: payload.mappings };
            mappingFilePath = "Passed in request payload";
            console.log(`[Local Worker] Using mappings provided in request payload.`);
          } else {
            const mappingsDir = path.join(__dirname, 'mappings');
            const formDir = path.join(mappingsDir, `form-${formId}`);
            if (fs.existsSync(formDir)) {
              const files = fs.readdirSync(formDir).filter(f => f.endsWith('.json'));
              if (files.length > 0) {
                mappingFilePath = path.join(formDir, files[0]);
                mappingData = JSON.parse(fs.readFileSync(mappingFilePath, 'utf-8'));
              }
            }

            // Fallback search in mappings directory
            if (!mappingData && fs.existsSync(mappingsDir)) {
              const allFolders = fs.readdirSync(mappingsDir);
              for (const folder of allFolders) {
                const subDir = path.join(mappingsDir, folder);
                if (fs.statSync(subDir).isDirectory()) {
                  const files = fs.readdirSync(subDir).filter(f => f.endsWith('.json'));
                  for (const file of files) {
                    try {
                      const candidate = JSON.parse(fs.readFileSync(path.join(subDir, file), 'utf-8'));
                      if (String(candidate.formId) === String(formId)) {
                        mappingFilePath = path.join(subDir, file);
                        mappingData = candidate;
                        break;
                      }
                    } catch {}
                  }
                }
                if (mappingData) break;
              }
            }
          }

          if (!mappingData) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: `Mapping file for Form #${formId} not found in mappings/form-${formId}/` }));
            return;
          }

          // Exact same normalization pipeline as App.jsx
          const activeMappings = normalizeSavedMappings(mappingData);
          const mappedRuleCount = Object.keys(activeMappings).length;
          console.log(`\n[Local Worker] ----------------------------------------------------`);
          console.log(`[Local Worker] Generating PDF for Form #${formId}, Entry #${entryId}`);
          console.log(`[Local Worker] Mapping File: ${mappingFilePath ? path.relative(process.cwd(), mappingFilePath) : 'payload'}`);
          if (mappingFilePath && fs.existsSync(mappingFilePath)) {
            const stats = fs.statSync(mappingFilePath);
            console.log(`[Local Worker] File Modified: ${stats.mtime.toLocaleString()} (${stats.mtime.toISOString()})`);
          }
          console.log(`[Local Worker] Form Title:    "${mappingData.formTitle || 'Form ' + formId}"`);
          console.log(`[Local Worker] Active Rules:  ${mappedRuleCount} field mapping(s) configured`);

          // 2. Find template PDF
          const templateCandidates = [
            path.join(__dirname, mappingData.templateFilename || 'NPA_Credit Transfer Forms_V2.1.pdf'),
            path.join(__dirname, `${mappingData.templateId}.pdf`),
            path.join(__dirname, 'NPA_Credit Transfer Forms_V2.1.pdf'),
            path.join(__dirname, 'pdf-mapper', 'public', 'templates', 'NPA', mappingData.templateFilename || 'NPA_Credit Transfer Forms_V2.1.pdf'),
            path.join(__dirname, 'pdf-mapper', 'public', 'templates', 'AIBT', mappingData.templateFilename || ''),
          ];

          if (mappingData.category) {
            templateCandidates.push(path.join(__dirname, 'pdf-mapper', 'public', 'templates', mappingData.category, mappingData.templateFilename || ''));
            templateCandidates.push(path.join(__dirname, 'pdf-mapper', 'public', 'templates', mappingData.category, `${mappingData.templateId}.pdf`));
          }

          const tplRoot = path.join(__dirname, 'pdf-mapper', 'public', 'templates');
          if (fs.existsSync(tplRoot)) {
            try {
              const catFolders = fs.readdirSync(tplRoot);
              for (const cat of catFolders) {
                const catDir = path.join(tplRoot, cat);
                if (fs.statSync(catDir).isDirectory()) {
                  if (mappingData.templateFilename) {
                    templateCandidates.push(path.join(catDir, mappingData.templateFilename));
                    templateCandidates.push(path.join(catDir, mappingData.templateFilename.replace(/ /g, '_')));
                  }
                  if (mappingData.templateId) {
                    templateCandidates.push(path.join(catDir, `${mappingData.templateId}.pdf`));
                  }
                }
              }
            } catch {}
          }

          let templateBytes = null;
          for (const cand of templateCandidates) {
            if (cand && fs.existsSync(cand)) {
              templateBytes = fs.readFileSync(cand);
              break;
            }
          }

          if (!templateBytes) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: `Template PDF file not found. Looked in: ${templateCandidates.filter(Boolean).join(', ')}` }));
            return;
          }

          // 3. Generate filled PDF using exact same mechanism as "Push PDF to WP & Email" button
          const wpFormsUrl = payload.wordpress_url || payload.forms_url || process.env.WORDPRESS_FORMS_URL || "";
          const apiKey = payload.wordpress_api_key || payload.api_key || req.headers['x-pdf-api-key'] || process.env.WORDPRESS_API_KEY || "";

          const result = await generateFilledPdf({
            templateBytes: new Uint8Array(templateBytes),
            mappings: activeMappings,
            submission: entry,
            flatten: false,
            formsUrl: wpFormsUrl,
            apiKey: apiKey,
            attachUploadedFiles: true,
          });

          const pdfBytes = result.pdfBytes;
          const filledCount = result.filledCount;
          console.log(`[Local Worker] Successfully generated PDF for Entry #${entryId} (${filledCount} fields populated, ${pdfBytes.length} bytes)`);

          // 4. If destination path is on local disk (from WordPress webhook payload), write directly
          if (payload.pdf_destination) {
            try {
              const destDir = path.dirname(payload.pdf_destination);
              if (fs.existsSync(destDir)) {
                fs.writeFileSync(payload.pdf_destination, Buffer.from(pdfBytes));
                console.log(`[Local Worker] Successfully wrote PDF to destination: ${payload.pdf_destination}`);
              }
            } catch (destErr) {
              console.warn(`[Local Worker] Could not write directly to pdf_destination:`, destErr.message);
            }
          }

          // 5. If WordPress forms URL is known, also push to WordPress REST API and trigger email
          if (wpFormsUrl && entryId && entryId !== '0') {
            try {
              const rawBase = wpFormsUrl.replace(/\/$/, "");
              const restBase = rawBase.endsWith("/forms") ? rawBase.replace(/\/forms$/, "") : (rawBase.includes("/wp-json") ? rawBase : `${rawBase}/wp-json/pdf-generator/v1`);
              const uploadUrl = `${restBase}/entries/${entryId}/pdf?send_notification=1`;
              const headers = { 'Content-Type': 'application/pdf', 'ngrok-skip-browser-warning': '1' };
              if (apiKey) headers['X-PDF-API-Key'] = apiKey;

              console.log(`[Local Worker] Pushing PDF to WordPress: ${uploadUrl}`);
              const wpRes = await fetch(uploadUrl, { method: 'POST', headers, body: Buffer.from(pdfBytes) });
              if (wpRes.ok) {
                console.log(`[Local Worker] WordPress accepted PDF and dispatched email notifications successfully!`);
              } else {
                console.warn(`[Local Worker] WordPress upload returned status: ${wpRes.status}`);
              }
            } catch (pushErr) {
              console.warn(`[Local Worker] Could not push to WordPress REST endpoint:`, pushErr.message);
            }
          }

          // 6. Return response to caller
          const accept = req.headers['accept'] || '';
          if (accept.includes('application/json')) {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              success: true,
              filledCount,
              filename: `form-${formId}-entry-${entryId}.pdf`,
              pdfBytesBase64: Buffer.from(pdfBytes).toString('base64'),
            }));
          } else {
            // Binary PDF stream - WordPress file_put_contents directly saves this
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Length', String(pdfBytes.length));
            res.setHeader('X-Filled-Fields', String(filledCount));
            res.end(Buffer.from(pdfBytes));
          }
        } catch (err) {
          console.error('[Local Worker] Error generating PDF:', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
    return;
  }

  // Health check / ping
  if (pathname === '/' || pathname === '/health') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', service: 'Local PDF Generation Worker', port: PORT }));
    return;
  }

  res.statusCode = 404;
  res.end('Not Found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[ERROR] Port ${PORT} is already in use by another program on your computer!`);
    console.error(`To fix this:`);
    console.error(`1. Close any other node windows or apps using port ${PORT}, OR`);
    console.error(`2. Run on a different port: set WORKER_PORT=4001 && node local-pdf-server.js`);
    console.error(`   and update your Webhook URL in WordPress to: http://127.0.0.1:4001/api/generate-pdf\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n=======================================================`);
  console.log(`  PDF Generator Worker running locally!`);
  console.log(`  URL: http://127.0.0.1:${PORT}/api/generate-pdf`);
  console.log(`  Inspection: http://127.0.0.1:${PORT}/api/check-mapping`);
  console.log(`=======================================================`);

  // Diagnostics check
  const mappingsDir = path.join(__dirname, 'mappings');
  const form1Dir = path.join(mappingsDir, 'form-1');
  const templatePdf = path.join(__dirname, 'NPA_Credit Transfer Forms_V2.1.pdf');

  if (fs.existsSync(form1Dir)) {
    const jsonFiles = fs.readdirSync(form1Dir).filter(f => f.endsWith('.json'));
    if (jsonFiles.length > 0) {
      const form1File = path.join(form1Dir, jsonFiles[0]);
      const stats = fs.statSync(form1File);
      try {
        const data = JSON.parse(fs.readFileSync(form1File, 'utf-8'));
        const normalized = normalizeSavedMappings(data);
        const count = Object.keys(normalized).length;
        console.log(`  [✓] Form #1 Mapping File: ${path.relative(process.cwd(), form1File)}`);
        console.log(`      Title:         "${data.formTitle || 'Form 1'}"`);
        console.log(`      PDF Template:  ${data.templateFilename || data.templateId || 'NPA_Credit Transfer Forms_V2.1.pdf'}`);
        console.log(`      Last Modified: ${stats.mtime.toLocaleString()} (${stats.mtime.toISOString()})`);
        console.log(`      Mapped Rules:  ${count} configured field(s)`);
      } catch (e) {
        console.log(`  [✓] Form #1 file: ${jsonFiles[0]} (JSON parse error: ${e.message})`);
      }
    } else {
      console.warn(`  [!] Warning: No .json files found in ${form1Dir}`);
    }
  } else {
    console.warn(`  [!] Warning: mappings/form-1/ directory not found in ${mappingsDir}`);
  }

  if (fs.existsSync(templatePdf)) {
    console.log(`  [✓] Template PDF verified: NPA_Credit Transfer Forms_V2.1.pdf`);
  } else {
    console.warn(`  [!] Warning: Template PDF not found at ${templatePdf}`);
  }

  console.log(`-------------------------------------------------------`);
  console.log(`  Tip: Run 'node local-pdf-server.js --check' anytime to`);
  console.log(`  print out all mapped fields in full detail.`);
  console.log(`-------------------------------------------------------`);
  console.log(`  Waiting for WordPress form submissions or test pings...`);
  console.log(`-------------------------------------------------------\n`);
});
