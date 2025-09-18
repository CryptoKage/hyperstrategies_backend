// /jobs/reconstructHistory.js

const pool = require('../db');
const { CoinGeckoClient } = require('coingecko-api-v3');
const moment = require('moment');

const cgClient = new CoinGeckoClient({ timeout: 15000, autoRetry: true });

// ==============================================================================
// --- CONFIGURATION: EDIT THESE VALUES BEFORE RUNNING ---
// ==============================================================================
const VAULT_ID = 1;
const START_DATE = '2025-08-15'; // Set this to the date of the very first deposit or trade.
const BASE_INDEX_VALUE = 1000.0;
// Define the assets that were part of the vault's history.
const ASSETS_TO_TRACK = [
    { symbol: 'BTC', coingeckoId: 'bitcoin' },
    { symbol: 'ETH', coingeckoId: 'ethereum' },
    { symbol: 'SOL', coingeckoId: 'solana' },
];
// ==============================================================================


const runReconstruction = async () => {
    console.log(`--- 🛠️ Starting Historical Reconstruction for Vault #${VAULT_ID} ---`);
    const client = await pool.connect();

    try {
        // --- STEP 1: GATHER ALL RAW DATA ---
        console.log('Step 1: Gathering all necessary data...');

        // Get the total principal deposited BEFORE our simulation starts.
        const initialCapitalResult = await client.query(
            `SELECT COALESCE(SUM(amount), 0) as total FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type = 'DEPOSIT' AND created_at < $2`,
            [VAULT_ID, START_DATE]
        );
        const initialCapital = parseFloat(initialCapitalResult.rows[0].total);
        console.log(`- Initial Capital before ${START_DATE}: $${initialCapital.toFixed(2)}`);

        // Get EVERY trade, open or closed, for the vault.
        const allTradesResult = await client.query('SELECT * FROM vault_trades WHERE vault_id = $1 ORDER BY trade_opened_at ASC', [VAULT_ID]);
        const allTrades = allTradesResult.rows;
        console.log(`- Found ${allTrades.length} total trades to process.`);

        // Get the complete daily price history for all assets from CoinGecko.
        const priceHistories = {};
        await Promise.all(ASSETS_TO_TRACK.map(async (asset) => {
            const response = await cgClient.coinIdMarketChartRange({
                id: asset.coingeckoId,
                vs_currency: 'usd',
                from: moment(START_DATE).unix(),
                to: moment().unix(),
            });
            priceHistories[asset.symbol] = response.prices.map(([timestamp, price]) => ({ timestamp, price }));
            console.log(`- Fetched ${priceHistories[asset.symbol].length} daily price points for ${asset.symbol}.`);
        }));

        // --- STEP 2: RUN THE DAY-BY-DAY SIMULATION ---
        console.log('\nStep 2: Starting day-by-day historical simulation...');
        await client.query('BEGIN'); // Start a single large transaction.

        const daysToSimulate = moment().diff(moment(START_DATE), 'days');
        for (let i = 0; i <= daysToSimulate; i++) {
            const currentDay = moment.utc(START_DATE).add(i, 'days');

            // Find all trades that were closed on or before this day.
            const realizedTrades = allTrades.filter(t => t.status === 'CLOSED' && moment(t.trade_closed_at).isSameOrBefore(currentDay, 'day'));
            const realizedPnl = realizedTrades.reduce((sum, trade) => sum + parseFloat(trade.pnl_usd), 0);

            // Find all trades that were open at any point during this day.
            const openOnThisDayTrades = allTrades.filter(t => 
                moment(t.trade_opened_at).isSameOrBefore(currentDay, 'day') &&
                (t.status === 'OPEN' || moment(t.trade_closed_at).isAfter(currentDay, 'day'))
            );

            let unrealizedPnl = 0;
            const priceSnapshot = {};
            for (const trade of openOnThisDayTrades) {
                const priceHistory = priceHistories[trade.asset_symbol];
                const historicalPriceData = findPriceForDate(priceHistory, currentDay);
                if (historicalPriceData) {
                    const historicalPrice = historicalPriceData.price;
                    priceSnapshot[trade.asset_symbol] = historicalPrice; // For our history table
                    
                    const entryPrice = parseFloat(trade.entry_price);
                    const quantity = parseFloat(trade.quantity);
                    unrealizedPnl += (trade.direction === 'LONG')
                        ? (historicalPrice - entryPrice) * quantity
                        : (entryPrice - historicalPrice) * quantity;
                }
            }
            
            // Calculate the total value and the performance index for this day.
            const currentNav = initialCapital + realizedPnl + unrealizedPnl;
            const performanceIndex = (initialCapital > 0) ? BASE_INDEX_VALUE * (currentNav / initialCapital) : BASE_INDEX_VALUE;

            // --- STEP 3: SAVE THE CALCULATED DATA FOR THIS DAY ---
            await client.query(
                `INSERT INTO vault_performance_history (vault_id, record_date, total_value_locked, asset_prices_snapshot) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
                [VAULT_ID, currentDay.toDate(), currentNav, priceSnapshot]
            );
            await client.query(
                `INSERT INTO vault_performance_index (vault_id, record_date, index_value) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
                [VAULT_ID, currentDay.toDate(), performanceIndex]
            );

            if (i % 30 === 0) { // Log progress
                console.log(`- Simulated up to ${currentDay.format('YYYY-MM-DD')}. NAV: $${currentNav.toFixed(2)}, Index: ${performanceIndex.toFixed(2)}`);
            }
        }

        await client.query('COMMIT'); // Commit all the daily records at once.
        console.log(`\n--- ✅ Reconstruction Complete! ---`);
        console.log(`Successfully simulated and stored ${daysToSimulate + 1} days of history.`);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ An error occurred during reconstruction, transaction has been rolled back.', error);
    } finally {
        client.release();
    }
};

// Helper function to find the closest price for a given day from the historical data.
function findPriceForDate(priceHistory, targetDate) {
    if (!priceHistory || priceHistory.length === 0) return null;
    // We want the price at the END of the target day for our calculation.
    const targetTimestamp = targetDate.endOf('day').valueOf();
    let closest = null;
    for (const point of priceHistory) {
        if (point.timestamp <= targetTimestamp) {
            closest = point;
        } else {
            break; // Stop once we pass the target date
        }
    }
    return closest;
}

module.exports = { runReconstruction };
