const pool = require('../db');
const Moralis = require('moralis').default;
const { EvmChain } = require('@moralisweb3/common-evm-utils');
const fetch = require('node-fetch');

const chainMap = {
  'ETHEREUM': EvmChain.ETHEREUM,
  'POLYGON': EvmChain.POLYGON
};

const updateVaultPerformance = async () => {
  console.log('📈 Starting hourly vault performance update job (using Moralis SDK)...');
  
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
          `SELECT COALESCE(SUM(amount), 0) as total FROM vault_ledger_entries WHERE vault_id = $1 AND status = 'ACTIVE_IN_POOL' AND entry_type = 'DEPOSIT'`,
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
          
          const tradesByChain = openTrades.reduce((acc, trade) => {
            const assetDetail = vaultAssetDetails.find(a => a.symbol.toUpperCase() === trade.asset_symbol.toUpperCase());
            if (assetDetail && assetDetail.contract_address) {
              const chain = assetDetail.chain.toUpperCase();
              if (!acc[chain]) acc[chain] = [];
              acc[chain].push({ ...trade, contract_address: assetDetail.contract_address });
            }
            return acc;
          }, {});

          const allPriceData = [];
          
          for (const chainName in tradesByChain) {
            const chainTrades = tradesByChain[chainName];
            const tokensForChain = chainTrades.map(t => ({ address: t.contract_address }));

            console.log(`[Moralis Call] Fetching prices for ${tokensForChain.length} tokens on chain ${chainName}`);

            const priceResponse = await Moralis.EvmApi.token.getMultipleTokenPrices({
              chain: chainMap[chainName] || EvmChain.ETHEREUM,
              tokens: tokensForChain
            });
            allPriceData.push(...priceResponse.toJSON());
          }
          
          for (const trade of openTrades) {
            const assetDetail = vaultAssetDetails.find(a => a.symbol.toUpperCase() === trade.asset_symbol.toUpperCase());
            if (assetDetail && assetDetail.contract_address) {
              const priceInfo = allPriceData.find(p => p.tokenAddress.toLowerCase() === assetDetail.contract_address.toLowerCase());
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
        }

        const totalPnl = realizedPnl + unrealizedPnl;
        const netAssetValue = principalCapital + totalPnl;
        const pnlPercentage = (principalCapital > 0) ? (totalPnl / principalCapital) * 100 : 0;
        
        const ledgerStatusQuery = `SELECT COALESCE(SUM(CASE WHEN status = 'PENDING_SWEEP' THEN amount ELSE 0 END), 0) as capital_in_transit_to_desk, COALESCE(SUM(CASE WHEN entry_type = 'WITHDRAWAL_REQUEST' AND status = 'APPROVED' THEN amount * -1 ELSE 0 END), 0) as capital_in_transit_from_desk FROM vault_ledger_entries WHERE vault_id = $1;`;
        const ledgerStatusResult = await client.query(ledgerStatusQuery, [vaultId]);
        const capitalStatus = ledgerStatusResult.rows[0];

        const recordDate = new Date();
        // --- THIS IS THE FULL, CORRECT INSERT QUERY ---
        const insertQuery = `
          INSERT INTO vault_performance_history 
            (vault_id, record_date, pnl_percentage, total_value_locked, capital_in_trade, capital_in_transit_to_desk, capital_in_transit_from_desk)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (vault_id, record_date) DO UPDATE SET
            pnl_percentage = EXCLUDED.pnl_percentage,
            total_value_locked = EXCLUDED.total_value_locked,
            capital_in_trade = EXCLUDED.capital_in_trade,
            capital_in_transit_to_desk = EXCLUDED.capital_in_transit_to_desk,
            capital_in_transit_from_desk = EXCLUDED.capital_in_transit_from_desk;
        `;
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
