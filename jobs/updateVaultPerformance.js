// /jobs/updateVaultPerformance.js

const pool = require('../db');
const { getPrices } = require('../utils/priceOracle');

const updateVaultPerformance = async () => {
    console.log('📈 Starting hourly UNREALIZED P&L update job (Final Version)...');
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
                    // --- THE FIX for the crash ---
                    if (!trade.contract_address) {
                        console.warn(`[Warning] Skipping trade #${trade.trade_id} due to missing contract_address.`);
                        continue;
                    }
                    // --- END OF FIX ---

                    const price = priceMap.get(trade.contract_address.toLowerCase());
                    if (price) {
                        const entryPrice = parseFloat(trade.entry_price);
                        const quantity = parseFloat(trade.quantity);
                        currentUnrealizedPnl += (trade.direction === 'LONG') ? (price - entryPrice) * quantity : (entryPrice - price) * quantity;
                    }
                }

                // 2. Get the LAST total NAV and LAST index value
                const lastHistory = (await client.query('SELECT total_value_locked, unrealized_pnl FROM vault_performance_history WHERE vault_id = $1 ORDER BY record_date DESC LIMIT 1', [vaultId])).rows[0];
                const lastIndex = (await client.query('SELECT index_value FROM vault_performance_index WHERE vault_id = $1 ORDER BY record_date DESC LIMIT 1', [vaultId])).rows[0];
                
                if (lastHistory && lastIndex) {
                    const lastNav = parseFloat(lastHistory.total_value_locked);
                    const lastUnrealizedPnl = parseFloat(lastHistory.unrealized_pnl || 0);
                    const lastIndexValue = parseFloat(lastIndex.index_value);

                    // 3. Calculate the new NAV by adjusting for the CHANGE in unrealized P&L
                    const newNav = (lastNav - lastUnrealizedPnl) + currentUnrealizedPnl;
                    const performancePercent = (lastNav > 0) ? (newNav / lastNav) - 1 : 0;
                    const newIndexValue = lastIndexValue * (1 + performancePercent);
                    
                    // 4. Save the new state
                    await client.query(`INSERT INTO vault_performance_history (vault_id, record_date, total_value_locked, unrealized_pnl) VALUES ($1, $2, $3, $4)`, [vaultId, now, newNav, currentUnrealizedPnl]);
                    await client.query(`INSERT INTO vault_performance_index (vault_id, record_date, index_value) VALUES ($1, $2, $3)`, [vaultId, now, newIndexValue]);
                    console.log(`[Index] NAV changed from ${lastNav.toFixed(2)} to ${newNav.toFixed(2)}. New Index: ${newIndexValue.toFixed(2)}`);
                } else {
                    // This case happens on the very first run after a reconstruction. It populates the initial history record.
                    const principalCapital = parseFloat((await client.query(`SELECT COALESCE(SUM(amount), 0) as total FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type = 'DEPOSIT'`, [vaultId])).rows[0].total);
                    const totalRealizedPnl = parseFloat((await client.query(`SELECT COALESCE(SUM(pnl_usd), 0) as total FROM vault_trades WHERE vault_id = $1 AND status = 'CLOSED'`, [vaultId])).rows[0].total) +
                                         parseFloat((await client.query(`SELECT COALESCE(SUM(amount), 0) as total FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type = 'PNL_DISTRIBUTION'`, [vaultId])).rows[0].total);
                    const firstNav = principalCapital + totalRealizedPnl + currentUnrealizedPnl;
                    await client.query(`INSERT INTO vault_performance_history (vault_id, record_date, total_value_locked, unrealized_pnl) VALUES ($1, $2, $3, $4)`, [vaultId, now, firstNav, currentUnrealizedPnl]);
                    console.log('[Index] First live run after reconstruction. Seeding history table.');
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
        if (client.release) client.release();
    }
};

module.exports = { updateVaultPerformance };
