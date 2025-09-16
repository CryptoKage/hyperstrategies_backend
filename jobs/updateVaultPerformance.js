// PASTE THIS ENTIRE CONTENT TO REPLACE: hyperstrategies_backend/jobs/updateVaultPerformance.js

const pool = require('../db');
const fetch = require('node-fetch'); // Make sure node-fetch is in your package.json
const { resolveNetworkByName } = require('../services/alchemy');

const updateVaultPerformance = async () => {
  console.log('📈 Starting hourly vault performance update job (using Alchemy Price API)...');

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

          const uniqueAddressesByChain = vaultAssetDetails.reduce((acc, asset) => {
            if (asset.contract_address) {
              const chain = asset.chain || 'ETHEREUM';
              if (!acc[chain]) acc[chain] = [];
              acc[chain].push(asset.contract_address);
            }
            return acc;
          }, {});

          // ==============================================================================
          // --- FINAL FIX: Use a direct `fetch` call to the Alchemy Price API endpoint ---
          // This bypasses the SDK helpers and uses the raw POST method for reliability.
          // ==============================================================================
          const apiKey = process.env.ALCHEMY_API_KEY;
          const apiUrl = `https://api.g.alchemy.com/prices/v1/${apiKey}/tokens/by-address`;

          for (const chainName in uniqueAddressesByChain) {
            const addresses = uniqueAddressesByChain[chainName];
            console.log(`[Alchemy Price] Fetching prices for ${addresses.length} assets on ${chainName}...`);

            try {
              const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  addresses: addresses.map(addr => ({
                    address: addr,
                    network: resolveNetworkByName(chainName), // Uses our helper to get 'eth-mainnet', etc.
                    currency: 'usd'
                  }))
                }),
              });

              if (!response.ok) {
                throw new Error(`API responded with status ${response.status}`);
              }
              
              const priceData = await response.json();

              for (const token of priceData.data) {
                if (token.prices && token.prices[0] && typeof token.prices[0].value === 'string') {
                  priceMap.set(token.address.toLowerCase(), parseFloat(token.prices[0].value));
                } else {
                  console.warn(`[Alchemy Price] No USD price data found for ${token.address}.`);
                }
              }

            } catch (priceErr) {
              console.error(`[Alchemy Price] Failed to fetch prices for ${chainName}:`, priceErr.message);
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
