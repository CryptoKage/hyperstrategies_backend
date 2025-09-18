// /jobs/reconstructHistory.js

const pool = require('../db');
const moment = require('moment');

// ==============================================================================
// --- CONFIGURATION: EDIT THIS VALUE BEFORE RUNNING ---
// ==============================================================================
const VAULT_ID = 1;
const BASE_INDEX_VALUE = 1000.0;
// ==============================================================================

const runReconstruction = async () => {
    console.log(`--- 🛠️ Starting TRUE Historical Reconstruction for Vault #${VAULT_ID} ---`);
    const client = await pool.connect();

    try {
        await client.query('BEGIN'); // Start a single large transaction.

        // --- Step 1: Gather All Financial "Events" ---
        console.log('Step 1: Gathering all historical financial events...');
        
        // Get all deposits and withdrawals to track capital changes
        const capitalEventsResult = await client.query(
            `SELECT created_at as event_date, amount, entry_type as event_type FROM vault_ledger_entries 
             WHERE vault_id = $1 AND entry_type IN ('DEPOSIT', 'WITHDRAWAL_REQUEST')
             ORDER BY created_at ASC`,
            [VAULT_ID]
        );
        console.log(`- Found ${capitalEventsResult.rows.length} capital events (deposits/withdrawals).`);

        // Get all closed trades to track realized P&L
        const tradeEventsResult = await client.query(
            `SELECT trade_closed_at as event_date, pnl_usd as amount, 'REALIZED_PNL' as event_type FROM vault_trades 
             WHERE vault_id = $1 AND status = 'CLOSED' AND pnl_usd IS NOT NULL
             ORDER BY trade_closed_at ASC`,
            [VAULT_ID]
        );
        console.log(`- Found ${tradeEventsResult.rows.length} realized P&L events (closed trades).`);
        
        // Combine all events into a single timeline and sort chronologically
        const timeline = [...capitalEventsResult.rows, ...tradeEventsResult.rows]
            .sort((a, b) => moment(a.event_date).valueOf() - moment(b.event_date).valueOf());

        if (timeline.length === 0) {
            throw new Error('No historical events found for this vault. Cannot run reconstruction.');
        }

        // --- Step 2: Process the Event Timeline ---
        console.log('\nStep 2: Processing event timeline to calculate historical performance...');
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

            if (event.event_type === 'DEPOSIT') {
                currentCapital += eventAmount;
                console.log(`- ${eventDate.format('YYYY-MM-DD')}: Deposit of $${eventAmount.toFixed(2)}. Capital is now $${currentCapital.toFixed(2)}.`);
            } else if (event.event_type === 'WITHDRAWAL_REQUEST') {
                currentCapital += eventAmount; // Amount is negative, so this subtracts
                console.log(`- ${eventDate.format('YYYY-MM-DD')}: Withdrawal of $${eventAmount.toFixed(2)}. Capital is now $${currentCapital.toFixed(2)}.`);
            } else if (event.event_type === 'REALIZED_PNL') {
                if (currentCapital > 0) {
                    const performancePercent = eventAmount / currentCapital;
                    currentIndexValue = currentIndexValue * (1 + performancePercent);
                    console.log(`- ${eventDate.format('YYYY-MM-DD')}: Realized P&L of $${eventAmount.toFixed(2)} on capital of $${currentCapital.toFixed(2)}. Performance: ${(performancePercent * 100).toFixed(4)}%. New Index: ${currentIndexValue.toFixed(2)}.`);
                    currentCapital += eventAmount; // P&L also increases the capital base
                }
            }
            
            await saveIndexPoint(client, eventDate.toDate(), currentIndexValue);
            lastDate = eventDate;
        }

        await client.query('COMMIT');
        console.log(`\n--- ✅ Reconstruction Complete! Processed ${timeline.length} events. ---`);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ An error occurred during reconstruction, transaction has been rolled back.', error);
    } finally {
        client.release();
    }
};

async function saveIndexPoint(client, date, indexValue) {
    // We only save one point per day for the historical chart.
    const recordDate = moment.utc(date).startOf('day').toDate();
    await client.query(
        `INSERT INTO vault_performance_index (vault_id, record_date, index_value) 
         VALUES ($1, $2, $3)
         ON CONFLICT (vault_id, record_date) DO UPDATE SET index_value = EXCLUDED.index_value`,
        [VAULT_ID, recordDate, indexValue]
    );
}

module.exports = { runReconstruction };
