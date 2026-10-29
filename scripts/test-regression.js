#!/usr/bin/env node
import http from 'node:http';

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';

function request(path, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqOptions = {
      method: options.method || 'GET',
      headers: { ...(options.headers || {}) },
    };

    if (body) {
      if (typeof body === 'object') {
        reqOptions.headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
      }
      reqOptions.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = http.request(url, reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: parsed || data,
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function extractCookie(headers, cookieName) {
  const setCookie = headers['set-cookie'];
  if (!setCookie) return null;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const s of list) {
    if (s.includes(`${cookieName}=`)) return s.split(';')[0];
  }
  return null;
}

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
  }
}

async function runRegression() {
  console.log('====================================================');
  console.log('Running PDF Generator Regression Test Suite');
  console.log('====================================================\n');

  // Step 1: Login as administrator
  const loginRes = await request('/api/auth/login', { method: 'POST' }, {
    email: 'admin@vconsultancy.com.au',
    password: 'AdminSecure2026!',
  });
  assert(loginRes.status === 200, 'Admin login succeeded');
  const sessionCookie = extractCookie(loginRes.headers, 'pdf_admin_sid');
  assert(Boolean(sessionCookie), 'Acquired authenticated session cookie');

  const headers = { Cookie: sessionCookie };

  // Test 1: Template records
  console.log('\n1. Template Ingestion & Analysis Records');
  const tplRes = await request('/api/template-records', { headers });
  assert(tplRes.status === 200 && Array.isArray(tplRes.data?.templates), 'Template records load successfully from PostgreSQL');

  // Test 2: Source connections
  console.log('\n2. WordPress Source Connections');
  const connRes = await request('/api/source-connections', { headers });
  assert(connRes.status === 200 && Array.isArray(connRes.data?.connections), 'Source connections load successfully from PostgreSQL');
  assert(connRes.data?.databaseAvailable === true, 'PostgreSQL database confirmed available');

  // Test 3: Mappings
  console.log('\n3. Saved Form Mappings');
  const mapRes = await request('/api/mappings', { headers });
  assert(mapRes.status === 200 && Array.isArray(mapRes.data), 'Form mappings retrieved successfully');

  // Test 4: GCS Status
  console.log('\n4. Google Cloud Storage Integration');
  const gcsRes = await request('/api/gcs-status', { headers });
  assert(gcsRes.status === 200 && gcsRes.data?.bucket === 'vc-pdf-generator-storage', 'GCS bucket vc-pdf-generator-storage active');

  // Test 5: Automation settings
  console.log('\n5. Automation & Dispatch Settings');
  const autoRes = await request('/api/wp-automation/settings', { headers });
  assert(autoRes.status === 200 && autoRes.data?.success === true, 'Automation daemon settings loaded');

  // Test 6: Dispatch logs
  const logsRes = await request('/api/wp-dispatch-logs', { headers });
  assert(logsRes.status === 200 && logsRes.data?.success === true, 'WordPress dispatch logs accessible');

  console.log('\n====================================================');
  console.log(`Regression Results: ${passed} passed, ${failed} failed`);
  console.log('====================================================');

  if (failed > 0) process.exit(1);
}

runRegression().catch((err) => {
  console.error('Fatal regression error:', err);
  process.exit(1);
});
