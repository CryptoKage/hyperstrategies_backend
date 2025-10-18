// scripts/addAllUsersToWebhook.js
require('dotenv').config();
const { Alchemy } = require('alchemy-sdk');
const pool = require('../db');

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const WEBHOOK_ID = process.env.ALCHEMY_WEBHOOK_ID; // You'll need to get this from the Alchemy dashboard URL

if (!ALCHEMY_API_KEY || !WEBHOOK_ID) {
    console.error('ERROR: ALCHEMY_API_KEY and ALCHEMY_WEBHOOK_ID must be set in your .env file.');
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

        // This replaces the entire list of addresses on the webhook
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
