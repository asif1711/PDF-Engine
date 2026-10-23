import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const GCS_BUCKET = (process.env.GCS_BUCKET_NAME && process.env.GCS_BUCKET_NAME !== 'cdn.vconsultancy.com.au') ? process.env.GCS_BUCKET_NAME : 'vc-pdf-generator-storage';
const GCS_PROJECT_ID = process.env.GCS_PROJECT_ID || 'aibt-244204';
const GCS_BASE_PATH = 'templates';
const GCS_GENERATED_PATH = 'generated';

let customBucket = null;
let customProjectId = null;

// In-memory cache for minted Google Cloud OAuth2 tokens
let cachedToken = null;
let cachedTokenExpiry = 0;
let inMemoryServiceAccountKey = null;

export function setGcsBucket(bucket) {
  if (bucket && typeof bucket === 'string') {
    customBucket = bucket.trim();
  }
}

export function setGcsProjectId(projectId) {
  if (projectId && typeof projectId === 'string') {
    customProjectId = projectId.trim();
  }
}

export function setInMemoryServiceAccountKey(key) {
  if (key) {
    inMemoryServiceAccountKey = key;
    try {
      const parsed = typeof key === 'string' ? JSON.parse(key) : key;
      if (parsed?.project_id && !customProjectId && !process.env.GCS_PROJECT_ID) {
        customProjectId = parsed.project_id;
      }
    } catch {}
  }
}

export function getGcsConfig(overrideBucket = null, overrideProjectId = null) {
  const envBucket = process.env.GCS_BUCKET_NAME;
  const defaultBucket = (!envBucket || envBucket === 'cdn.vconsultancy.com.au') ? 'vc-pdf-generator-storage' : envBucket;
  const bucket = overrideBucket || customBucket || defaultBucket;
  const projectId = overrideProjectId || customProjectId || process.env.GCS_PROJECT_ID || 'aibt-244204';
  const hasEnvToken = Boolean(process.env.GCS_ACCESS_TOKEN);
  const hasEnvSa = Boolean(process.env.GCS_SERVICE_ACCOUNT_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS);
  const hasMemorySa = Boolean(inMemoryServiceAccountKey);

  return {
    bucket,
    projectId,
    basePath: GCS_BASE_PATH,
    generatedPath: GCS_GENERATED_PATH,
    hasEnvCredentials: hasEnvToken || hasEnvSa || hasMemorySa,
    credentialsType: hasEnvSa || hasMemorySa ? 'service_account' : hasEnvToken ? 'access_token' : 'none',
    consoleUrl: `https://console.cloud.google.com/storage/browser/${bucket}/${GCS_GENERATED_PATH}?project=${projectId}`,
  };
}

/**
 * Mint Google OAuth2 Bearer Access Token using Service Account JSON credentials.
 */
async function mintTokenFromServiceAccount(saCredentials) {
  let sa = saCredentials;
  if (typeof sa === 'string') {
    try {
      sa = JSON.parse(sa);
    } catch {
      // Try base64 decoding if not direct JSON
      try {
        sa = JSON.parse(Buffer.from(sa, 'base64').toString('utf8'));
      } catch (err) {
        throw new Error('Invalid Service Account JSON credentials: ' + err.message);
      }
    }
  }

  if (!sa || !sa.client_email || !sa.private_key) {
    throw new Error('Service Account JSON missing client_email or private_key.');
  }

  // Return cached token if still valid (with 60-second buffer)
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedTokenExpiry > now + 60) {
    return cachedToken;
  }

  const exp = now + 3600;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/devstorage.read_write https://www.googleapis.com/auth/cloud-platform',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    exp,
    iat: now,
  };

  const b64Url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsignedToken = `${b64Url(header)}.${b64Url(claimSet)}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedToken);
  signer.end();
  const signature = signer.sign(sa.private_key, 'base64url');

  const signedJwt = `${unsignedToken}.${signature}`;

  const tokenRes = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedJwt,
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Google OAuth2 token exchange failed (HTTP ${tokenRes.status}): ${errText}`);
  }

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error('Token response did not include access_token');
  }

  cachedToken = tokenData.access_token;
  cachedTokenExpiry = exp;
  return cachedToken;
}

/**
 * Retrieve a valid Google Cloud Access Token from:
 * 1. Explicit token
 * 2. Service Account JSON key (passed in or from memory or from environment)
 * 3. GCS_ACCESS_TOKEN
 */
export async function getGoogleAccessToken(explicitToken, serviceAccountInput = null) {
  // 1. Explicit Bearer token
  if (explicitToken && typeof explicitToken === 'string' && explicitToken.trim()) {
    return explicitToken.trim();
  }

  // 2. Explicit Service Account input passed from request / client
  if (serviceAccountInput) {
    try {
      const token = await mintTokenFromServiceAccount(serviceAccountInput);
      if (token) {
        inMemoryServiceAccountKey = serviceAccountInput;
        return token;
      }
    } catch (err) {
      console.warn('[GCP Auth] Failed to mint token from provided service account:', err.message);
    }
  }

  // 3. In-memory cached Service Account key (saved from UI earlier)
  if (inMemoryServiceAccountKey) {
    try {
      const token = await mintTokenFromServiceAccount(inMemoryServiceAccountKey);
      if (token) return token;
    } catch (err) {
      console.warn('[GCP Auth] Failed to mint token from stored service account:', err.message);
    }
  }

  // 4. Environment: GCS_SERVICE_ACCOUNT_KEY
  if (process.env.GCS_SERVICE_ACCOUNT_KEY) {
    try {
      const token = await mintTokenFromServiceAccount(process.env.GCS_SERVICE_ACCOUNT_KEY);
      if (token) return token;
    } catch (err) {
      console.warn('[GCP Auth] Failed to mint token from GCS_SERVICE_ACCOUNT_KEY env:', err.message);
    }
  }

  // 5. Environment: GOOGLE_APPLICATION_CREDENTIALS file path
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (fs.existsSync(credPath)) {
        const fileContent = fs.readFileSync(credPath, 'utf8');
        const token = await mintTokenFromServiceAccount(fileContent);
        if (token) return token;
      }
    } catch (err) {
      console.warn('[GCP Auth] Failed to mint token from GOOGLE_APPLICATION_CREDENTIALS file:', err.message);
    }
  }

  // 6. Environment: GCS_ACCESS_TOKEN
  if (process.env.GCS_ACCESS_TOKEN && process.env.GCS_ACCESS_TOKEN.trim()) {
    return process.env.GCS_ACCESS_TOKEN.trim();
  }

  return null;
}

/**
 * Upload a binary buffer to Google Cloud Storage.
 */
export async function uploadBufferToGcs({
  bucket = GCS_BUCKET,
  objectPath,
  buffer,
  contentType = 'application/pdf',
  token,
}) {
  const gcsUploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectPath)}`;

  const res = await fetch(gcsUploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
    },
    body: buffer,
  });

  if (res.ok) {
    const data = await res.json();
    return { ok: true, data };
  } else {
    const errorText = await res.text();
    return { ok: false, status: res.status, errorText };
  }
}

/**
 * List objects from Google Cloud Storage in a specific folder/prefix.
 */
export async function listGcsFolderObjects({
  bucket = GCS_BUCKET,
  prefix = GCS_GENERATED_PATH,
  token = null,
}) {
  const cleanPrefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '') + '/';
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?prefix=${encodeURIComponent(cleanPrefix)}`;
  const headers = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const errorText = await res.text();
    return { ok: false, status: res.status, error: errorText, items: [] };
  }

  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  return { ok: true, items };
}

/**
 * Delete an object from Google Cloud Storage.
 */
export async function deleteGcsObject({
  bucket = GCS_BUCKET,
  objectPath,
  token = null,
}) {
  const cleanPath = objectPath.replace(/^\/+/, '');
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(cleanPath)}`;
  const headers = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, { method: 'DELETE', headers });
  return { ok: res.ok, status: res.status };
}

