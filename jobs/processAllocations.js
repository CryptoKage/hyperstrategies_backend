// server/jobs/processAllocations.js

const { ethers } = require('ethers');
const pool = require('../db');
const { getProvider } = require('../utils/provider');
const { decrypt } = require('../utils/walletUtils');
const tokenMap = require('../utils/tokens/tokenMap');

const provider = getProvider();
const hotWallet = new ethers.Wallet(process.env.HOT_WALLET_PRIVATE_KEY, provider);
const TRADING_DESK_WALLET = process.env.TRADING_DESK_WALLET_ADDRESS;
const DEVOPS_WALLET = process.env.HS_DEVOPS_WALLET_ADDRESS;

// Helper function to add a delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function processAllocations() {
  console.log('⚙️ Checking for new vault allocations to process...');
  const client = await pool.connect(); // Get one client for the whole job run

  try {
    const { rows: positionsToProcess } = await client.query(
      `SELECT p.position_id, p.tradable_capital, u.eth_address, u.eth_private_key_encrypted
       FROM user_vault_positions p JOIN users u ON p.user_id = u.user_id
       WHERE p.status = 'active'`
    );

    if (positionsToProcess.length === 0) {
      console.log('✅ No new allocations to process.');
      // No early return, so finally block will always run
    } else {
      console.log(`Found ${positionsToProcess.length} allocations to process.`);
      
      for (const position of positionsToProcess) {
        console.log(`--- Starting processing for position ID: ${position.position_id} ---`);
        
        // Each position is wrapped in its own transaction block
        try {
          await client.query('BEGIN');

          const { position_id, eth_address, eth_private_key_encrypted, tradable_capital } = position;
          const privateKey = decrypt(eth_private_key_encrypted);
          const userWallet = new ethers.Wallet(privateKey, provider);
          const usdcContract = new ethers.Contract(tokenMap.usdc.address, tokenMap.usdc.abi, userWallet);

          // We assume the user's wallet has been pre-funded with sufficient gas
          // from a separate, more robust gas-funding job or manually.
          // This removes the gas estimation failure point from this critical job.

          // --- The Split & Sweep (Sequential) ---
          const capital_BN = ethers.utils.parseUnits(tradable_capital.toString(), 6);
          const bonus_points_BN = capital_BN.div(4);
          let nonce = await provider.getTransactionCount(userWallet.address, 'latest');

          console.log(`...Sweeping ${ethers.utils.formatUnits(capital_BN, 6)} USDC to Trading Desk (Nonce: ${nonce})...`);
          const tradeDeskTx = await usdcContract.transfer(TRADING_DESK_WALLET, capital_BN, { nonce, gasLimit: 100000 }); // Set a manual gas limit
          await tradeDeskTx.wait(1);
          console.log(`✅ Trading Desk sweep confirmed.`);
          
          nonce++;
          
          console.log(`...Sweeping ${ethers.utils.formatUnits(bonus_points_BN, 6)} USDC to Devops (Nonce: ${nonce})...`);
          const devopsTx = await usdcContract.transfer(DEVOPS_WALLET, bonus_points_BN, { nonce, gasLimit: 100000 });
          await devopsTx.wait(1);
          console.log(`✅ Devops sweep confirmed.`);
          
          // --- Update Database ---
          await client.query(`UPDATE user_vault_positions SET status = 'in_trade' WHERE position_id = $1`, [position_id]);
          await client.query('COMMIT');

        } catch (processingErr) {
          await client.query('ROLLBACK');
          console.error(`❌ FAILED to process allocation for position ${position.position_id}. Error:`, processingErr.message);
          await client.query(`UPDATE user_vault_positions SET status = 'sweep_failed' WHERE position_id = $1`, [position.position_id]);
        }
        await sleep(1000); // Add a 1-second delay between processing each position
      }
    }
  } catch (err) {
    console.error('❌ Major error in processAllocations job:', err);
  } finally {
    // This now runs only once at the very end of the job.
    console.log('Releasing DB client for processAllocations.');
    client.release();
  }
}

module.exports = { processAllocations };