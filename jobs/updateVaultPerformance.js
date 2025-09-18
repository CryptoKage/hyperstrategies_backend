// /jobs/updateVaultPerformance.js

const pool = require('../db');
const { getPrices } = require('../utils/priceOracle'); // <-- 1. IMPORT our new Price Oracle

const STOP_LOSS_PERCENTAGE = -7.1; // The -7.1% threshold

const updateVaultPerformance = async () => {
  console.log('📈 Starting hourly vault performance update job...');
  const client = await pool.connect();
  try {
    const { rows: activeVaults } = await client.query("SELECT vault_id FROM vaults WHERE status = 'active'");
    if (activeVaults.length === 0) {
      console.log("No active vaults to process.");
      return;
    }

    for (const vault of activeVaults) {
      const vaultId = vault.vault_id;
      console.log(`--- Processing Vault ID: ${vaultId} ---`);
      
      await client.query('BEGIN');
      try {
        // --- Fetch all necessary data upfront ---
        const assetsResult = await client.query('SELECT symbol, contract_address, chain, coingecko_id FROM vault_assets WHERE vault_id = $1', [vaultId]);
        const vaultAssetDetails = assetsResult.rows;

        const tradesResult = await client.query('SELECT * FROM vault_trades WHERE vault_id = $1 AND status = \'OPEN\'', [vaultId]);
        let openTrades = tradesResult.rows;

        // --- Get live prices using our new centralized oracle ---
        const priceMap = await getPrices(vaultAssetDetails);

        // --- TSL LOGIC: Check for and process stop losses ---
        const tradesToClose = [];
        for (const trade of openTrades) {
          const assetDetail = vaultAssetDetails.find(a => a.symbol.trim().toUpperCase() === trade.asset_symbol.trim().toUpperCase());
          if (!assetDetail || !assetDetail.contract_address) continue;

          const currentPrice = priceMap.get(assetDetail.contract_address.toLowerCase());
          if (typeof currentPrice !== 'number') {
            console.warn(`[TSL] Skipping stop-loss check for ${trade.asset_symbol} due to missing price.`);
            continue;
          }

          const entryPrice = parseFloat(trade.entry_price);
          const initialValue = parseFloat(trade.quantity) * entryPrice;
          const currentValue = parseFloat(trade.quantity) * currentPrice;
          
          let pnl;
          if (trade.direction === 'LONG') {
            pnl = currentValue - initialValue;
          } else { // SHORT
            pnl = initialValue - currentValue;
          }

          const pnlPercentage = (initialValue > 0) ? (pnl / initialValue) * 100 : 0;

          if (pnlPercentage <= STOP_LOSS_PERCENTAGE) {
            console.log(`🚨 STOP LOSS TRIGGERED for trade #${trade.trade_id} (${trade.asset_symbol}). P&L: ${pnlPercentage.toFixed(2)}%`);
            tradesToClose.push({
              trade_id: trade.trade_id,
              exit_price: currentPrice,
              pnl_usd: pnl,
            });
          }
        }

        // --- TSL LOGIC: Batch-update the closed trades in the database ---
        if (tradesToClose.length > 0) {
          for (const closedTrade of tradesToClose) {
            await client.query(
              `UPDATE vault_trades 
               SET status = 'CLOSED', exit_price = $1, pnl_usd = $2, trade_closed_at = NOW()
               WHERE trade_id = $3`,
              [closedTrade.exit_price, closedTrade.pnl_usd, closedTrade.trade_id]
            );
          }
          // Filter out the trades we just closed so they aren't included in unrealized P&L
          const closedTradeIds = new Set(tradesToClose.map(t => t.trade_id));
          openTrades = openTrades.filter(t => !closedTradeIds.has(t.trade_id));
        }
        // --- End of TSL LOGIC ---

        // --- Recalculate P&L and NAV with remaining open trades ---
        const principalResult = await client.query(`SELECT COALESCE(SUM(amount), 0) as total FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type = 'DEPOSIT'`, [vaultId]);
        const principalCapital = parseFloat(principalResult.rows[0].total);

        const realizedPnlResult = await client.query(`SELECT COALESCE(SUM(pnl_usd), 0) as total FROM vault_trades WHERE vault_id = $1 AND status = 'CLOSED'`, [vaultId]);
        const realizedPnl = parseFloat(realizedPnlResult.rows[0].total);

        let unrealizedPnl = 0;
        for (const trade of openTrades) {
          const assetDetail = vaultAssetDetails.find(a => a.symbol.trim().toUpperCase() === trade.asset_symbol.trim().toUpperCase());
          if (assetDetail && assetDetail.contract_address) {
            const currentPrice = priceMap.get(assetDetail.contract_address.toLowerCase());
            if (typeof currentPrice === 'number') {
              const entryPrice = parseFloat(trade.entry_price);
              const quantity = parseFloat(trade.quantity);
              unrealizedPnl += (trade.direction === 'LONG') 
                ? (currentPrice - entryPrice) * quantity 
                : (entryPrice - currentPrice) * quantity;
            }
          }
        }

        const totalPnl = realizedPnl + unrealizedPnl;
        const netAssetValue = principalCapital + totalPnl;
        const pnlPercentage = (principalCapital > 0) ? (totalPnl / principalCapital) * 100 : 0;
        
        await client.query(
          `INSERT INTO vault_performance_history (vault_id, record_date, pnl_percentage, total_value_locked, asset_prices_snapshot) 
           VALUES ($1, NOW(), $2, $3, $4)
           ON CONFLICT (vault_id, record_date) DO UPDATE SET 
             pnl_percentage = EXCLUDED.pnl_percentage, 
             total_value_locked = EXCLUDED.total_value_locked,
             asset_prices_snapshot = EXCLUDED.asset_prices_snapshot`,
          [vaultId, pnlPercentage.toFixed(4), netAssetValue, JSON.stringify(Object.fromEntries(priceMap))]
        );
        
        await client.query('COMMIT');
        console.log(`✅ Successfully saved hourly performance for Vault ID: ${vaultId}. NAV: $${netAssetValue.toFixed(2)}, P&L: ${pnlPercentage.toFixed(2)}%`);
      
      } catch (innerError) {
        await client.query('ROLLBACK');
        console.error(`❌ FAILED to process Vault ID: ${vaultId}. Rolling back. Error:`, innerError.message, innerError.stack);
      }
    }
  } catch (error) {
    console.error('❌ Major error in updateVaultPerformance job:', error.message);
  } finally {
    if (client) client.release();
  }
};

module.exports = { updateVaultPerformance };
