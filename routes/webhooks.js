// routes/webhooks.js

const express = require('express');
const router = express.Router();
const { Alchemy, Utils } = require('alchemy-sdk');
const pool = require('../db');
const { ethers } = require('ethers');
const tokenMap = require('../utils/tokens/tokenMap');

// This is your Auth Token from the Alchemy dashboard for this specific webhook
const ALCHEMY_SIGNING_KEY = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY;
if (!ALCHEMY_SIGNING_KEY) {
    console.warn("WARNING: ALCHEMY_WEBHOOK_SIGNING_KEY is not set. Webhook endpoints will not be secure.");
}

// Middleware to validate the webhook signature
const validateAlchemyWebhook = (req, res, next) => {
    if (!ALCHEMY_SIGNING_KEY) {
        console.error("Webhook validation skipped because signing key is not configured.");
        return res.status(500).send("Webhook processor not configured.");
    }
    const signature = req.headers['x-alchemy-signature'];
    const alchemy = new Alchemy(); // A temporary instance for the utility
    
    try {
        const isValid = alchemy.webhooks.isValidSignature(
            JSON.stringify(req.body),
            signature,
            ALCHEMY_SIGNING_KEY
        );
        if (isValid) {
            return next();
        }
    } catch (error) {
        console.error("Error during webhook signature validation:", error.message);
    }
    
    console.warn("Received a webhook request with an invalid signature.");
    res.status(401).send("Invalid signature");
};

router.post('/alchemy-activity', validateAlchemyWebhook, async (req, res) => {
    const webhookData = req.body;

    // We only care about mined transactions
    if (webhookData.type !== 'MINED_TRANSACTION' || !webhookData.event?.activity) {
        return res.status(200).send("Event ignored: Not a mined transaction with activity.");
    }

    const client = await pool.connect();
    try {
        for (const activity of webhookData.event.activity) {
            // Check if it's a USDC transfer we care about
            if (
                activity.category === 'erc20' &&
                activity.log && // Ensure there is log data
                activity.rawContract.address.toLowerCase() === tokenMap.usdc.address.toLowerCase()
            ) {
                const toAddress = activity.toAddress?.toLowerCase();
                const txHash = activity.hash;

                // Check if this deposit has already been processed (important for webhook retries)
                const { rows: existingDeposit } = await client.query('SELECT id FROM deposits WHERE tx_hash = $1', [txHash]);
                if (existingDeposit.length > 0) {
                    console.log(`[Webhook] Ignoring duplicate transaction: ${txHash}`);
                    continue; // Skip to the next activity
                }

                // Check if the destination address belongs to one of our users
                const { rows: userResult } = await client.query('SELECT user_id FROM users WHERE eth_address = $1', [toAddress]);

                if (userResult.length > 0) {
                    const userId = userResult[0].user_id;
                    // The amount is in hex format, e.g., '0x5f5e100'
                    const rawAmount = activity.log.data;
                    const formattedAmount = ethers.utils.formatUnits(rawAmount, tokenMap.usdc.decimals);

                    console.log(`[Webhook] Processing deposit of ${formattedAmount} USDC for user ${userId}. Tx: ${txHash}`);
                    
                    await client.query('BEGIN');
                    await client.query('INSERT INTO deposits (user_id, amount, token, tx_hash) VALUES ($1, $2, $3, $4)', [userId, formattedAmount, 'usdc', txHash]);
                    await client.query('UPDATE users SET balance = balance + $1 WHERE user_id = $2', [formattedAmount, userId]);
                    await client.query('COMMIT');
                }
            }
        }
        res.status(200).send("Webhook processed successfully.");
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error processing Alchemy webhook:', error);
        res.status(500).send("Internal server error during webhook processing.");
    } finally {
        client.release();
    }
});

module.exports = router;
