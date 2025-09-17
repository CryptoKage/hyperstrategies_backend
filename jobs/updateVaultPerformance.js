// PASTE THIS ENTIRE CONTENT TO REPLACE: hyperstrategies_backend/jobs/updateVaultPerformance.js

const pool = require('../db');
const fetch = require('node-fetch');
const { getAlchemyClient, resolveNetworkByName } = require('../services/alchemy');

const HYPERLIQUID_API_URL = "https://api.hyperliquid.xyz/info";

const updateVaultPerformance = async () => {
  console.log('📈 Starting hourly vault performance update job (Hybrid Oracle)...');
  const client = await pool.connect();
  try {
    const { rows: activeVaults } = await client.query("SELECT vault_id FROM vaults WHERE status = 'active'");
    if (activeVaults.length === 0) return;

    for (const vault of activeVaults) {
      const vaultId = vault.vault_id;
      console.log(`--- Processing Vault ID: ${vaultId} ---`);
      
      await client.query('BEGIN');
      try {
        const principalResult = await client.query(`SELECT COALESCE(SUM(amount), 0) as total FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type = 'DEPOSIT'`, [vaultId]);
        const principalCapital = parseFloat(principalResult.rows[0].total);

        const tradesResult = await client.query('SELECT * FROM vault_trades WHERE vault_id = $1 AND status = \'OPEN\'', [vaultId]);
        const openTrades = tradesResult.rows;
        
        const realizedPnlResult = await client.query(`SELECT COALESCE(SUM(pnl_usd), 0) as total FROM vault_trades WHERE vault_id = $1 AND status = 'CLOSED'`, [vaultId]);
        const realizedPnl = parseFloat(realizedPnlResult.rows[0].total);

        let unrealizedPnl = 0;
        
        if (openTrades.length > 0) {
          const assetsResult = await client.query('SELECT symbol, contract_address, chain FROM vault_assets WHERE vault_id = $1', [vaultId]);
          const vaultAssetDetails = assetsResult.rows;
          const priceMap = new Map();

          priceMap.set('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase(), 1.0);

          const assetsToFetch = vaultAssetDetails.filter(a => a.symbol.toUpperCase() !== 'USDC');
          if (assetsToFetch.length > 0) {
            console.log(`[Oracle] Querying Hyperliquid for symbols: ${assetsToFetch.map(a => a.symbol).join(', ')}...`);
            try {
              const response = await fetch(HYPERLIQUID_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: "allMids" }),
              });
              if (!response.ok) throw new Error(`Hyperliquid API error: ${response.statusText}`);
              const mids = await response.json();
              
              for (const asset of assetsToFetch) {
                const priceStr = mids[asset.symbol.toUpperCase()];
                if (priceStr) {
                  priceMap.set(asset.contract_address.toLowerCase(), parseFloat(priceStr));
                }
              }
            } catch (err) {
              console.error('[Oracle] Hyperliquid fetch failed:', err.message);
            }
          }
          
          console.log('[Oracle] Final Price Map:', Object.fromEntries(priceMap));

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
              } else {
                console.warn(`[PNL Calc] Final price for ${assetDetail.symbol} is missing. Skipping trade.`);
              }
            }
          }
        }

        const totalPnl = realizedPnl + unrealizedPnl;
        const netAssetValue = principalCapital + totalPnl;
        const pnlPercentage = (principalCapital > 0) ? (totalPnl / principalCapital) * 100 : 0;
        
        // ==============================================================================
        // --- FINAL UPGRADE: Save the price snapshot to the database ---
        // 1. Add asset_prices_snapshot to the INSERT statement.
        // 2. Add the priceMap as the final parameter.
        // 3. Update the ON CONFLICT clause to also update the snapshot.
        // ==============================================================================
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
        console.error(`❌ FAILED to process Vault ID: ${vaultId}. Rolling back. Error:`, innerError.message);
      }
    }
  } catch (error) {
    console.error('❌ Major error in updateVaultPerformance job:', error.message);
  } finally {
    if (client) client.release();
  }
};

module.exports = { updateVaultPerformance };
