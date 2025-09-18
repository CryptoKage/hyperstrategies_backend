// /jobs/updateVaultPerformance.js

const pool = require('../db');
const { getPrices } = require('../utils/priceOracle');

const STOP_LOSS_PERCENTAGE = -7.1;

const updateVaultPerformance = async () => {
  console.log('📈 Starting hourly performance job (Final Version)...');
  const client = await pool.connect();
  try {
    const { rows: activeVaults } = await client.query("SELECT vault_id FROM vaults WHERE status = 'active'");
    if (activeVaults.length === 0) return;

    for (const vault of activeVaults) {
      const vaultId = vault.vault_id;
      const now = new Date();
      console.log(`--- Processing Vault ID: ${vaultId} ---`);
      
      await client.query('BEGIN');
      try {
        const assetsResult = await client.query('SELECT symbol, contract_address, chain, coingecko_id FROM vault_assets WHERE vault_id = $1', [vaultId]);
        const vaultAssetDetails = assetsResult.rows;
        let openTrades = (await client.query('SELECT * FROM vault_trades WHERE vault_id = $1 AND status = \'OPEN\'', [vaultId])).rows;
        const priceMap = await getPrices(vaultAssetDetails);

        // TSL Logic (This is correct and remains)
        const tradesToClose = [];
        for (const trade of openTrades) {
          const assetDetail = vaultAssetDetails.find(a => a.symbol.trim().toUpperCase() === trade.asset_symbol.trim().toUpperCase());
          if (!assetDetail || !assetDetail.contract_address) continue;
          const currentPrice = priceMap.get(assetDetail.contract_address.toLowerCase());
          if (typeof currentPrice !== 'number') continue;
          const entryPrice = parseFloat(trade.entry_price);
          const initialValue = parseFloat(trade.quantity) * entryPrice;
          const currentValue = parseFloat(trade.quantity) * currentPrice;
          const pnl = trade.direction === 'LONG' ? (currentValue - initialValue) : (initialValue - currentValue);
          const pnlPercentage = (initialValue > 0) ? (pnl / initialValue) * 100 : 0;
          if (pnlPercentage <= STOP_LOSS_PERCENTAGE) {
            tradesToClose.push({ trade_id: trade.trade_id, exit_price: currentPrice, pnl_usd: pnl });
          }
        }
        if (tradesToClose.length > 0) {
            for (const closedTrade of tradesToClose) {
                await client.query(`UPDATE vault_trades SET status = 'CLOSED', exit_price = $1, pnl_usd = $2, trade_closed_at = $3 WHERE trade_id = $4`, [closedTrade.exit_price, closedTrade.pnl_usd, now, closedTrade.trade_id]);
            }
        }
        
        // --- FINAL LOGIC: Calculate performance based on NAV change ---
        const principalCapital = parseFloat((await client.query(`SELECT COALESCE(SUM(amount), 0) as total FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type = 'DEPOSIT'`, [vaultId])).rows[0].total);
        const totalRealizedPnl = parseFloat((await client.query(`SELECT COALESCE(SUM(pnl_usd), 0) as total FROM vault_trades WHERE vault_id = $1 AND status = 'CLOSED'`, [vaultId])).rows[0].total);
        
        let currentUnrealizedPnl = 0;
        openTrades = (await client.query('SELECT * FROM vault_trades WHERE vault_id = $1 AND status = \'OPEN\'', [vaultId])).rows;
        for (const trade of openTrades) {
            const assetDetail = vaultAssetDetails.find(a => a.symbol.trim().toUpperCase() === trade.asset_symbol.trim().toUpperCase());
            if (assetDetail && assetDetail.contract_address) {
                const currentPrice = priceMap.get(assetDetail.contract_address.toLowerCase());
                if (typeof currentPrice === 'number') {
                    const entryPrice = parseFloat(trade.entry_price);
                    const quantity = parseFloat(trade.quantity);
                    currentUnrealizedPnl += (trade.direction === 'LONG') ? (currentPrice - entryPrice) * quantity : (entryPrice - currentPrice) * quantity;
                }
            }
        }

        const currentNav = principalCapital + totalRealizedPnl + currentUnrealizedPnl;
        
        const lastIndexResult = await client.query('SELECT index_value FROM vault_performance_index WHERE vault_id = $1 ORDER BY record_date DESC LIMIT 1', [vaultId]);
        const lastNavResult = await client.query('SELECT total_value_locked FROM vault_performance_history WHERE vault_id = $1 ORDER BY record_date DESC LIMIT 1', [vaultId]);

        if (lastIndexResult.rows.length > 0 && lastNavResult.rows.length > 0) {
            const lastIndexValue = parseFloat(lastIndexResult.rows[0].index_value);
            const lastNav = parseFloat(lastNavResult.rows[0].total_value_locked);
            const performancePercent = (lastNav > 0) ? (currentNav / lastNav) - 1 : 0;
            const newIndexValue = lastIndexValue * (1 + performancePercent);

            // Save both the new index and the new NAV
            await client.query(`INSERT INTO vault_performance_index (vault_id, record_date, index_value) VALUES ($1, $2, $3)`, [vaultId, now, newIndexValue]);
            await client.query(`INSERT INTO vault_performance_history (vault_id, record_date, total_value_locked, asset_prices_snapshot) VALUES ($1, $2, $3, $4)`, [vaultId, now, currentNav, JSON.stringify(Object.fromEntries(priceMap))]);
            console.log(`[Index] NAV changed from ${lastNav.toFixed(2)} to ${currentNav.toFixed(2)}. Perf: ${(performancePercent * 100).toFixed(4)}%. New Index: ${newIndexValue.toFixed(2)}`);
        } else {
            console.log("[Index] Cannot update. Missing last index or last NAV record.");
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
