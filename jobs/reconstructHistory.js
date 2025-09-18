// /jobs/reconstructHistory.js

const pool = require('../db');
const moment = require('moment');

// ==============================================================================
// --- CONFIGURATION ---
// ==============================================================================
const VAULT_ID = 1;
const BASE_INDEX_VALUE = 1000.0;

// --- THE FIX: Define "Genesis" events here ---
// Add any known, unrecorded performance points to this array.
// The script will calculate the dollar amount based on the capital at that time.
const GENESIS_EVENTS = [
    {
        event_date: '2025-07-16',
        performance_percent: 5.79, // A 5.79% gain
        event_type: 'GENESIS_PNL'
    }
    // Add more here if needed, e.g., { event_date: '2025-07-20', performance_percent: -2.1, ... }
];
// ==============================================================================

const runReconstruction = async () => {
    console.log(`--- 🛠️ Starting GENESIS Historical Reconstruction for Vault #${VAULT_ID} ---`);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // --- Step 1: Gather all REAL historical events ---
        const capitalEvents = (await client.query(`SELECT created_at as event_date, amount, entry_type as event_type FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type IN ('DEPOSIT', 'WITHDRAWAL_REQUEST')`, [VAULT_ID])).rows;
        const pnlEvents = (await client.query(`SELECT created_at as event_date, SUM(amount) as amount, 'PNL_DISTRIBUTION' as event_type FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type = 'PNL_DISTRIBUTION' GROUP BY created_at`, [VAULT_ID])).rows;
        const tradeEvents = (await client.query(`SELECT trade_closed_at as event_date, pnl_usd as amount, 'REALIZED_PNL_TRADE' as event_type FROM vault_trades WHERE vault_id = $1 AND status = 'CLOSED' AND pnl_usd IS NOT NULL`, [VAULT_ID])).rows;
        
        // Combine ALL events (real and genesis) into a single timeline and sort
        const timeline = [...capitalEvents, ...pnlEvents, ...tradeEvents, ...GENESIS_EVENTS]
            .sort((a, b) => moment(a.event_date).valueOf() - moment(b.event_date).valueOf());

        if (timeline.length === 0) throw new Error('No historical events found.');

        // --- Step 2: Process the complete timeline ---
        console.log(`\nStep 2: Processing ${timeline.length} total events...`);
        let currentCapital = 0;
        let currentIndexValue = BASE_INDEX_VALUE;

        const startDate = moment(timeline[0].event_date).subtract(1, 'day');
        await saveIndexPoint(client, startDate.toDate(), currentIndexValue);

        for (const event of timeline) {
            const eventDate = moment(event.event_date);
            let eventAmount = parseFloat(event.amount);

            if (event.event_type === 'DEPOSIT' || event.event_type === 'WITHDRAWAL_REQUEST') {
                currentCapital += eventAmount;
            } else { // PNL_DISTRIBUTION, REALIZED_PNL_TRADE, or GENESIS_PNL
                
                // If it's a genesis event, calculate the dollar amount now
                if (event.event_type === 'GENESIS_PNL') {
                    eventAmount = currentCapital * (event.performance_percent / 100);
                    console.log(`- ${eventDate.format('YYYY-MM-DD')}: Injecting GENESIS PNL event of ${event.performance_percent}% ($${eventAmount.toFixed(2)})`);
                }

                if (currentCapital > 0) {
                    const performancePercent = eventAmount / currentCapital;
                    currentIndexValue = currentIndexValue * (1 + performancePercent);
                }
                currentCapital += eventAmount;
            }
            
            await saveIndexPoint(client, eventDate.toDate(), currentIndexValue);
        }

        // Fill in from the last event until today
        const lastEventDate = moment(timeline[timeline.length - 1].event_date);
        const daysUntilToday = moment().diff(lastEventDate, 'days');
        for (let i = 1; i <= daysUntilToday; i++) {
            const intermediateDate = lastEventDate.clone().add(i, 'days');
            await saveIndexPoint(client, intermediateDate.toDate(), currentIndexValue);
        }


        await client.query('COMMIT');
        console.log(`\n--- ✅ GENESIS Reconstruction Complete! Final Index: ${currentIndexValue.toFixed(2)} ---`);

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
