// /jobs/reconstructHistory.js

const pool = require('../db');
const moment = require('moment');

const VAULT_ID = 1;
const BASE_INDEX_VALUE = 1000.0;

const runReconstruction = async () => {
    console.log(`--- 🛠️ Starting FINAL Historical Reconstruction for Vault #${VAULT_ID} ---`);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Step 1: Gather all events
        const capitalEvents = (await client.query(`SELECT created_at as event_date, amount, entry_type as event_type FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type IN ('DEPOSIT', 'WITHDRAWAL_REQUEST')`, [VAULT_ID])).rows;
        const pnlEvents = (await client.query(`SELECT created_at as event_date, amount, 'PNL_DISTRIBUTION' as event_type FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type = 'PNL_DISTRIBUTION'`, [VAULT_ID])).rows;
        const tradeEvents = (await client.query(`SELECT trade_closed_at as event_date, pnl_usd as amount, 'REALIZED_PNL_TRADE' as event_type FROM vault_trades WHERE vault_id = $1 AND status = 'CLOSED' AND pnl_usd IS NOT NULL`, [VAULT_ID])).rows;

        const timeline = [...capitalEvents, ...pnlEvents, ...tradeEvents].sort((a, b) => moment(a.event_date).valueOf() - moment(b.event_date).valueOf());

        if (timeline.length === 0) throw new Error('No historical events found.');

        // Step 2: Process the timeline, saving EVERY event
        console.log(`\nStep 2: Processing ${timeline.length} total events...`);
        let currentCapital = 0;
        let currentIndexValue = BASE_INDEX_VALUE;

        // Save the initial starting point
        const startDate = moment(timeline[0].event_date).subtract(1, 'second');
        await client.query(`INSERT INTO vault_performance_index (vault_id, record_date, index_value) VALUES ($1, $2, $3)`, [VAULT_ID, startDate.toDate(), currentIndexValue]);

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
            
            // THE FIX: Save a point for EVERY event with its precise timestamp
            await client.query(
                `INSERT INTO vault_performance_index (vault_id, record_date, index_value) VALUES ($1, $2, $3)`,
                [VAULT_ID, eventDate.toDate(), currentIndexValue]
            );
        }

        await client.query('COMMIT');
        console.log(`\n--- ✅ FINAL Reconstruction Complete! ---`);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ An error occurred during reconstruction.', error);
    } finally {
        client.release();
    }
};

module.exports = { runReconstruction };
