// /jobs/reconstructHistory.js

const pool = require('../db');
const moment = require('moment');
const { CoinGeckoClient } = require('coingecko-api-v3');

const cgClient = new CoinGeckoClient({ timeout: 15000, autoRetry: true });

const VAULT_ID = 1;
const BASE_INDEX_VALUE = 1000.0;
const ASSETS_TO_TRACK = [
    { symbol: 'BTC', coingeckoId: 'bitcoin', address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599' },
    { symbol: 'ETH', coingeckoId: 'ethereum', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
    { symbol: 'SOL', coingeckoId: 'solana', address: '0xd31a59c85ae9d8edefec411e448fd2e703a42e99' },
];

const runReconstruction = async () => {
    console.log(`--- 🛠️ Starting DEFINITIVE Historical Reconstruction for Vault #${VAULT_ID} ---`);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Step 1: Gather all data sources
        const capitalEvents = (await client.query(`SELECT created_at as event_date, amount, entry_type as event_type FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type IN ('DEPOSIT', 'WITHDRAWAL_REQUEST')`, [VAULT_ID])).rows;
        const pnlEvents = (await client.query(`SELECT created_at as event_date, SUM(amount) as amount, 'PNL_DISTRIBUTION' as event_type FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type = 'PNL_DISTRIBUTION' GROUP BY created_at`, [VAULT_ID])).rows;
        const allTrades = (await client.query('SELECT * FROM vault_trades WHERE vault_id = $1', [VAULT_ID])).rows;
        const timeline = [...capitalEvents, ...pnlEvents].sort((a, b) => moment(a.event_date).valueOf() - moment(b.event_date).valueOf());
        
        if (timeline.length === 0) throw new Error('No historical events found.');
        
        const startDate = moment(timeline[0].event_date);
        
        const priceHistories = {};
        await Promise.all(ASSETS_TO_TRACK.map(async (asset) => {
            const response = await cgClient.coinIdMarketChartRange({ id: asset.coingeckoId, vs_currency: 'usd', from: startDate.unix(), to: moment().unix() });
            priceHistories[asset.symbol] = response.prices.map(([timestamp, price]) => ({ timestamp, price }));
        }));
        
        // Step 2: Process the timeline day-by-day until today
        console.log('\nStep 2: Simulating history day-by-day...');
        let currentCapital = 0;
        let currentIndexValue = BASE_INDEX_VALUE;
        let lastRealizedPnl = 0;

        const daysToSimulate = moment().diff(startDate, 'days');

        for (let i = 0; i <= daysToSimulate; i++) {
            const currentDay = startDate.clone().add(i, 'days');
            const eventsOnThisDay = timeline.filter(e => moment(e.event_date).isSame(currentDay, 'day'));
            
            for (const event of eventsOnThisDay) {
                const eventAmount = parseFloat(event.amount);
                if (event.event_type === 'DEPOSIT' || event.event_type === 'WITHDRAWAL_REQUEST') {
                    currentCapital += eventAmount;
                } else { // PNL_DISTRIBUTION
                    if (currentCapital > 0) {
                        const performancePercent = eventAmount / currentCapital;
                        currentIndexValue *= (1 + performancePercent);
                    }
                    currentCapital += eventAmount;
                }
            }

            // --- THE FIX: Bridge the gap with UNREALIZED P&L ---
            const openOnThisDayTrades = allTrades.filter(t => moment(t.trade_opened_at).isSameOrBefore(currentDay, 'day') && t.status === 'OPEN');
            let unrealizedPnlForDay = 0;
            for (const trade of openOnThisDayTrades) {
                const priceHistory = priceHistories[trade.asset_symbol.replace('W','')]; // Handle WBTC/WETH
                const priceData = findPriceForDate(priceHistory, currentDay);
                if (priceData) {
                    const historicalPrice = priceData.price;
                    const entryPrice = parseFloat(trade.entry_price);
                    const quantity = parseFloat(trade.quantity);
                    unrealizedPnlForDay += (trade.direction === 'LONG') ? (historicalPrice - entryPrice) * quantity : (entryPrice - historicalPrice) * quantity;
                }
            }

            // We need the NAV from the last REALIZED state to calculate the performance of unrealized changes
            const realizedCapital = currentCapital - lastRealizedPnl;
            const lastNav = realizedCapital + lastRealizedPnl;
            const currentNav = realizedCapital + lastRealizedPnl + unrealizedPnlForDay;
            
            const dailyPerformance = (lastNav > 0) ? (currentNav / lastNav) - 1 : 0;
            const finalIndexForDay = currentIndexValue * (1 + dailyPerformance);

            // Save the complete snapshot for this day
            await saveDailySnapshot(client, currentDay, currentNav, finalIndexForDay, priceHistories);
        }

        await client.query('COMMIT');
        console.log(`\n--- ✅ DEFINITIVE Reconstruction Complete! ---`);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ An error occurred during reconstruction.', error);
    } finally {
        if (client.release) client.release();
    }
};

async function saveDailySnapshot(client, date, nav, indexValue, priceHistories) {
    const recordDate = moment.utc(date).startOf('day').toDate();
    const priceSnapshot = {};
    for (const asset of ASSETS_TO_TRACK) {
        const priceData = findPriceForDate(priceHistories[asset.symbol], date);
        if (priceData) {
            priceSnapshot[asset.address.toLowerCase()] = priceData.price; // THE FIX: Use the correct address
        }
    }
    await client.query(`INSERT INTO vault_performance_history (vault_id, record_date, total_value_locked, asset_prices_snapshot) VALUES ($1, $2, $3, $4) ON CONFLICT (vault_id, record_date) DO UPDATE SET total_value_locked = EXCLUDED.total_value_locked, asset_prices_snapshot = EXCLUDED.asset_prices_snapshot`, [VAULT_ID, recordDate, nav, priceSnapshot]);
    await client.query(`INSERT INTO vault_performance_index (vault_id, record_date, index_value) VALUES ($1, $2, $3) ON CONFLICT (vault_id, record_date) DO UPDATE SET index_value = EXCLUDED.index_value`, [VAULT_ID, recordDate, indexValue]);
}

function findPriceForDate(priceHistory, targetDate) {
    if (!priceHistory || priceHistory.length === 0) return null;
    const targetTimestamp = targetDate.endOf('day').valueOf();
    let closest = null;
    for (const point of priceHistory) {
        if (point.timestamp <= targetTimestamp) { closest = point; } else { break; }
    }
    return closest;
}

module.exports = { runReconstruction };
