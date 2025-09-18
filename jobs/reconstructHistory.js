// /jobs/reconstructHistory.js

const pool = require('../db');
const moment = require('moment');

// ==============================================================================
// --- CONFIGURATION ---
// ==============================================================================
const VAULT_ID = 1;
const BASE_INDEX_VALUE = 1000.0;

// --- PRE-SEED HISTORICAL PNL HERE ---
// This is for known P&L events that are not in the database correctly.
// We calculate the dollar amount and give it a precise timestamp.
const firstDepositAmount = 1372.24; // The capital base for the first PNL
const firstPnlAmount = firstDepositAmount * 0.0579; // 5.79% gain = $79.45

const PRE_SEED_EVENTS = [
    {
        event_date: '2025-07-16 23:59:59', // Timed at the END of the day to ensure it's after the deposit
        amount: firstPnlAmount,
        event_type: 'PNL_DISTRIBUTION'
    }
];
// ==============================================================================

const runReconstruction = async () => {
    console.log(`--- 🛠️ Starting FINAL PRE-SEEDED Reconstruction for Vault #${VAULT_ID} ---`);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // --- Step 1: Gather all events ---
        const capitalEvents = (await client.query(`SELECT created_at as event_date, amount, entry_type as event_type FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type IN ('DEPOSIT', 'WITHDRAWAL_REQUEST')`, [VAULT_ID])).rows;
        const pnlEvents = (await client.query(`SELECT created_at as event_date, SUM(amount) as amount, 'PNL_DISTRIBUTION' as event_type FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type = 'PNL_DISTRIBUTION' GROUP BY created_at`, [VAULT_ID])).rows;
        const tradeEvents = (await client.query(`SELECT trade_closed_at as event_date, pnl_usd as amount, 'REALIZED_PNL_TRADE' as event_type FROM vault_trades WHERE vault_id = $1 AND status = 'CLOSED' AND pnl_usd IS NOT NULL`, [VAULT_ID])).rows;
        
        // Combine ALL events (real and pre-seeded) into a single timeline and sort
        const timeline = [...capitalEvents, ...pnlEvents, ...tradeEvents, ...PRE_SEED_EVENTS]
            .sort((a, b) => moment(a.event_date).valueOf() - moment(b.event_date).valueOf());

        if (timeline.length === 0) throw new Error('No historical events found.');

        // --- Step 2: Process the final timeline ---
        console.log(`\nStep 2: Processing ${timeline.length} total financial events...`);
        let currentCapital = 0;
        let currentIndexValue = BASE_INDEX_VALUE;

        // Save the initial starting point based on your known start date
        await saveIndexPoint(client, moment('2025-07-06').toDate(), currentIndexValue);

        for (const event of timeline) {
            const eventDate = moment(event.event_date);
            const eventAmount = parseFloat(event.amount);

            if (event.event_type === 'DEPOSIT' || event.event_type === 'WITHDRAWAL_REQUEST') {
                currentCapital += eventAmount;
            } else { // PNL_DISTRIBUTION or REALIZED_PNL_TRADE
                if (currentCapital > 0) {
                    const performancePercent = eventAmount / currentCapital;
                    currentIndexValue = currentIndexValue * (1 + performancePercent);
                }
                currentCapital += eventAmount;
            }
            
            await saveIndexPoint(client, eventDate.toDate(), currentIndexValue);
        }

        await client.query('COMMIT');
        console.log(`\n--- ✅ FINAL Reconstruction Complete! Final Index: ${currentIndexValue.toFixed(2)} ---`);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ An error occurred during reconstruction.', error);
    } finally {
        if (client.release) client.release();
    }
};

async function saveIndexPoint(client, date, indexValue) {
    const recordDate = moment.utc(date).startOf('day').toDate();
    await client.query(
        `INSERT INTO vault_performance_index (vault_id, record_date, index_value) 
         VALUES ($1, $2, $3)
         ON CONFLICT (vault_id, record_date) DO UPDATE SET index_value = EXCLUDED.index_value`,
        [VAULT_ID, recordDate, indexValue]
    );
}

module.exports = { runReconstruction };
