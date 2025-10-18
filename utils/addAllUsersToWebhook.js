// utils/addAllUsersToWebhook.js
require('dotenv').config();
const { Alchemy } = require('alchemy-sdk');
const { Pool } = require('pg');

const ALCHEMY_API_KEY = process.argv[2];
const WEBHOOK_ID = process.argv[3];

// --- NEW, ROBUST CONNECTION LOGIC ---
// Render provides individual components. Let's use them.
const dbConfig = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
  ssl: {
    rejectUnauthorized: false
  }
};

if (!dbConfig.host || !dbConfig.user || !dbConfig.password || !dbConfig.database) {
    console.error('ERROR: Missing one or more required database environment variables: DB_USER, DB_HOST, DB_NAME, DB_PASSWORD');
    process.exit(1);
}
// --- END NEW LOGIC ---

const pool = new Pool(dbConfig);

if (!ALCHEMY_API_KEY || !WEBHOOK_ID) {
    console.error('ERROR: Script requires arguments: <API_KEY> <WEBHOOK_ID>');
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
            console.log('No user addresses found.');
            return;
        }

        console.log(`Found ${addresses.length} addresses. Adding to webhook: ${WEBHOOK_ID}...`);
        await alchemy.notify.updateWebhook(WEBHOOK_ID, { addAddresses: addresses });
        console.log(`✅ Successfully added ${addresses.length} addresses.`);

    } catch (error) {
        console.error('❌ Failed to add addresses to webhook:', error);
    } finally {
        client.release();
        pool.end();
    }
}

addAddresses();
