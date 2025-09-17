// PASTE THIS ENTIRE CONTENT INTO: hyperstrategies_backend/jobs/backfillVaultHistory.js

const { CoinGeckoClient } = require('coingecko-api-v3');
const moment = require('moment');
const pool = require('../db');

const client = new CoinGeckoClient({ timeout: 15000, autoRetry: true });

// ==============================================================================
// --- CONFIGURATION: EDIT THESE VALUES ---
// ==============================================================================
const VAULT_ID_TO_BACKFILL = 1;
// This is the total of all user deposits (principal) at the very beginning of your start date.
const STARTING_PRINCIPAL_USD = 1372.24; // Sabine's initial deposit
const START_DATE = '2025-07-16'; // The first day of trading history
const ASSET_QUANTITIES = {
    BTC: 0.2,
    ETH: 0.6,
    SOL: 0.2,
};
// ==============================================================================

async function runPnlBackfill() {
    console.log(`--- Starting Historical PNL Backfill for Vault #${VAULT_ID_TO_BACKFILL} ---`);
    console.log(`Fetching data from ${START_DATE} to present...`);

    const dbClient = await pool.connect();
    try {
        const priceData = {};
        const daysToFetch = moment().diff(moment(START_DATE), 'days');

        for (const symbol of Object.keys(ASSET_QUANTITIES)) {
            const id = symbol.toLowerCase() === 'btc' ? 'bitcoin' : symbol.toLowerCase() === 'eth' ? 'ethereum' : 'solana';
            const response = await client.coinIdMarketChartRange({
                id: id,
                vs_currency: 'usd',
                from: moment(START_DATE).unix(),
                to: moment().unix(),
            });
            priceData[symbol] = response.prices;
            console.log(`- Fetched ${response.prices.length} hourly data points for ${symbol}.`);
        }

        console.log('\nCalculating and inserting historical data points...');
        await dbClient.query('BEGIN');

        const timeline = priceData.BTC; // Use BTC as the primary timeline

        for (let i = 0; i < timeline.length; i++) {
            const timestamp = timeline[i][0];
            const recordDate = moment(timestamp).toISOString();

            const btcPrice = priceData.BTC[i][1];
            const ethPrice = findClosestPrice(priceData.ETH, timestamp);
            const solPrice = findClosestPrice(priceData.SOL, timestamp);

            if (!btcPrice || !ethPrice || !solPrice) continue;

            const totalNav = (ASSET_QUANTITIES.BTC * btcPrice) + (ASSET_QUANTITIES.ETH * ethPrice) + (ASSET_QUANTITIES.SOL * solPrice);
            // We calculate PNL based on the initial principal. This is a simplification for a smooth chart.
            const pnlPercentage = ((totalNav / STARTING_PRINCIPAL_USD) - 1) * 100;
            
            const priceSnapshot = { BTC: btcPrice, ETH: ethPrice, SOL: solPrice };

             const insertStatement = `
                INSERT INTO vault_performance_history (vault_id, record_date, pnl_percentage, total_value_locked, asset_prices_snapshot) 
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (vault_id, record_date) DO UPDATE SET
                    pnl_percentage = EXCLUDED.pnl_percentage,
                    total_value_locked = EXCLUDED.total_value_locked,
                    asset_prices_snapshot = EXCLUDED.asset_prices_snapshot;
            `;
            await dbClient.query(insertStatement, [VAULT_ID_TO_BACKFILL, recordDate, pnlPercentage.toFixed(4), totalNav.toFixed(4), priceSnapshot]);
        }

        await dbClient.query('COMMIT');
        console.log(`✅ Success! Backfill complete. ${timeline.length} data points processed.`);

    } catch (e) {
        await dbClient.query('ROLLBACK');
        console.error('❌ An error occurred during the backfill process:', e.message);
    } finally {
        dbClient.release();
    }
}


function findClosestPrice(prices, targetTimestamp) {
    // This helper function remains the same
    let closest = prices[0];
    let minDiff = Math.abs(targetTimestamp - closest[0]);
    for (let i = 1; i < prices.length; i++) {
        const diff = Math.abs(targetTimestamp - prices[i][0]);
        if (diff < minDiff) {
            minDiff = diff;
            closest = prices[i];
        }
    }
    return closest[1];
}

module.exports = { runPnlBackfill };
