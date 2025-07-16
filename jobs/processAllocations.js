// server/jobs/processAllocations.js

const { ethers } = require('ethers');
const pool = require('../db');
const { decrypt } = require('../utils/walletUtils');
const tokenMap = require('../utils/tokens/tokenMap');
const { getProvider } = require('../utils/provider');
const { ensureGasCushion } = require('../utils/gas'); // Import our new unified utility

const provider = getProvider();

async function processAllocations() {
  console.log('⚙️ Checking for new vault allocations to process...');
  const client = await pool.connect();
  try {
    const { rows: positionsToProcess } = await client.query(
      `SELECT p.position_id, p.user_id, p.tradable_capital, u.eth_address, u.eth_private_key_encrypted
       FROM user_vault_positions p JOIN users u ON p.user_id = u.user_id
       WHERE p.status = 'active'`
    );

    if (positionsToProcess.length === 0) {
      console.log('✅ No new allocations to process.');
    } else {
      console.log(`Found ${positionsToProcess.length} allocations to process.`);
      for (const position of positionsToProcess) {
        try {
          console.log(`--- Starting processing for position ID: ${position.position_id} ---`);
          
          // Step 1: Ensure the user's wallet has gas.
          await ensureGasCushion(position.user_id, position.eth_address);

          // Step 2: Perform the sweeps.
          const privateKey = decrypt(position.eth_private_key_encrypted);
          const userWallet = new ethers.Wallet(privateKey, provider);
          const usdcContract = new ethers.Contract(tokenMap.usdc.address, tokenMap.usdc.abi, userWallet);
          
          const capital_BN = ethers.utils.parseUnits(position.tradable_capital.toString(), 6);
          const bonus_points_BN = capital_BN.div(4);
          let nonce = await provider.getTransactionCount(userWallet.address, 'latest');
          
          const tradeDeskTx = await usdcContract.transfer(process.env.TRADING_DESK_WALLET_ADDRESS, capital_BN, { nonce, gasLimit: 100000 });
          await tradeDeskTx.wait(1);
          console.log(`✅ Trading Desk sweep confirmed for position ${position.position_id}.`);
          
          nonce++;
          
          const devopsTx = await usdcContract.transfer(process.env.HS_DEVOPS_WALLET_ADDRESS, bonus_points_BN, { nonce, gasLimit: 100000 });
          await devopsTx.wait(1);
          console.log(`✅ Devops sweep confirmed for position ${position.position_id}.`);

          // Step 3: Update the database.
          await client.query(`UPDATE user_vault_positions SET status = 'in_trade' WHERE position_id = $1`, [position.position_id]);

        } catch (processingErr) {
          console.error(`❌ FAILED to process allocation for position ${position.position_id}. Error:`, processingErr.message);
          await client.query(`UPDATE user_vault_positions SET status = 'sweep_failed' WHERE position_id = $1`, [position.position_id]);
        }
      }
    }
  } catch (err) {
    console.error('❌ Major error in processAllocations job:', err);
  } finally {
    client.release();
  }
}

module.exports = { processAllocations };