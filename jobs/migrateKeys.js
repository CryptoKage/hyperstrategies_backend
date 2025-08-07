const crypto = require('crypto');
const pool = require('../db');
require('dotenv').config();

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || Buffer.byteLength(ENCRYPTION_KEY) !== 32) {
  throw new Error('ENCRYPTION_KEY must be a 32-byte string.');
}

// --- Function using the OLD CBC method ---
function decrypt_cbc(text) {
  const [ivHex, encryptedHex] = text.split(':');
  if (!ivHex || !encryptedHex) return null; // Handle potentially malformed old keys
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

// --- Function using the NEW GCM method ---
function encrypt_gcm(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(text, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

async function runMigration() {
  console.log('Starting private key encryption migration...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('Fetching all users with encrypted private keys...');
    const { rows: users } = await client.query(
      "SELECT user_id, eth_private_key_encrypted FROM users WHERE eth_private_key_encrypted IS NOT NULL"
    );
    console.log(`Found ${users.length} users to process.`);

    let migratedCount = 0;
    for (const user of users) {
      const oldEncryptedKey = user.eth_private_key_encrypted;
      
      // Check if the key is already in the new GCM format (iv:tag:encrypted)
      if (oldEncryptedKey.split(':').length === 3) {
        console.log(`- User ${user.user_id}: Key already migrated. Skipping.`);
        continue;
      }

      console.log(`- User ${user.user_id}: Migrating key...`);
      // 1. Decrypt with the OLD method
      const decryptedKey = decrypt_cbc(oldEncryptedKey);
      if (!decryptedKey) {
        console.warn(`  - WARNING: Could not decrypt old key for user ${user.user_id}. It might be malformed. Skipping.`);
        continue;
      }

      // 2. Encrypt with the NEW method
      const newEncryptedKey = encrypt_gcm(decryptedKey);

      // 3. Update the database
      await client.query(
        "UPDATE users SET eth_private_key_encrypted = $1 WHERE user_id = $2",
        [newEncryptedKey, user.user_id]
      );
      migratedCount++;
    }

    await client.query('COMMIT');
    console.log(`✅ Migration complete! Successfully migrated ${migratedCount} keys.`);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ MIGRATION FAILED. Database has been rolled back.', error);
  } finally {
    client.release();
    pool.end();
  }
}

runMigration();
