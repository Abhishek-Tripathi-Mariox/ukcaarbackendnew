import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { config } from '../config';
import { User } from '../models';

dotenv.config();

const SEED_EMAIL = (process.env.SEED_ADMIN_EMAIL || 'admin@ukcaar.com').toLowerCase();
const SEED_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';
const SEED_PHONE = process.env.SEED_ADMIN_PHONE || '+910000000001';
const SEED_FIRST_NAME = process.env.SEED_ADMIN_FIRST_NAME || 'Super';
const SEED_LAST_NAME = process.env.SEED_ADMIN_LAST_NAME || 'Admin';

async function run() {
  await mongoose.connect(config.mongo.uri);
  console.log(`[seed] connected to ${config.mongo.uri}`);

  const existing = await User.findOne({ email: SEED_EMAIL }).select('+password');

  if (existing) {
    let changed = false;

    if (existing.role !== 'admin') {
      existing.role = 'admin';
      changed = true;
    }
    if (existing.adminRole !== 'super_admin') {
      existing.adminRole = 'super_admin';
      changed = true;
    }
    if (!existing.isActive) {
      existing.isActive = true;
      changed = true;
    }
    if (!existing.isVerified) {
      existing.isVerified = true;
      changed = true;
    }

    if (process.env.SEED_RESET_PASSWORD === 'true') {
      existing.password = SEED_PASSWORD;
      changed = true;
      console.log('[seed] resetting password (SEED_RESET_PASSWORD=true)');
    }

    if (changed) {
      await existing.save();
      console.log(`[seed] updated existing admin: ${SEED_EMAIL}`);
    } else {
      console.log(`[seed] admin already exists & is correctly configured: ${SEED_EMAIL}`);
    }
  } else {
    const admin = new User({
      firstName: SEED_FIRST_NAME,
      lastName: SEED_LAST_NAME,
      email: SEED_EMAIL,
      phone: SEED_PHONE,
      countryCode: '+91',
      password: SEED_PASSWORD,
      role: 'admin',
      adminRole: 'super_admin',
      isActive: true,
      isVerified: true,
      isProfileSetup: true,
    });
    await admin.save();
    console.log(`[seed] created super admin: ${SEED_EMAIL}`);
  }

  console.log('[seed] ──────────────────────────────────');
  console.log(`[seed] email:    ${SEED_EMAIL}`);
  console.log(`[seed] password: ${SEED_PASSWORD}`);
  console.log('[seed] ──────────────────────────────────');
  console.log('[seed] Login at the admin panel and change this password immediately.');

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
