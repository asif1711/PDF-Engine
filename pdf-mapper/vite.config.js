import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { analyzePdfBytes } from '../analyze-template.js'
import { generateFilledPdf } from './src/pdfGenerator.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const GCS_BUCKET = process.env.GCS_BUCKET_NAME || 'cdn.vconsultancy.com.au'
const GCS_PROJECT_ID = process.env.GCS_PROJECT_ID || 'aibt-244204'
const GCS_BASE_PATH = 'pdf-generator/templates'
const ALLOWED_CATEGORIES = ['AIBT', 'AIBT-I', 'AVTA', 'NPA', 'BIC', 'REACH', 'HJ', 'Pivot', 'Profound', 'Others']

function getRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function getGoogleAccessToken(explicitTokenOrKey) {
  // 1. Explicit token from client header
  if (explicitTokenOrKey && !explicitTokenOrKey.trim().startsWith('{')) {
    return explicitTokenOrKey.trim()
  }
  // 2. Env token
  if (process.env.GCS_ACCESS_TOKEN) {
    return process.env.GCS_ACCESS_TOKEN.trim()
  }

  // 3. Service Account JSON key (from header, env, or file)
  let saJsonStr = null
  if (explicitTokenOrKey && explicitTokenOrKey.trim().startsWith('{')) {
    saJsonStr = explicitTokenOrKey.trim()
  } else if (process.env.GCS_SERVICE_ACCOUNT_JSON) {
    saJsonStr = process.env.GCS_SERVICE_ACCOUNT_JSON
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      if (fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
        saJsonStr = fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf-8')
      } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS.trim().startsWith('{')) {
        saJsonStr = process.env.GOOGLE_APPLICATION_CREDENTIALS
      }
    } catch {
      // Continue if file reading fails
    }
  }

  if (!saJsonStr) return null

  try {
    const sa = JSON.parse(saJsonStr)
    if (!sa.client_email || !sa.private_key) return null

    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/devstorage.read_write',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    })).toString('base64url')

    const signer = crypto.createSign('RSA-SHA256')
    signer.update(`${header}.${payload}`)
    const signature = signer.sign(sa.private_key, 'base64url')
    const jwt = `${header}.${payload}.${signature}`

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    })

    if (!res.ok) {
      console.warn('Google OAuth token exchange failed:', await res.text())
      return null
    }

    const data = await res.json()
    return data.access_token || null
  } catch (err) {
    console.warn('Service Account token minting error:', err)
    return null
  }
}

function gcsStoragePlugin() {
  return {
    name: 'gcs-storage',
    configureServer(server) {
      setupGcsRoutes(server.middlewares)
    },
    configurePreviewServer(server) {
      setupGcsRoutes(server.middlewares)
    },
  }
}

function setupGcsRoutes(middlewares) {
  // Check GCS Credentials & Bucket Configuration Status
  middlewares.use('/api/gcs-status', async (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    const hasEnvToken = Boolean(process.env.GCS_ACCESS_TOKEN)
    const hasEnvSa = Boolean(process.env.GCS_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS)

    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      bucket: GCS_BUCKET,
      projectId: GCS_PROJECT_ID,
      baseFolder: GCS_BASE_PATH,
      allowedCategories: ALLOWED_CATEGORIES,
      hasEnvCredentials: hasEnvToken || hasEnvSa,
      credentialsType: hasEnvToken ? 'access_token' : (hasEnvSa ? 'service_account' : 'none'),
      consoleUrl: `https://console.cloud.google.com/storage/browser/${GCS_BUCKET}/${GCS_BASE_PATH}?pageState=(%22StorageObjectListTable%22:(%22f%22:%22%255B%255D%22))&forceOnBucketsSortingFiltering=true&project=${GCS_PROJECT_ID}`,
    }))
  })

  // Upload PDF Template to Google Cloud Storage
  middlewares.use('/api/gcs-upload', async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    try {
      const raw = await getRequestBody(req)
      const payload = JSON.parse(raw.toString('utf-8'))
      const filename = String(payload.filename || 'template.pdf').replace(/[^a-zA-Z0-9._-]/g, '_')
      let category = String(payload.category || 'AIBT').trim()
      if (!ALLOWED_CATEGORIES.includes(category)) {
        category = 'Others'
      }

      const fileBuffer = Buffer.from(payload.fileBytesBase64, 'base64')
      if (fileBuffer.length === 0) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Empty file buffer' }))
        return
      }

      // 1. Always cache locally in public/templates/{category}/{filename} for instant fallback & preview
      const localFolder = path.join(__dirname, 'public', 'templates', category)
      fs.mkdirSync(localFolder, { recursive: true })
      const localFilePath = path.join(localFolder, filename)
      fs.writeFileSync(localFilePath, fileBuffer)
      const localUrl = `/templates/${encodeURIComponent(category)}/${encodeURIComponent(filename)}`

      // 2. Build target GCS and CDN paths
      const gcsObjectPath = `${GCS_BASE_PATH}/${category}/${filename}`
      const gcsUri = `gs://${GCS_BUCKET}/${gcsObjectPath}`
      const publicCdnUrl = `https://${GCS_BUCKET}/${gcsObjectPath}`
      const consoleUrl = `https://console.cloud.google.com/storage/browser/${GCS_BUCKET}/${GCS_BASE_PATH}/${encodeURIComponent(category)}?project=${GCS_PROJECT_ID}`
      const gcloudCommand = `gcloud storage cp "${filename}" "${gcsUri}"`

      // 3. Check for Google Cloud Storage authentication
      const explicitToken = req.headers['x-gcs-token'] || payload.customToken || ''
      const token = await getGoogleAccessToken(explicitToken)

      if (!token) {
        // No Google credentials configured
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({
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
        }))
        return
      }

      // 4. Authenticated upload directly to Google Cloud Storage REST API
      const gcsUploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(GCS_BUCKET)}/o?uploadType=media&name=${encodeURIComponent(gcsObjectPath)}`
      const gcsRes = await fetch(gcsUploadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/pdf',
        },
        body: fileBuffer,
      })

      if (gcsRes.ok) {
        const uploadResult = await gcsRes.json()
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({
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
        }))
      } else {
        const errText = await gcsRes.text()
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({
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
        }))
      }
    } catch (err) {
      console.error('GCS upload error:', err)
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: err.message }))
    }
  })

  // Sources & Templates JSON Database Registry API
  middlewares.use('/api/registry/download', async (req, res) => {
    try {
      const rootDir = path.resolve(__dirname, '..')
      const registryFile = path.join(rootDir, 'sources-and-templates.json')
      let data = {}
      if (fs.existsSync(registryFile)) {
        data = JSON.parse(fs.readFileSync(registryFile, 'utf-8'))
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', 'attachment; filename="sources-and-templates.json"')
      res.end(JSON.stringify(data, null, 2))
    } catch (err) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: err.message }))
    }
  })

  middlewares.use('/api/registry', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.statusCode = 200
      res.end()
      return
    }

    const rootDir = path.resolve(__dirname, '..')
    const registryFile = path.join(rootDir, 'sources-and-templates.json')
    const publicCopy = path.join(__dirname, 'public', 'sources-and-templates.json')

    if (req.method === 'GET') {
      try {
        if (fs.existsSync(registryFile)) {
          const data = JSON.parse(fs.readFileSync(registryFile, 'utf-8'))
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(data))
          return
        }
        res.statusCode = 404
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Registry file not found' }))
      } catch (err) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    if (req.method === 'POST') {
      try {
        const raw = await getRequestBody(req)
        const payload = JSON.parse(raw.toString('utf-8'))
        payload.lastUpdated = new Date().toISOString()
        const jsonStr = JSON.stringify(payload, null, 2)
        fs.writeFileSync(registryFile, jsonStr, 'utf-8')
        try {
          fs.writeFileSync(publicCopy, jsonStr, 'utf-8')
        } catch {
          // Ignore public copy write error if directory unavailable
        }
        console.log(`[Vite Dev Server] Successfully updated sources-and-templates.json`)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ success: true, registry: payload }))
      } catch (err) {
        console.error('[Vite Dev Server] Failed to save registry:', err)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    res.statusCode = 405
    res.end('Method Not Allowed')
  })

  // Mapping Persistence API (Filesystem /mappings directory as single source of truth)
  middlewares.use('/api/mappings', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.statusCode = 200
      res.end()
      return
    }

    const rootDir = path.resolve(__dirname, '..')
    const mappingsDir = path.join(rootDir, 'mappings')

    if (req.method === 'POST') {
      try {
        const raw = await getRequestBody(req)
        const payload = JSON.parse(raw.toString('utf-8'))
        const formId = String(payload.formId || '1')
        const templateId = String(payload.templateId || 'Template').replace(/[^a-zA-Z0-9._-]/g, '_')
        const formDir = path.join(mappingsDir, `form-${formId}`)
        fs.mkdirSync(formDir, { recursive: true })
        const targetFile = path.join(formDir, `${templateId}.json`)
        fs.writeFileSync(targetFile, JSON.stringify(payload, null, 2), 'utf-8')
        console.log(`[Vite Dev Server] Saved mapping configuration for Form #${formId} to ${targetFile}`)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ success: true, path: `mappings/form-${formId}/${templateId}.json` }))
      } catch (err) {
        console.error('[Vite Dev Server] Failed to save mapping:', err)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    if (req.method === 'GET') {
      try {
        const parsed = new URL(req.url, 'http://localhost:3000')
        const formId = parsed.searchParams.get('formId')
        const templateId = parsed.searchParams.get('templateId')

        if (formId && templateId) {
          const filePath = path.join(mappingsDir, `form-${formId}`, `${templateId}.json`)
          if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(data))
            return
          }
          // Also try checking any folder in mappings for matching formId/templateId
          if (fs.existsSync(mappingsDir)) {
            const folders = fs.readdirSync(mappingsDir)
            for (const folder of folders) {
              const fullDir = path.join(mappingsDir, folder)
              if (fs.statSync(fullDir).isDirectory()) {
                const candidate = path.join(fullDir, `${templateId}.json`)
                if (fs.existsSync(candidate)) {
                  try {
                    const data = JSON.parse(fs.readFileSync(candidate, 'utf-8'))
                    if (String(data.formId) === String(formId)) {
                      res.statusCode = 200
                      res.setHeader('Content-Type', 'application/json')
                      res.end(JSON.stringify(data))
                      return
                    }
                  } catch (err) {
                    console.debug('[Vite Dev Server] Candidate parse error:', err.message)
                  }
                }
              }
            }
          }
          res.statusCode = 404
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'Mapping not found' }))
          return
        }

        const results = []
        if (fs.existsSync(mappingsDir)) {
          const folders = fs.readdirSync(mappingsDir)
          for (const f of folders) {
            const fullDir = path.join(mappingsDir, f)
            if (fs.statSync(fullDir).isDirectory()) {
              const files = fs.readdirSync(fullDir).filter((file) => file.endsWith('.json'))
              for (const file of files) {
                try {
                  results.push(JSON.parse(fs.readFileSync(path.join(fullDir, file), 'utf-8')))
                } catch (err) {
                  console.debug('[Vite Dev Server] Mapping item parse error:', err.message)
                }
              }
            }
          }
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(results))
      } catch (err) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    res.statusCode = 405
    res.end('Method Not Allowed')
  })

  middlewares.use('/api/save-mapping', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.statusCode = 200
      res.end()
      return
    }

    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    try {
      const rootDir = path.resolve(__dirname, '..')
      const mappingsDir = path.join(rootDir, 'mappings')
      const raw = await getRequestBody(req)
      const payload = JSON.parse(raw.toString('utf-8'))
      const formId = String(payload.formId || '1')
      const templateId = String(payload.templateId || 'Template').replace(/[^a-zA-Z0-9._-]/g, '_')
      const formDir = path.join(mappingsDir, `form-${formId}`)
      fs.mkdirSync(formDir, { recursive: true })
      const targetFile = path.join(formDir, `${templateId}.json`)
      fs.writeFileSync(targetFile, JSON.stringify(payload, null, 2), 'utf-8')
      console.log(`[Vite Dev Server] Saved mapping configuration for Form #${formId} to ${targetFile}`)
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ success: true, path: `mappings/form-${formId}/${templateId}.json` }))
    } catch (err) {
      console.error('[Vite Dev Server] Failed to save mapping:', err)
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: err.message }))
    }
  })

  // Analyze Template using the original analyze-template.js logic
  middlewares.use('/api/analyze-template', async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    try {
      const raw = await getRequestBody(req)
      const payload = JSON.parse(raw.toString('utf-8'))
      const filename = payload.filename || 'template.pdf'
      const buffer = Buffer.from(payload.fileBytesBase64, 'base64')

      const result = await analyzePdfBytes(new Uint8Array(buffer), filename)
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(result))
    } catch (err) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: err.message }))
    }
  })

  // Generate Filled PDF API (Webhook & Automated Dispatch)
  middlewares.use('/api/generate-pdf', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-PDF-API-Key, ngrok-skip-browser-warning')

    if (req.method === 'OPTIONS') {
      res.statusCode = 200
      res.end()
      return
    }

    if (req.method === 'GET') {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        status: 'ready',
        endpoint: '/api/generate-pdf',
        method: 'POST',
        message: 'PDF generation webhook is operational in dev server. Send a POST request with form_id and entry data to generate filled PDFs.',
      }))
      return
    }

    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'Method Not Allowed. Use POST.' }))
      return
    }

    try {
      const raw = await getRequestBody(req)
      const payload = JSON.parse(raw.toString('utf-8'))
      const formId = String(payload.form_id || payload.formId || (payload.entry && payload.entry.form_id) || '1')
      const entryId = String(payload.entry_id || payload.entryId || (payload.entry && payload.entry.id) || '0')
      const entry = payload.entry || payload

      // Instant response for test ping
      if (entryId === 'test-ping' || payload.is_test) {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({
          success: true,
          test: true,
          message: 'Webhook Test Ping Successful! Vite dev server is active and connected.',
          form_id: formId,
        }))
        return
      }

      // 1. Locate saved mapping file
      const rootDir = path.resolve(__dirname, '..')
      const mappingsDir = path.join(rootDir, 'mappings')
      let mappingData = null

      const formDir = path.join(mappingsDir, `form-${formId}`)
      if (fs.existsSync(formDir)) {
        const files = fs.readdirSync(formDir).filter(f => f.endsWith('.json'))
        if (files.length > 0) {
          mappingData = JSON.parse(fs.readFileSync(path.join(formDir, files[0]), 'utf-8'))
        }
      }

      if (!mappingData && fs.existsSync(mappingsDir)) {
        const allItems = fs.readdirSync(mappingsDir, { recursive: true })
        for (const item of allItems) {
          if (typeof item === 'string' && item.endsWith('.json')) {
            try {
              const parsed = JSON.parse(fs.readFileSync(path.join(mappingsDir, item), 'utf-8'))
              if (String(parsed.formId) === formId) {
                mappingData = parsed
                break
              }
            } catch {
              // Ignore parse error
            }
          }
        }
      }

      if (!mappingData) {
        res.statusCode = 404
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: `No saved mapping found for Form #${formId}` }))
        return
      }

      // 2. Locate PDF Template file bytes
      let templateBytes = null
      const candidates = [
        path.join(rootDir, mappingData.templateFilename || ''),
        path.join(rootDir, `${mappingData.templateId || ''}.pdf`),
        path.join(rootDir, 'NPA_Credit Transfer Forms_V2.1.pdf'),
        path.join(__dirname, 'public', 'templates', 'NPA', mappingData.templateFilename || ''),
      ]

      for (const p of candidates) {
        if (p && fs.existsSync(p)) {
          templateBytes = fs.readFileSync(p)
          break
        }
      }

      if (!templateBytes && mappingData.templateFilename) {
        try {
          const cdnUrl = `https://storage.googleapis.com/${GCS_BUCKET}/pdf-generator/templates/NPA/${encodeURIComponent(mappingData.templateFilename)}`
          const cdnRes = await fetch(cdnUrl)
          if (cdnRes.ok) {
            templateBytes = Buffer.from(await cdnRes.arrayBuffer())
          }
        } catch (e) {
          console.warn('Could not fetch template from GCS:', e)
        }
      }

      if (!templateBytes) {
        res.statusCode = 404
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: `Template PDF file not found for ${mappingData.templateFilename || mappingData.templateId}` }))
        return
      }

      // 3. Generate filled PDF using generateFilledPdf
      const result = await generateFilledPdf({
        templateBytes: new Uint8Array(templateBytes),
        mappings: mappingData.mappings,
        submission: entry,
        flatten: false,
        attachUploadedFiles: true,
      })

      const pdfBuffer = Buffer.from(result.pdfBytes)
      const filename = `form-${formId}-entry-${entryId}.pdf`

      // Cache locally in generated/
      const generatedFolder = path.join(rootDir, 'generated')
      fs.mkdirSync(generatedFolder, { recursive: true })
      fs.writeFileSync(path.join(generatedFolder, filename), pdfBuffer)

      // Send response
      const accept = req.headers['accept'] || ''
      if (accept.includes('application/json')) {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({
          success: true,
          filename,
          filledCount: result.filledCount,
          pdfBytesBase64: pdfBuffer.toString('base64'),
        }))
        return
      }

      // Default to binary PDF stream (for WordPress file_put_contents)
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.setHeader('Content-Length', String(pdfBuffer.length))
      res.setHeader('X-Filled-Fields', String(result.filledCount || 0))
      res.end(pdfBuffer)
    } catch (err) {
      console.error('PDF Generation API error:', err)
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: err.message }))
    }
  })
}

function wpProxyPlugin() {
  return {
    name: 'wp-proxy',
    configureServer(server) {
      server.middlewares.use('/api/wp-proxy', async (req, res) => {
        try {
          const parsed = new URL(req.url, 'http://localhost:3000')
          const targetUrl = parsed.searchParams.get('url')
          const apiKey = parsed.searchParams.get('apiKey') || ''
          const basicUser = parsed.searchParams.get('basicUser') || ''
          const basicPass = parsed.searchParams.get('basicPass') || ''

          if (!targetUrl) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Missing url parameter' }))
            return
          }

          const headers = {
            Accept: '*/*',
            'ngrok-skip-browser-warning': 'true',
            'User-Agent': 'PDFMapper/1.0',
          }
          if (apiKey) {
            headers['X-PDF-API-Key'] = apiKey
          }
          if (basicUser || basicPass) {
            headers['Authorization'] = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`
          }

          let body = undefined
          if (req.method === 'POST' || req.method === 'PUT') {
            body = await getRequestBody(req)
            if (req.headers['content-type']) {
              headers['Content-Type'] = req.headers['content-type']
            }
          }

          const upstreamRes = await fetch(targetUrl, {
            method: req.method,
            headers,
            body,
          })
          const contentType = upstreamRes.headers.get('content-type') || 'application/octet-stream'
          const arrayBuffer = await upstreamRes.arrayBuffer()
          const buffer = Buffer.from(arrayBuffer)

          res.statusCode = upstreamRes.status
          res.setHeader('Content-Type', contentType)
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(buffer)
        } catch (err) {
          res.statusCode = 502
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: `Proxy failed: ${err.message}` }))
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), wpProxyPlugin(), gcsStoragePlugin()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    allowedHosts: true,
    fs: {
      allow: ['..'],
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
  },
})

