#!/usr/bin/env node
/**
 * create-admin.js — Standalone CLI script to create an additional administrator
 * account in the PDF Generator project.
 *
 * Safety properties:
 *   - Does NOT run migrations.
 *   - Does NOT modify existing tables or accounts.
 *   - Does NOT use an in-memory fallback.
 *   - Verifies the admin_users table and required columns exist before inserting.
 *   - Rejects duplicate email addresses (existing accounts are never altered).
 *   - Accepts at most one new account per execution.
 *   - Never prints passwords, hashes, or database credentials.
 *
 * Usage:
 *   node scripts/create-admin.js
 *
 * Required environment variable (read from .env):
 *   DATABASE_URL  or  DATABASE_URL_POOLED  or  DIRECT_DATABASE_URL
 */

import dotenv from 'dotenv';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import readline from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(rootDir, '..', '.env'), override: false, quiet: true });

const { Pool } = pg;

const BCRYPT_SALT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;
const REQUIRED_COLUMNS = [
  'id',
  'email',
  'password_hash',
  'role',
  'is_active',
  'created_at',
  'updated_at',
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getConnectionString() {
  return (
    process.env.DATABASE_URL ||
    process.env.DATABASE_URL_POOLED ||
    process.env.DIRECT_DATABASE_URL ||
    ''
  );
}

function createPool(connectionString) {
  const isNeonOrSsl =
    connectionString.includes('neon.tech') ||
    connectionString.includes('sslmode=require');
  return new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: isNeonOrSsl ? { rejectUnauthorized: false } : undefined,
  });
}

async function promptHidden(promptText) {
  process.stderr.write(promptText);
  process.stdin.resume();
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let input = '';
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          process.stdin.removeListener('data', onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stderr.write('\n');
          resolve(input);
          return;
        } else if (char === '\u0003') {
          process.stdin.removeListener('data', onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          reject(new Error('Cancelled by user (Ctrl+C)'));
          return;
        } else if (char === '\u007f' || char === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1);
          }
        } else {
          input += char;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

async function verifyAdminTable(client) {
  const tableResult = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'admin_users'`
  );

  if (tableResult.rows.length === 0) {
    return { tableExists: false, missingColumns: [], presentColumns: [] };
  }

  const colResult = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'admin_users' ORDER BY ordinal_position`
  );
  const presentColumns = colResult.rows.map((r) => r.column_name);
  const missingColumns = REQUIRED_COLUMNS.filter(
    (c) => !presentColumns.includes(c)
  );

  return { tableExists: true, missingColumns, presentColumns };
}

async function emailExists(client, email) {
  const result = await client.query(
    `SELECT id FROM admin_users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) LIMIT 1`,
    [email]
  );
  return result.rows.length > 0;
}

function generateAdminId() {
  return `admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main() {
  const connectionString = getConnectionString();
  if (!connectionString) {
    console.error('Error: Database connection string is not configured.');
    console.error('Set DATABASE_URL, DATABASE_URL_POOLED, or DIRECT_DATABASE_URL in your .env file.');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  let email = '';
  let password = '';
  let confirm = '';

  try {
    email = (await rl.question('Admin email: ')).trim().toLowerCase();

    if (!email || !EMAIL_REGEX.test(email)) {
      console.error('Error: Invalid email address.');
      process.exit(1);
    }

    password = await promptHidden('Password (min 8 characters): ');
    confirm = await promptHidden('Confirm password: ');
  } finally {
    rl.close();
  }

  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Error: Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
    process.exit(1);
  }

  if (password !== confirm) {
    console.error('Error: Passwords do not match.');
    process.exit(1);
  }

  const pool = createPool(connectionString);

  try {
    const client = await pool.connect();

    try {
      const { tableExists, missingColumns } = await verifyAdminTable(client);

      if (!tableExists) {
        console.error('Error: The admin_users table does not exist in the configured database.');
        console.error('Run the database migrations first (npm run db:migrate) to create the table.');
        process.exit(1);
      }

      if (missingColumns.length > 0) {
        console.error(
          `Error: The admin_users table is missing required columns: ${missingColumns.join(', ')}`
        );
        console.error('The table schema does not match the expected layout.');
        process.exit(1);
      }

      const exists = await emailExists(client, email);
      if (exists) {
        console.error(`Error: An administrator with email "${email}" already exists.`);
        console.error('No changes were made.');
        process.exit(1);
      }

      const salt = await bcrypt.genSalt(BCRYPT_SALT_ROUNDS);
      const passwordHash = await bcrypt.hash(password, salt);
      const adminId = generateAdminId();

      await client.query(
        `INSERT INTO admin_users (id, email, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
        [adminId, email, passwordHash, 'admin', true]
      );

      console.log('----------------------------------------------------');
      console.log('Administrator created successfully!');
      console.log(`  ID:    ${adminId}`);
      console.log(`  Email: ${email}`);
      console.log('  Role:  admin');
      console.log('----------------------------------------------------');
      console.log('The new account can now log in via the PDF Generator login screen.');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error: Failed to create administrator account.');
    if (err.code === '23505') {
      console.error(`An administrator with email "${email}" already exists.`);
    } else if (err.code === '42P01') {
      console.error('The admin_users table does not exist in the configured database.');
    } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      console.error('Could not connect to the database. Check DATABASE_URL configuration.');
    } else {
      console.error(err.message);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});