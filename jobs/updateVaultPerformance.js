// ==============================================================================
// FINAL, DEBUGGING VERSION: PASTE THIS to replace your full updateVaultPerformance.js
// ==============================================================================
const pool = require('../db');
const Moralis = require('moralis').default;
const { EvmChain } = require('@moralisweb3/common-evm-utils');

const chainMap = {
  'ETHEREUM': EvmChain.ETHEREUM,
  'POLYGON': EvmChain.POLYGON
};

const updateVaultPerformance = async () => {
  console.log('📈 Starting hourly vault performance update job (using Moralis)...');
  
  if (!Moralis.Core.isStarted) {
    await Moralis.start({ apiKey: process.env.MORALIS_API_KEY });
  }

  const client = await pool.connect();
  try {
    const { rows: activeVaults } = await client.query("SELECT vault_id FROM vaults WHERE status = 'active'");
    if (activeVaults.length === 0) {
      console.log('No active vaults to process.');
      client.release();
      return;
    }

    for (const vault of activeVaults) {
      const vaultId = vault.vault_id;
      console.log(`--- Processing Vault ID: ${vaultId} ---`);
      
      await client.query('BEGIN');
      try {
        const principalResult = await client.query(
          `SELECT COALESCE(SUM(amount), 0) as total 
           FROM vault_ledger_entries 
           WHERE vault_id = $1 AND status = 'ACTIVE_IN_POOL' AND entry_type = 'DEPOSIT'`,
          [vaultId]
        );
        const principalCapital = parseFloat(principalResult.rows[0].total);

        const tradesResult = await client.query('SELECT * FROM vault_trades WHERE vault_id = $1', [vaultId]);
        const allTrades = tradesResult.rows;

        const realizedPnl = allTrades.filter(t => t.status === 'CLOSED').reduce((sum, t) => sum + parseFloat(t.pnl_usd || 0), 0);
        const openTrades = allTrades.filter(t => t.status === 'OPEN');
        let unrealizedPnl = 0;

        // --- DEEP DEBUGGING LOGS ---
        console.log(`[Debug Vault ${vaultId}] Found ${openTrades.length} open trades.`);
        console.log("[Debug Vault " + vaultId + "] Open Trades Data:", JSON.stringify(openTrades, null, 2));
        
        if (openTrades.length > 0) {
          const assetsResult = await client.query('SELECT symbol, contract_address, chain FROM vault_assets WHERE vault_id = $1', [vaultId]);
          const vaultAssetDetails = assetsResult.rows;

          console.log(`[Debug Vault ${vaultId}] Found ${vaultAssetDetails.length} asset definitions for this vault.`);
          console.log("[Debug Vault " + vaultId + "] Asset Definitions Data:", JSON.stringify(vaultAssetDetails, null, 2));

          const tokensToFetch = [];
          for (const trade of openTrades) {
            console.log(`[Debug Vault ${vaultId}] Looking for asset match for trade symbol: '${trade.asset_symbol}'`);
            const assetDetail = vaultAssetDetails.find(a => a.symbol.toUpperCase() === trade.asset_symbol.toUpperCase());
            
            if (assetDetail) {
              console.log(`[Debug Vault ${vaultId}]   ✅ Match FOUND. Asset detail:`, JSON.stringify(assetDetail));
              if (assetDetail.contract_address) {
                tokensToFetch.push({
                  tokenAddress: assetDetail.contract_address,
                  chain: chainMap[assetDetail.chain.toUpperCase()] || EvmChain.ETHEREUM
                });
                console.log(`[Debug Vault ${vaultId}]     ✅ Added to tokensToFetch array.`);
              } else {
                console.log(`[Debug Vault ${vaultId}]     ❌ REJECTED: Match found, but 'contract_address' is null or empty.`);
              }
            } else {
              console.log(`[Debug Vault ${vaultId}]   ❌ REJECTED: No matching asset definition found in vault_assets.`);
            }
          }
          
          console.log(`[Debug Vault ${vaultId}] Final 'tokensToFetch' array before calling Moralis:`, JSON.stringify(tokensToFetch, null, 2));
          
          if (tokensToFetch.length > 0) {
            const priceResponse = await Moralis.EvmApi.token.getMultipleTokenPrices({ tokens: tokensToFetch });
            const currentPrices = priceResponse.toJSON();

            for (const trade of openTrades) {
              const assetDetail = vaultAssetDetails.find(a => a.symbol.toUpperCase() === trade.asset_symbol.toUpperCase());
              if (assetDetail && assetDetail.contract_address) {
                const priceInfo = currentPrices.find(p => p.tokenAddress.toLowerCase() === assetDetail.contract_address.toLowerCase());
                if (priceInfo && priceInfo.usdPrice) {
                  const currentPrice = priceInfo.usdPrice;
                  const entryPrice = parseFloat(trade.entry_price);
                  const quantity = parseFloat(trade.quantity);
                  
                  if (trade.direction === 'LONG') {
                    unrealizedPnl += (currentPrice - entryPrice) * quantity;
                  } else {
                    unrealizedPnl += (entryPrice - currentPrice) * quantity;
                  }
                }
              }
            }
          } else {
              console.log(`[Debug Vault ${vaultId}] Skipping Moralis call because 'tokensToFetch' is empty.`);
          }
        }

        const totalPnl = realizedPnl + unrealizedPnl;
        const netAssetValue = principalCapital + totalPnl;
        const pnlPercentage = (principalCapital > 0) ? (totalPnl / principalCapital) * 100 : 0;
        
        const ledgerStatusQuery = `SELECT COALESCE(SUM(CASE WHEN status = 'PENDING_SWEEP' THEN amount ELSE 0 END), 0) as capital_in_transit_to_desk, COALESCE(SUM(CASE WHEN entry_type = 'WITHDRAWAL_REQUEST' AND status = 'APPROVED' THEN amount * -1 ELSE 0 END), 0) as capital_in_transit_from_desk FROM vault_ledger_entries WHERE vault_id = $1;`;
        const ledgerStatusResult = await client.query(ledgerStatusQuery, [vaultId]);
        const capitalStatus = ledgerStatusResult.rows[0];

        const recordDate = new Date();
        const insertQuery = `INSERT INTO vault_performance_history (vault_id, record_date, pnl_percentage, total_value_locked, capital_in_trade, capital_in_transit_to_desk, capital_in_transit_from_desk) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (vault_id, record_date) DO UPDATE SET pnl_percentage = EXCLUDED.pnl_percentage, total_value_locked = EXCLUDED.total_value_locked, capital_in_trade = EXCLUDED.capital_in_trade, capital_in_transit_to_desk = EXCLUDED.capital_in_transit_to_desk, capital_in_transit_from_desk = EXCLUDED.capital_in_transit_from_desk;`;
        await client.query(insertQuery, [vaultId, recordDate, pnlPercentage.toFixed(4), netAssetValue, principalCapital, capitalStatus.capital_in_transit_to_desk, capitalStatus.capital_in_transit_from_desk]);

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
    client.release();
    console.log('📈 Hourly vault performance update job finished.');
  }
};

module.exports = { updateVaultPerformance };
// ==============================================================================
// END OF FILE
// ==============================================================================
