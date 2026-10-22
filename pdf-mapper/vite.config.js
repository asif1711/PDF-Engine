import { Buffer } from 'node:buffer'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

function getRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
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
          const sourceConnectionId = parsed.searchParams.get('sourceConnectionId') || ''
          const basicUser = parsed.searchParams.get('basicUser') || ''
          const basicPass = parsed.searchParams.get('basicPass') || ''

          if (!targetUrl) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Missing url parameter' }))
            return
          }

          // Resolve API key from sourceConnectionId (Dev mode DB lookup)
          let resolvedApiKey = apiKey
          if (sourceConnectionId) {
            try {
              const { getSourceConnectionApiKey } = await import('../database.js')
              const dbKey = await getSourceConnectionApiKey(sourceConnectionId)
              if (dbKey) resolvedApiKey = dbKey
            } catch (dbErr) {
              console.error('[wp-proxy] Failed to resolve API key from source connection:', dbErr.message)
            }
          }

          const headers = {
            Accept: '*/*',
            'ngrok-skip-browser-warning': 'true',
            'User-Agent': 'PDFMapper/1.0',
          }
          if (resolvedApiKey) {
            headers['X-PDF-API-Key'] = resolvedApiKey
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
  plugins: [react(), wpProxyPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      }
    },
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