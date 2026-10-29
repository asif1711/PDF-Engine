#!/usr/bin/env node
import http from 'node:http';

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';

function request(path, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqOptions = {
      method: options.method || 'GET',
      headers: {
        ...(options.headers || {}),
      },
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
        try {
          parsed = JSON.parse(data);
        } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: parsed || data,
          raw: data,
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
  const cookieList = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const str of cookieList) {
    if (str.includes(`${cookieName}=`)) {
      return str.split(';')[0];
    }
  }
  return null;
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('Running PDF Generator Administrator Auth Test Suite');
  console.log(`Target: ${BASE_URL}`);
  console.log('====================================================\n');

  // Test 1: Health check is public
  console.log('1. Testing Public Endpoints');
  const healthRes = await request('/api/health');
  assert(healthRes.status === 200 && healthRes.data?.status === 'ok', 'GET /api/health is accessible without auth (200 OK)');

  // Test 2: Protected endpoints without auth return 401
  console.log('\n2. Testing Protected API Route Guards');
  const unauthMe = await request('/api/auth/me');
  assert(unauthMe.status === 401, 'GET /api/auth/me returns 401 Unauthorized when unauthenticated');

  const unauthSources = await request('/api/source-connections');
  assert(unauthSources.status === 401, 'GET /api/source-connections returns 401 Unauthorized without session');

  const unauthGcs = await request('/api/gcs-status');
  assert(unauthGcs.status === 401, 'GET /api/gcs-status returns 401 Unauthorized without session');

  const unauthMappings = await request('/api/mappings');
  assert(unauthMappings.status === 401, 'GET /api/mappings returns 401 Unauthorized without session');

  // Test 3: Webhook endpoint without credentials returns 401
  console.log('\n3. Testing WordPress Webhook Protection');
  const unauthWebhook = await request('/api/generate-pdf', { method: 'POST' }, { form_id: '1', entry_id: 'test' });
  assert(unauthWebhook.status === 401, 'POST /api/generate-pdf rejects unauthenticated callers with 401');

  // Test 4: Webhook with test ping and valid source API key passes
  const validWebhookPing = await request(
    '/api/generate-pdf',
    {
      method: 'POST',
      headers: {
        'X-PDF-API-Key': 'At7CNl3XTeavXgUnZUlo215y',
      },
    },
    { form_id: '1', entry_id: 'test-ping', is_test: true }
  );
  assert(
    validWebhookPing.status === 200 && validWebhookPing.data?.success === true,
    'POST /api/generate-pdf succeeds for WordPress callers with valid X-PDF-API-Key'
  );

  // Test 5: Login with invalid credentials returns 401
  console.log('\n4. Testing Login & Authentication Flow');
  const invalidLogin = await request('/api/auth/login', { method: 'POST' }, {
    email: 'admin@vconsultancy.com.au',
    password: 'WrongPassword123!',
  });
  assert(invalidLogin.status === 401, 'POST /api/auth/login rejects wrong password with 401');
  assert(!invalidLogin.data?.password_hash, 'Password hash is NEVER leaked in login error');

  // Test 6: Login with valid credentials
  const validLogin = await request('/api/auth/login', { method: 'POST' }, {
    email: 'admin@vconsultancy.com.au',
    password: 'AdminSecure2026!',
  });
  assert(validLogin.status === 200, 'POST /api/auth/login succeeds with valid credentials (200 OK)');
  assert(validLogin.data?.user?.email === 'admin@vconsultancy.com.au', 'User profile returned with email');
  assert(!validLogin.data?.user?.password_hash, 'Password hash is omitted from sanitized user object');

  const sessionCookie = extractCookie(validLogin.headers, 'pdf_admin_sid');
  assert(Boolean(sessionCookie), 'Secure session cookie (pdf_admin_sid) issued on login');

  // Test 7: Verify session cookie allows access to /api/auth/me
  console.log('\n5. Testing Authenticated Session State');
  const authMe = await request('/api/auth/me', {
    headers: {
      Cookie: sessionCookie,
    },
  });
  assert(authMe.status === 200 && authMe.data?.authenticated === true, 'GET /api/auth/me returns 200 OK with authenticated session');
  assert(authMe.data?.user?.email === 'admin@vconsultancy.com.au', 'Session accurately identifies admin user');

  // Test 8: Verify session cookie unlocks protected endpoints
  const authSources = await request('/api/source-connections', {
    headers: {
      Cookie: sessionCookie,
    },
  });
  assert(authSources.status === 200, 'GET /api/source-connections succeeds with valid session cookie');

  const authGcs = await request('/api/gcs-status', {
    headers: {
      Cookie: sessionCookie,
    },
  });
  assert(authGcs.status === 200, 'GET /api/gcs-status succeeds with valid session cookie');

  // Test 9: Logout destroys session
  console.log('\n6. Testing Session Destruction & Logout');
  const logoutRes = await request('/api/auth/logout', {
    method: 'POST',
    headers: {
      Cookie: sessionCookie,
    },
  });
  assert(logoutRes.status === 200, 'POST /api/auth/logout returns 200 OK');

  // Test 10: Reusing destroyed session returns 401
  const reuseRes = await request('/api/auth/me', {
    headers: {
      Cookie: sessionCookie,
    },
  });
  assert(reuseRes.status === 401, 'Reusing destroyed session cookie returns 401 Unauthorized');

  console.log('\n====================================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
