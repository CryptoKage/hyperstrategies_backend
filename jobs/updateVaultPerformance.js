// PASTE THIS ENTIRE CONTENT TO REPLACE: hyperstrategies_backend/jobs/updateVaultPerformance.js

const pool = require('../db');
const { getAlchemyClient } = require('../services/alchemy');

const updateVaultPerformance = async () => {
  console.log('📈 Starting hourly vault performance update job (using Alchemy Price API)...');

  let alchemy;
  try {
    alchemy = getAlchemyClient();
  } catch (err) {
    console.error('❌ Alchemy client not configured for vault performance job:', err.message || err);
    return;
  }

  const client = await pool.connect();
  try {
    const { rows: activeVaults } = await client.query("SELECT vault_id FROM vaults WHERE status = 'active'");
    if (activeVaults.length === 0) {
      console.log('No active vaults to process.');
      return;
    }

    for (const vault of activeVaults) {
      const vaultId = vault.vault_id;
      console.log(`--- Processing Vault ID: ${vaultId} ---`);
      
      await client.query('BEGIN');
      try {
        const principalResult = await client.query(
          `SELECT COALESCE(SUM(amount), 0) as total FROM vault_ledger_entries WHERE vault_id = $1 AND entry_type = 'DEPOSIT'`,
          [vaultId]
        );
        const principalCapital = parseFloat(principalResult.rows[0].total);

        const tradesResult = await client.query('SELECT * FROM vault_trades WHERE vault_id = $1', [vaultId]);
        const allTrades = tradesResult.rows;
        const realizedPnl = allTrades.filter(t => t.status === 'CLOSED').reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
        const openTrades = allTrades.filter(t => t.status === 'OPEN');
        let unrealizedPnl = 0;
        
        if (openTrades.length > 0) {
          const assetsResult = await client.query('SELECT symbol, contract_address, chain FROM vault_assets WHERE vault_id = $1', [vaultId]);
          const vaultAssetDetails = assetsResult.rows;
          const priceMap = new Map();

          const uniqueAddresses = [...new Set(vaultAssetDetails.map(a => a.contract_address).filter(Boolean))];

          if (uniqueAddresses.length > 0) {
            console.log(`[Alchemy Price] Fetching prices for ${uniqueAddresses.length} unique assets...`);
            
            // ==============================================================================
            // --- FINAL BUG FIX: Use the correct alchemy.prices.getTokensPrice method ---
            // The method is in the 'prices' namespace, not 'core'.
            // It takes an array of addresses and returns their prices.
            // ==============================================================================
            try {
              const priceData = await alchemy.prices.getTokensPrice(uniqueAddresses);
              
              priceData.forEach(token => {
                if (token.usdPrice) {
                  priceMap.set(token.contractAddress.toLowerCase(), token.usdPrice);
                } else {
                  console.warn(`[Alchemy Price] No USD price found for ${token.contractAddress}.`);
                }
              });

            } catch (priceErr) {
              console.error(`[Alchemy Price] Failed to fetch token prices:`, priceErr.message);
            }
          }

          for (const trade of openTrades) {
            const assetDetail = vaultAssetDetails.find(a => a.symbol.toUpperCase() === trade.asset_symbol.toUpperCase());
            if (assetDetail && assetDetail.contract_address) {
              const currentPrice = priceMap.get(assetDetail.contract_address.toLowerCase());
              if (typeof currentPrice === 'number' && currentPrice > 0) {
                const entryPrice = parseFloat(trade.entry_price);
                const quantity = parseFloat(trade.quantity);
                if (trade.direction === 'LONG') {
                  unrealizedPnl += (currentPrice - entryPrice) * quantity;
                } else {
                  unrealizedPnl += (entryPrice - currentPrice) * quantity;
                }
              } else {
                console.warn(`[PNL Calc] Missing price for ${assetDetail.symbol}. Skipping for unrealized PNL calculation.`);
              }
            }
          }
        }

        const totalPnl = realizedPnl + unrealizedPnl;
        const netAssetValue = principalCapital + totalPnl;
        const pnlPercentage = (principalCapital > 0) ? (totalPnl / principalCapital) * 100 : 0;
        
        const recordDate = new Date();
        const insertQuery = `
          INSERT INTO vault_performance_history (vault_id, record_date, pnl_percentage, total_value_locked)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (vault_id, record_date) DO UPDATE SET
            pnl_percentage = EXCLUDED.pnl_percentage,
            total_value_locked = EXCLUDED.total_value_locked;
        `;
        await client.query(insertQuery, [vaultId, recordDate, pnlPercentage.toFixed(4), netAssetValue]);
        
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
    console.log('📈 Hourly vault performance update job finished.');
  }
};

module.exports = { updateVaultPerformance };
