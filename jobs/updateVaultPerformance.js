// /jobs/updateVaultPerformance.js

const pool = require('../db');
const { getPrices } = require('../utils/priceOracle');

const updateVaultPerformance = async () => {
    console.log('📈 Starting hourly UNREALIZED P&L update job...');
    const client = await pool.connect();
    try {
        const { rows: activeVaults } = await client.query("SELECT vault_id FROM vaults WHERE status = 'active'");
        if (activeVaults.length === 0) return;

        for (const vault of activeVaults) {
            const vaultId = vault.vault_id;
            const now = new Date();
            
            await client.query('BEGIN');
            try {
                // 1. Calculate CURRENT unrealized P&L
                const assetsResult = await client.query('SELECT symbol, contract_address FROM vault_assets WHERE vault_id = $1', [vaultId]);
                const priceMap = await getPrices(assetsResult.rows);
                const openTrades = (await client.query('SELECT * FROM vault_trades WHERE vault_id = $1 AND status = \'OPEN\'', [vaultId])).rows;
                
                let currentUnrealizedPnl = 0;
                for (const trade of openTrades) {
                    const price = priceMap.get(trade.contract_address.toLowerCase());
                    if (price) {
                        const entryPrice = parseFloat(trade.entry_price);
                        const quantity = parseFloat(trade.quantity);
                        currentUnrealizedPnl += (trade.direction === 'LONG') ? (price - entryPrice) * quantity : (entryPrice - price) * quantity;
                    }
                }

                // 2. Get the LAST total NAV and LAST index value
                const lastHistory = (await client.query('SELECT total_value_locked FROM vault_performance_history WHERE vault_id = $1 ORDER BY record_date DESC LIMIT 1', [vaultId])).rows[0];
                const lastIndex = (await client.query('SELECT index_value FROM vault_performance_index WHERE vault_id = $1 ORDER BY record_date DESC LIMIT 1', [vaultId])).rows[0];
                
                if (lastHistory && lastIndex) {
                    const lastNav = parseFloat(lastHistory.total_value_locked);
                    const lastIndexValue = parseFloat(lastIndex.index_value);

                    // 3. Calculate the new NAV and the performance change
                    const principalAndRealized = lastNav - (lastHistory.unrealized_pnl || 0); // Isolate the stable part of NAV
                    const newNav = principalAndRealized + currentUnrealizedPnl;
                    const performancePercent = (lastNav > 0) ? (newNav / lastNav) - 1 : 0;
                    const newIndexValue = lastIndexValue * (1 + performancePercent);
                    
                    // 4. Save the new state
                    await client.query(`INSERT INTO vault_performance_history (vault_id, record_date, total_value_locked, unrealized_pnl) VALUES ($1, $2, $3, $4)`, [vaultId, now, newNav, currentUnrealizedPnl]);
                    await client.query(`INSERT INTO vault_performance_index (vault_id, record_date, index_value) VALUES ($1, $2, $3)`, [vaultId, now, newIndexValue]);
                    console.log(`[Index] Unrealized P&L change caused NAV to move from ${lastNav.toFixed(2)} to ${newNav.toFixed(2)}. New Index: ${newIndexValue.toFixed(2)}`);
                } else {
                    console.log('[Index] No prior history found. The reconstructHistory job should be run first.');
                }
                
                await client.query('COMMIT');
            } catch (innerError) {
                await client.query('ROLLBACK');
                console.error(`❌ FAILED to process Vault ID: ${vaultId}.`, innerError);
            }
        }
    } catch (error) {
        console.error('❌ Major error in performance job:', error);
    } finally {
        if (client) client.release();
    }
};

module.exports = { updateVaultPerformance };
