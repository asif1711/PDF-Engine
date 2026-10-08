/**
 * Server-side credential encryption utility.
 * Uses AES-256-GCM authenticated encryption.
 * 
 * Encryption format (base64 encoded):
 * v1:iv:authTag:ciphertext
 * 
 * - v1: version identifier for future algorithm changes
 * - iv: 12-byte initialization vector (base64)
 * - authTag: 16-byte authentication tag (base64)
 * - ciphertext: encrypted payload (base64)
 * 
 * Master key: CREDENTIAL_ENCRYPTION_KEY (32 bytes, base64 or hex encoded)
 */

import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
const KEY_LENGTH = 32; // 256 bits
const VERSION = 'v1';

function getMasterKey() {
    const keyEnv = process.env.CREDENTIAL_ENCRYPTION_KEY;
    if (!keyEnv) {
        throw new Error('CREDENTIAL_ENCRYPTION_KEY environment variable is not set. Cannot encrypt/decrypt credentials.');
    }

    let keyBuffer;
    // Support both base64 and hex encoded keys
    if (keyEnv.length === 64 && /^[0-9a-fA-F]+$/.test(keyEnv)) {
        // 32 bytes = 64 hex chars
        keyBuffer = Buffer.from(keyEnv, 'hex');
    } else {
        // Assume base64
        keyBuffer = Buffer.from(keyEnv, 'base64');
    }

    if (keyBuffer.length !== KEY_LENGTH) {
        throw new Error(`CREDENTIAL_ENCRYPTION_KEY must be ${KEY_LENGTH} bytes (32 bytes). Got ${keyBuffer.length} bytes.`);
    }

    return keyBuffer;
}

/**
 * Encrypt a plaintext string (API key) using AES-256-GCM.
 * Returns a base64-encoded string containing version:iv:authTag:ciphertext.
 * @param {string} plaintext - The API key to encrypt
 * @returns {string} Base64-encoded encrypted payload
 */
export function encryptCredential(plaintext) {
    if (!plaintext || typeof plaintext !== 'string') {
        throw new Error('Cannot encrypt empty or non-string credential');
    }

    const key = getMasterKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Format: version:iv:authTag:ciphertext (all base64)
    const parts = [
        VERSION,
        iv.toString('base64'),
        authTag.toString('base64'),
        ciphertext.toString('base64'),
    ];

    return parts.join(':');
}

/**
 * Decrypt a credential encrypted with encryptCredential().
 * @param {string} encrypted - Base64-encoded encrypted payload (v1:iv:authTag:ciphertext)
 * @returns {string} Decrypted plaintext (API key)
 */
export function decryptCredential(encrypted) {
    if (!encrypted || typeof encrypted !== 'string') {
        throw new Error('Cannot decrypt empty or non-string credential');
    }

    const parts = encrypted.split(':');
    if (parts.length !== 4) {
        throw new Error('Invalid encrypted credential format: expected v1:iv:authTag:ciphertext');
    }

    const [version, ivB64, authTagB64, ciphertextB64] = parts;

    if (version !== VERSION) {
        throw new Error(`Unsupported credential encryption version: ${version}`);
    }

    const key = getMasterKey();
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');

    if (iv.length !== IV_LENGTH) {
        throw new Error(`Invalid IV length: expected ${IV_LENGTH} bytes, got ${iv.length}`);
    }
    if (authTag.length !== AUTH_TAG_LENGTH) {
        throw new Error(`Invalid auth tag length: expected ${AUTH_TAG_LENGTH} bytes, got ${authTag.length}`);
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return plaintext.toString('utf8');
}

/**
 * Check if a value appears to be an encrypted credential (our format).
 * @param {string} value - Value to check
 * @returns {boolean}
 */
export function isEncryptedCredential(value) {
    if (!value || typeof value !== 'string') return false;
    const parts = value.split(':');
    return parts.length === 4 && parts[0] === VERSION;
}