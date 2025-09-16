// PASTE THIS ENTIRE CONTENT TO REPLACE: hyperstrategies_backend/jobs/updateVaultPerformance.js

const pool = require('../db');
const fetch = require('node-fetch');
const { getAlchemyClient, resolveNetworkByName } = require('../services/alchemy');

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

          const byAddress = [];
          const bySymbol = [];

          for (const asset of vaultAssetDetails) {
            if (asset.chain === 'ETHEREUM' && asset.contract_address) {
              byAddress.push(asset.contract_address);
            } else if (asset.symbol) {
              bySymbol.push(asset.symbol);
            }
          }

          // --- Fetch prices by contract address ---
          if (byAddress.length > 0) {
            console.log(`[Alchemy Price] Fetching ${byAddress.length} assets by address...`);
            try {
              const apiKey = alchemy?.config?.apiKey || process.env.ALCHEMY_API_KEY;
              if (!apiKey) {
                throw new Error('Alchemy API key missing for price lookup.');
              }

              const response = await fetch(
                `https://api.g.alchemy.com/prices/v1/${apiKey}/tokens/by-address`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    addresses: byAddress.map((address) => ({
                      address,
                      network: 'eth-mainnet', // Assuming ETH for now, can use resolveNetworkByName
                      currency: 'usd'
                    })),
                  }),
                }
              );

              if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorBody || response.statusText}`);
              }

              const json = await response.json();
              const tokens = Array.isArray(json?.data) ? json.data : [];

              for (const token of tokens) {
                const priceValue = token?.prices?.[0]?.value;
                const tokenAddress = (token?.address || '').toLowerCase();
                if (tokenAddress && priceValue !== undefined && priceValue !== null) {
                  priceMap.set(tokenAddress, parseFloat(priceValue));
                }
              }
            } catch (priceErr) {
              console.error(`[Alchemy Price] Failed to fetch prices by address:`, priceErr.message);
            }
          }

          // --- Fetch prices by symbol ---
          if (bySymbol.length > 0) {
            console.log(`[Alchemy Price] Fetching ${bySymbol.length} assets by symbol...`);
            try {
              const response = await alchemy.prices.getTokenPriceBySymbol(bySymbol);
              for (const token of response.data) {
                  const assetDetail = vaultAssetDetails.find(a => a.symbol === token.symbol);
                  if (assetDetail && token.prices[0]?.value) {
                      // We need the contract address to map consistently.
                      // This assumes symbols are unique for non-address assets.
                      priceMap.set(assetDetail.contract_address.toLowerCase(), parseFloat(token.prices[0].value));
                  }
              }
            } catch (priceErr) {
              console.error(`[Alchemy Price] Failed to fetch prices by symbol:`, priceErr.message);
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
                console.warn(`[PNL Calc] Missing price for ${assetDetail.symbol}. Skipping calculation.`);
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
