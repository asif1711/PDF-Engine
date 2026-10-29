import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { validateWebhookApiKey } from '../database.js';

/**
 * Standard rate limiter for admin login attempts
 */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per IP per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many login attempts. Please try again in 15 minutes.',
  },
});

/**
 * Enforces an active authenticated session
 */
export function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.status(401).json({
    error: 'Authentication required. Please log in.',
    code: 'AUTH_REQUIRED',
  });
}

/**
 * Enforces an active session with 'admin' role
 */
export function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({
      error: 'Authentication required. Please log in.',
      code: 'AUTH_REQUIRED',
    });
  }

  if (req.session.userRole !== 'admin') {
    return res.status(403).json({
      error: 'Administrator access required.',
      code: 'FORBIDDEN',
    });
  }

  return next();
}

/**
 * Webhook authentication for server-to-server Gravity Forms PDF generation.
 * Supports:
 *  1. Environment-configured WEBHOOK_SECRET via constant-time comparison
 *  2. WordPress Source Connection X-PDF-API-Key configured in database/memory
 *  3. Interactive admin session when triggered from dashboard UI
 */
export async function validateWebhookAuth(req, res, next) {
  // Allow interactive admin sessions (e.g. from app UI test triggers)
  if (req.session && req.session.userId) {
    return next();
  }

  const envSecret = (process.env.WEBHOOK_SECRET || '').trim();
  const rawAuthHeader = req.headers['authorization'] || '';
  const bearerToken = rawAuthHeader.startsWith('Bearer ') ? rawAuthHeader.slice(7).trim() : '';
  const incomingKey = (req.headers['x-pdf-api-key'] || req.headers['x-webhook-secret'] || bearerToken || '').trim();

  // 1. If WEBHOOK_SECRET is configured in environment, validate with timing-safe comparison
  if (envSecret) {
    if (incomingKey && incomingKey.length === envSecret.length) {
      try {
        const a = Buffer.from(incomingKey, 'utf8');
        const b = Buffer.from(envSecret, 'utf8');
        if (crypto.timingSafeEqual(a, b)) {
          return next();
        }
      } catch {}
    }
  }

  // 2. Validate against configured WordPress Source Connection API keys in PostgreSQL
  if (incomingKey) {
    const isConnValid = await validateWebhookApiKey(incomingKey);
    if (isConnValid) {
      return next();
    }
  }

  // If no environment secret is configured and no incoming key provided, reject with 401
  return res.status(401).json({
    error: 'Unauthorized: Webhook requires a valid X-PDF-API-Key or X-Webhook-Secret credential.',
    code: 'WEBHOOK_UNAUTHORIZED',
  });
}

/**
 * Safe Origin / Referer validation for cookie-authenticated mutation endpoints
 */
export function validateCsrf(req, res, next) {
  // Safe methods do not mutate state
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Machine webhook endpoint uses token headers, not cookies
  if (req.path.startsWith('/api/generate-pdf')) {
    return next();
  }

  // Public login does not have an authenticated session yet
  if (req.path === '/api/auth/login') {
    return next();
  }

  const origin = req.headers['origin'] || '';
  const referer = req.headers['referer'] || '';
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || '';

  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost && host && originHost !== host && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
        return res.status(403).json({ error: 'CSRF validation failed: Origin mismatch.' });
      }
    } catch {
      return res.status(403).json({ error: 'CSRF validation failed: Invalid Origin.' });
    }
  } else if (referer) {
    try {
      const refererHost = new URL(referer).host;
      if (refererHost && host && refererHost !== host && !referer.includes('localhost') && !referer.includes('127.0.0.1')) {
        return res.status(403).json({ error: 'CSRF validation failed: Referer mismatch.' });
      }
    } catch {
      return res.status(403).json({ error: 'CSRF validation failed: Invalid Referer.' });
    }
  }

  return next();
}
