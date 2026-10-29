#!/usr/bin/env node
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import {
  ensureDatabaseSchema,
  countAdmins,
  createAdminUser,
  getAdminByEmail,
} from '../database.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(rootDir, '..', '.env'), override: false, quiet: true });

async function bootstrap() {
  await ensureDatabaseSchema();

  const total = await countAdmins();
  if (total > 0) {
    console.error('Error: Bootstrap aborted. An administrator account already exists in the database.');
    console.error(`Total existing administrators: ${total}`);
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const email = (process.env.INITIAL_ADMIN_EMAIL || args[0] || '').trim().toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD || args[1] || '';

  if (!email || !email.includes('@')) {
    console.error('Usage: node scripts/bootstrap-admin.js <admin-email> <admin-password>');
    console.error('   OR: INITIAL_ADMIN_EMAIL=... INITIAL_ADMIN_PASSWORD=... node scripts/bootstrap-admin.js');
    console.error('Error: A valid email address is required.');
    process.exit(1);
  }

  if (!password || password.length < 8) {
    console.error('Error: Password must be at least 8 characters long.');
    process.exit(1);
  }

  const existing = await getAdminByEmail(email);
  if (existing) {
    console.error(`Error: Administrator with email "${email}" already exists.`);
    process.exit(1);
  }

  console.log(`Creating initial administrator for ${email}...`);
  const salt = await bcrypt.genSalt(12);
  const passwordHash = await bcrypt.hash(password, salt);

  const admin = await createAdminUser({
    email,
    passwordHash,
    role: 'admin',
    isActive: true,
  });

  console.log('----------------------------------------------------');
  console.log('✓ Initial Administrator created successfully!');
  console.log(`  ID:    ${admin.id}`);
  console.log(`  Email: ${admin.email}`);
  console.log(`  Role:  ${admin.role}`);
  console.log('----------------------------------------------------');
  console.log('You can now log in via the PDF Generator web login screen.');
  process.exit(0);
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
