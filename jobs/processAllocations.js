// server/jobs/processAllocations.js

const { ethers } = require('ethers');
const pool = require('../db');
// const { getProvider } = require('../utils/provider'); // We will remove this import
const { decrypt } = require('../utils/walletUtils');
const tokenMap = require('../utils/tokens/tokenMap');

// ✅ THE FIX: Create the provider directly inside this file.
const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);

// --- Wallet Configuration ---
const hotWallet = new ethers.Wallet(process.env.HOT_WALLET_PRIVATE_KEY, provider);
const TRADING_DESK_WALLET = process.env.TRADING_DESK_WALLET_ADDRESS;
const DEVOPS_WALLET = process.env.HS_DEVOPS_WALLET_ADDRESS;

const STANDARD_GAS_FUNDING_ETH = "0.003"; 

async function processAllocations() {
  console.log('⚙️ Checking for new vault allocations to process...');
  const client = await pool.connect();

  try {
    const { rows: positionsToProcess } = await client.query(
      `SELECT 
         p.position_id, p.tradable_capital,
         u.eth_address, u.eth_private_key_encrypted
       FROM user_vault_positions p
       JOIN users u ON p.user_id = u.user_id
       WHERE p.status = 'active'`
    );

    if (positionsToProcess.length === 0) {
      console.log('✅ No new allocations to process.');
      return;
    }

    for (const position of positionsToProcess) {
      const { position_id, eth_address, eth_private_key_encrypted, tradable_capital } = position;
      
      console.log(`Processing allocation for position ID: ${position_id}`);
      
      const privateKey = decrypt(eth_private_key_encrypted);
      const userWallet = new ethers.Wallet(privateKey, provider);
      const usdcContract = new ethers.Contract(tokenMap.usdc.address, tokenMap.usdc.abi, userWallet);

      try {
        console.log(`...funding ${eth_address} with ${STANDARD_GAS_FUNDING_ETH} ETH...`);
        const gasFundTx = await hotWallet.sendTransaction({
          to: eth_address,
          value: ethers.utils.parseEther(STANDARD_GAS_FUNDING_ETH),
        });
        await gasFundTx.wait(1);
        console.log(`✅ Gas funding successful. TX: ${gasFundTx.hash}`);

        const capital_BN = ethers.utils.parseUnits(tradable_capital.toString(), 6);
        const bonus_points_BN = capital_BN.div(4);

        console.log(`...sweeping ${ethers.utils.formatUnits(capital_BN, 6)} USDC to Trading Desk...`);
        const tradeDeskTx = await usdcContract.transfer(TRADING_DESK_WALLET, capital_BN);
        
        console.log(`...sweeping ${ethers.utils.formatUnits(bonus_points_BN, 6)} USDC to Devops...`);
        const devopsTx = await usdcContract.transfer(DEVOPS_WALLET, bonus_points_BN);

        await Promise.all([tradeDeskTx.wait(1), devopsTx.wait(1)]);
        console.log(`✅ Sweeps successful. Trading: ${tradeDeskTx.hash}, Devops: ${devopsTx.hash}`);
        
        await client.query(
          `UPDATE user_vault_positions SET status = 'in_trade' WHERE position_id = $1`,
          [position_id]
        );

      } catch (processingErr) {
        console.error(`❌ FAILED to process allocation for position ${position_id}. Error:`, processingErr.message);
      }
    }
  } catch (err) {
    console.error('❌ Major error in processAllocations job:', err);
  } finally {
    client.release();
  }
}

module.exports = { processAllocations };