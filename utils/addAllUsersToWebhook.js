// utils/addAllUsersToWebhook.js
require('dotenv').config();
const { Alchemy } = require('alchemy-sdk');
const { Pool } = require('pg'); // Import Pool directly

// --- NEW: Read from command-line arguments ---
const ALCHEMY_API_KEY = process.argv[2];
const WEBHOOK_ID = process.argv[3];

// --- MODIFIED: Check for either DATABASE_URL or DB_HOST ---
const connectionString = process.env.DATABASE_URL || process.env.DB_HOST;
if (!connectionString) {
    console.error('ERROR: DATABASE_URL or DB_HOST must be set in the environment.');
    process.exit(1);
}

// --- MODIFIED: Create a new pool using the connection string ---
const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});


if (!ALCHEMY_API_KEY || !WEBHOOK_ID) {
    console.error('ERROR: This script requires two arguments.');
    console.error('Usage: node utils/addAllUsersToWebhook.js <YOUR_ALCHEMY_API_KEY> <YOUR_ALCHEMY_WEBHOOK_ID>');
    process.exit(1);
}

const alchemy = new Alchemy({ apiKey: ALCHEMY_API_KEY });

async function addAddresses() {
    console.log('Fetching user addresses from the database...');
    const client = await pool.connect();
    try {
        const { rows } = await client.query("SELECT eth_address FROM users WHERE eth_address IS NOT NULL AND eth_address != ''");
        const addresses = rows.map(r => r.eth_address);

        if (addresses.length === 0) {
            console.log('No user addresses found in the database to add.');
            return;
        }

        console.log(`Found ${addresses.length} addresses. Adding them to webhook ID: ${WEBHOOK_ID}...`);

        await alchemy.notify.updateWebhook(WEBHOOK_ID, {
            addAddresses: addresses
        });
        
        console.log(`✅ Successfully added ${addresses.length} addresses to the webhook.`);

    } catch (error) {
        console.error('❌ Failed to add addresses to webhook:', error);
    } finally {
        client.release();
        pool.end();
    }
}

addAddresses();
