// /jobs/updateVaultPerformance.js

const pool = require('../db');
const { getPrices } = require('../utils/priceOracle');

const STOP_LOSS_PERCENTAGE = -7.1;
const BASE_INDEX_VALUE = 1000.0; // The starting value for a new vault's performance index.

const updateVaultPerformance = async () => {
  console.log('📈 Starting hourly performance index calculation job...');
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
        // --- Get all necessary data upfront ---
        const assetsResult = await client.query('SELECT symbol, contract_address, chain, coingecko_id FROM vault_assets WHERE vault_id = $1', [vaultId]);
        const vaultAssetDetails = assetsResult.rows;

        const tradesResult = await client.query('SELECT * FROM vault_trades WHERE vault_id = $1 AND status = \'OPEN\'', [vaultId]);
        let openTrades = tradesResult.rows;

        const priceMap = await getPrices(vaultAssetDetails);

        // --- TSL LOGIC (Unchanged) ---
        // (This section remains the same as before, handling automatic trade closures)
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
            console.log(`🚨 STOP LOSS TRIGGERED for trade #${trade.trade_id} (${trade.asset_symbol}).`);
            tradesToClose.push({ trade_id: trade.trade_id, exit_price: currentPrice, pnl_usd: pnl });
          }
        }
        if (tradesToClose.length > 0) {
          for (const closedTrade of tradesToClose) {
            await client.query(`UPDATE vault_trades SET status = 'CLOSED', exit_price = $1, pnl_usd = $2, trade_closed_at = NOW() WHERE trade_id = $3`, [closedTrade.exit_price, closedTrade.pnl_usd, closedTrade.trade_id]);
          }
          const closedTradeIds = new Set(tradesToClose.map(t => t.trade_id));
          openTrades = openTrades.filter(t => !closedTradeIds.has(t.trade_id));
        }
        // --- End of TSL LOGIC ---

        // --- NAV Calculation (Largely unchanged) ---
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
                    unrealizedPnl += (trade.direction === 'LONG') ? (currentPrice - entryPrice) * quantity : (entryPrice - currentPrice) * quantity;
                }
            }
        }
        const currentNav = principalCapital + realizedPnl + unrealizedPnl;
        
        // --- INDEX LOGIC: Calculate and save the new Performance Index value ---
        let newIndexValue;
        const lastIndexResult = await client.query('SELECT index_value FROM vault_performance_index WHERE vault_id = $1 ORDER BY record_date DESC LIMIT 1', [vaultId]);
        
        if (lastIndexResult.rows.length === 0) {
            // This is the first time we're calculating the index for this vault. Start it at the base value.
            newIndexValue = BASE_INDEX_VALUE;
            console.log(`[Index] First run for Vault ${vaultId}. Initializing index at ${newIndexValue}.`);
        } else {
            const lastIndexValue = parseFloat(lastIndexResult.rows[0].index_value);
            // Get the NAV from the previous hour to calculate performance, isolating from recent deposits/withdrawals.
            const lastNavResult = await client.query('SELECT total_value_locked FROM vault_performance_history WHERE vault_id = $1 ORDER BY record_date DESC LIMIT 1', [vaultId]);
            
            if (lastNavResult.rows.length > 0) {
                const lastNav = parseFloat(lastNavResult.rows[0].total_value_locked);
                // The pure performance is the change in NAV over the period.
                const hourlyPerformance = (lastNav > 0) ? ((currentNav / lastNav) - 1) : 0;
                newIndexValue = lastIndexValue * (1 + hourlyPerformance);
                console.log(`[Index] Last NAV: ${lastNav.toFixed(2)}, Current NAV: ${currentNav.toFixed(2)}, Perf: ${(hourlyPerformance * 100).toFixed(4)}%, New Index: ${newIndexValue.toFixed(4)}`);
            } else {
                // If there's an index but no history, something is wrong. Default to last known index value.
                newIndexValue = lastIndexValue;
                console.warn(`[Index] Could not find previous NAV for Vault ${vaultId}. Index will not be updated this run.`);
            }
        }
        // Insert the newly calculated index value into our new table.
        await client.query(
          `INSERT INTO vault_performance_index (vault_id, record_date, index_value) VALUES ($1, NOW(), $2)`,
          [vaultId, newIndexValue.toFixed(8)]
        );
        // --- End of INDEX LOGIC ---

        // We still save the raw NAV to the history table for auditing and other purposes.
       await client.query(
  `INSERT INTO vault_performance_history (vault_id, record_date, total_value_locked, asset_prices_snapshot) 
   VALUES ($1, NOW(), $2, $3)
   ON CONFLICT (vault_id, record_date) DO UPDATE SET 
     total_value_locked = EXCLUDED.total_value_locked,
     asset_prices_snapshot = EXCLUDED.asset_prices_snapshot`,
  [vaultId, currentNav, JSON.stringify(Object.fromEntries(priceMap))]
);
        
        await client.query('COMMIT');
        console.log(`✅ Successfully saved hourly data for Vault ID: ${vaultId}. NAV: $${currentNav.toFixed(2)}, Index: ${newIndexValue.toFixed(2)}`);
      
      } catch (innerError) {
        await client.query('ROLLBACK');
        console.error(`❌ FAILED to process Vault ID: ${vaultId}. Rolling back. Error:`, innerError.message, innerError.stack);
      }
    }
  } catch (error) {
    console.error('❌ Major error in performance calculation job:', error.message);
  } finally {
    if (client) client.release();
  }
};

module.exports = { updateVaultPerformance };
