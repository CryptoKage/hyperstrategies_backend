// /jobs/updateVaultPerformance.js

const pool = require('../db');
const { getPrices } = require('../utils/priceOracle');

const updateVaultPerformance = async () => {
    console.log('📈 Starting hourly UNREALIZED P&L update job (Final Version)...');
    const client = await pool.connect();
    try {
        for (const vault of (await client.query("SELECT vault_id FROM vaults WHERE status = 'active'")).rows) {
            const vaultId = vault.vault_id;
            const now = new Date();
            await client.query('BEGIN');
            try {
                const assetsResult = await client.query('SELECT symbol, contract_address FROM vault_assets WHERE vault_id = $1', [vaultId]);
                const priceMap = await getPrices(assetsResult.rows);
                const openTrades = (await client.query('SELECT * FROM vault_trades WHERE vault_id = $1 AND status = \'OPEN\'', [vaultId])).rows;
                
                let currentUnrealizedPnl = 0;
                for (const trade of openTrades) {
                    if (!trade.contract_address) {
                        console.warn(`[Warning] Skipping unrealized PNL for trade #${trade.trade_id} due to missing contract_address.`);
                        continue;
                    }
                    const price = priceMap.get(trade.contract_address.toLowerCase());
                    if (price) {
                        const entryPrice = parseFloat(trade.entry_price);
                        const quantity = parseFloat(trade.quantity);
                        currentUnrealizedPnl += (trade.direction === 'LONG') ? (price - entryPrice) * quantity : (entryPrice - price) * quantity;
                    }
                }

                const lastHistory = (await client.query('SELECT total_value_locked, unrealized_pnl FROM vault_performance_history WHERE vault_id = $1 ORDER BY record_date DESC LIMIT 1', [vaultId])).rows[0];
                const lastIndex = (await client.query('SELECT index_value FROM vault_performance_index WHERE vault_id = $1 ORDER BY record_date DESC LIMIT 1', [vaultId])).rows[0];
                
                if (lastHistory && lastIndex) {
                    const lastNav = parseFloat(lastHistory.total_value_locked);
                    const lastUnrealizedPnl = parseFloat(lastHistory.unrealized_pnl || 0);
                    const lastIndexValue = parseFloat(lastIndex.index_value);

                    const newNav = (lastNav - lastUnrealizedPnl) + currentUnrealizedPnl;
                    const performancePercent = (lastNav > 0) ? (newNav / lastNav) - 1 : 0;
                    const newIndexValue = lastIndexValue * (1 + performancePercent);
                    
                    await client.query(`INSERT INTO vault_performance_history (vault_id, record_date, total_value_locked, unrealized_pnl) VALUES ($1, $2, $3, $4)`, [vaultId, now, newNav, currentUnrealizedPnl]);
                    await client.query(`INSERT INTO vault_performance_index (vault_id, record_date, index_value) VALUES ($1, $2, $3)`, [vaultId, now, newIndexValue]);
                } else {
                    const capitalAndRealized = (await client.query(`SELECT COALESCE(SUM(amount), 0) as total FROM vault_ledger_entries WHERE vault_id = $1`, [vaultId])).rows[0].total;
                    const firstNav = parseFloat(capitalAndRealized) + currentUnrealizedPnl;
                    await client.query(`INSERT INTO vault_performance_history (vault_id, record_date, total_value_locked, unrealized_pnl) VALUES ($1, $2, $3, $4)`, [vaultId, now, firstNav, currentUnrealizedPnl]);
                }
                
                await client.query('COMMIT');
            } catch (innerError) {
                await client.query('ROLLBACK');
            }
        }
    } catch (error) {
    } finally {
        if (client.release) client.release();
    }
};
module.exports = { updateVaultPerformance };
