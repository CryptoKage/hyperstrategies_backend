// updateVaultPerformance.js
const pool = require('../db');
const Moralis = require('moralis').default;
const { EvmChain } = require('@moralisweb3/common-evm-utils');

// A simple map to convert our internal symbols to Moralis's chain objects
const chainMap = {
  // Add other chains here as needed, e.g., 'MATIC': EvmChain.POLYGON
  'DEFAULT': EvmChain.ETHEREUM 
};

/**
 * An hourly job to calculate and store performance & capital status for each active vault.
 * This version uses the Moralis API for fetching price data.
 */
const updateVaultPerformance = async () => {
  console.log('📈 Starting hourly vault performance update job (using Moralis)...');
  
  // Initialize Moralis - this only needs to be done once when the job starts.
  if (!Moralis.Core.isStarted) {
    await Moralis.start({ apiKey: process.env.MORALIS_API_KEY });
  }

  const client = await pool.connect();
  try {
    const { rows: activeVaults } = await client.query("SELECT vault_id FROM vaults WHERE status = 'active'");
    if (activeVaults.length === 0) {
      console.log('No active vaults to process.');
      return;
    }
    console.log(`Found ${activeVaults.length} active vaults to process.`);

    for (const vault of activeVaults) {
      const vaultId = vault.vault_id;
      console.log(`--- Processing Vault ID: ${vaultId} ---`);
      
      await client.query('BEGIN');
      try {
        const assetsResult = await client.query(
          'SELECT symbol, contract_address, chain FROM vault_assets WHERE vault_id = $1', // Assuming you have contract_address and chain columns
          [vaultId]
        );
        const assets = assetsResult.rows;

        let pnlPercentage = 0;
        
        if (assets.length > 0) {
          // 3. Fetch price data from Moralis using the efficient batch endpoint
          const tokensToFetch = assets.map(a => ({
            tokenAddress: a.contract_address,
            chain: chainMap[a.chain] || chainMap['DEFAULT']
          }));
          
          const priceResponse = await Moralis.EvmApi.token.getMultipleTokenPrices({ tokens: tokensToFetch });
          const priceData = priceResponse.toJSON();

          // 4. Calculate weighted P&L
          // NOTE: Moralis Price API's standard response doesn't include 24h change.
          // This logic will need to be adapted. For now, we'll placeholder the P&L.
          // In the next step, we will store the PREVIOUS day's price to calculate the change ourselves.
          pnlPercentage = 0.0; // Placeholder for now
        }
        
        // ... (The rest of the logic for calculating capital status and saving to the DB remains the same) ...

        const recordDate = new Date();
        // ... INSERT query ...
        
        await client.query('COMMIT');
        console.log(`✅ Successfully saved hourly performance for Vault ID: ${vaultId}.`);
      
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
