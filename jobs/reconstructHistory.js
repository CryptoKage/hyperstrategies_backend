// /jobs/reconstructHistory.js

const pool = require('../db');
const moment = require('moment');

// ==============================================================================
// --- CONFIGURATION ---
// ==============================================================================
const VAULT_ID = 1;
const BASE_INDEX_VALUE = 1000.0;
// ==============================================================================

const runReconstruction = async () => {
    console.log(`--- 🛠️ Starting UNIFIED Historical Reconstruction for Vault #${VAULT_ID} ---`);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // --- Step 1: Gather ALL Historical Financial Events from ALL Sources ---
        console.log('Step 1: Gathering all historical financial events...');
        
        // Event Source 1: Capital movements (Deposits/Withdrawals)
        const capitalEventsResult = await client.query(
            `SELECT created_at as event_date, amount, entry_type as event_type FROM vault_ledger_entries 
             WHERE vault_id = $1 AND entry_type IN ('DEPOSIT', 'WITHDRAWAL_REQUEST')`,
            [VAULT_ID]
        );
        console.log(`- Found ${capitalEventsResult.rows.length} capital events.`);

        // Event Source 2: OLD P&L System (Manual Distributions)
        const manualPnlEventsResult = await client.query(
            `SELECT created_at as event_date, amount, 'PNL_DISTRIBUTION' as event_type FROM vault_ledger_entries 
             WHERE vault_id = $1 AND entry_type = 'VAULT_PNL_DISTRIBUTION'`,
            [VAULT_ID]
        );
        console.log(`- Found ${manualPnlEventsResult.rows.length} manual PNL distribution events.`);

        // Event Source 3: NEW P&L System (Closed Trades)
        const tradePnlEventsResult = await client.query(
            `SELECT trade_closed_at as event_date, pnl_usd as amount, 'REALIZED_PNL_TRADE' as event_type FROM vault_trades 
             WHERE vault_id = $1 AND status = 'CLOSED' AND pnl_usd IS NOT NULL`,
            [VAULT_ID]
        );
        console.log(`- Found ${tradePnlEventsResult.rows.length} realized PNL events from closed trades.`);
        
        // Combine all events into a single, unified timeline and sort chronologically
        const timeline = [
            ...capitalEventsResult.rows, 
            ...manualPnlEventsResult.rows, 
            ...tradePnlEventsResult.rows
        ].sort((a, b) => moment(a.event_date).valueOf() - moment(b.event_date).valueOf());

        if (timeline.length === 0) throw new Error('No historical events found.');

        // --- Step 2: Process the Unified Timeline ---
        console.log(`\nStep 2: Processing ${timeline.length} total events to calculate historical performance...`);
        let currentCapital = 0;
        let currentIndexValue = BASE_INDEX_VALUE;
        let lastDate = moment(timeline[0].event_date).subtract(1, 'day');

        for (const event of timeline) {
            const eventDate = moment(event.event_date);
            const eventAmount = parseFloat(event.amount);

            // Fill in any gaps between events with the last known index value
            const daysSinceLastEvent = eventDate.diff(lastDate, 'days');
            for (let i = 1; i < daysSinceLastEvent; i++) {
                const intermediateDate = lastDate.clone().add(i, 'days');
                await saveIndexPoint(client, intermediateDate.toDate(), currentIndexValue);
            }

            // Process the event based on its type
            if (event.event_type === 'DEPOSIT') {
                currentCapital += eventAmount;
                console.log(`- ${eventDate.format('YYYY-MM-DD')}: Deposit of $${eventAmount.toFixed(2)}. Capital base is now $${currentCapital.toFixed(2)}.`);
            } else if (event.event_type === 'WITHDRAWAL_REQUEST') {
                currentCapital += eventAmount; // Amount is negative
                console.log(`- ${eventDate.format('YYYY-MM-DD')}: Withdrawal of $${eventAmount.toFixed(2)}. Capital base is now $${currentCapital.toFixed(2)}.`);
            } else if (event.event_type === 'PNL_DISTRIBUTION' || event.event_type === 'REALIZED_PNL_TRADE') {
                if (currentCapital > 0) {
                    const performancePercent = eventAmount / currentCapital;
                    currentIndexValue = currentIndexValue * (1 + performancePercent);
                    console.log(`- ${eventDate.format('YYYY-MM-DD')}: PNL of $${eventAmount.toFixed(2)} on capital of $${currentCapital.toFixed(2)}. Perf: ${(performancePercent * 100).toFixed(4)}%. New Index: ${currentIndexValue.toFixed(2)}.`);
                    // The P&L itself also increases the capital base for the next calculation
                    currentCapital += eventAmount; 
                } else {
                    console.log(`- ${eventDate.format('YYYY-MM-DD')}: PNL event of $${eventAmount.toFixed(2)} occurred with zero capital base. Index unchanged.`);
                }
            }
            
            await saveIndexPoint(client, eventDate.toDate(), currentIndexValue);
            lastDate = eventDate;
        }

        await client.query('COMMIT');
        console.log(`\n--- ✅ UNIFIED Reconstruction Complete! ---`);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ An error occurred during reconstruction, transaction has been rolled back.', error);
    } finally {
        client.release();
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
