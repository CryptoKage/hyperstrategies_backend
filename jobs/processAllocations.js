// server/jobs/processAllocations.js

const { ethers } = require('ethers');
const pool = require('../db');
// const { getProvider } = require('../utils/provider'); // REMOVED to prevent path errors
const { decrypt } = require('../utils/walletUtils');
const tokenMap = require('../utils/tokens/tokenMap');

// ✅ THE FIX: Create the provider directly in this file.
const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);

// --- Wallet Configuration ---
const hotWallet = new ethers.Wallet(process.env.HOT_WALLET_PRIVATE_KEY, provider);
const TRADING_DESK_WALLET = process.env.TRADING_DESK_WALLET_ADDRESS;
const DEVOPS_WALLET = process.env.HS_DEVOPS_WALLET_ADDRESS;
const STANDARD_GAS_FUNDING_ETH = "0.003"; 

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function processAllocations() {
  console.log('⚙️ Checking for new vault allocations to process...');
  const client = await pool.connect();
  try {
    const { rows: positionsToProcess } = await client.query(
      `SELECT p.position_id, p.tradable_capital, u.eth_address, u.eth_private_key_encrypted
       FROM user_vault_positions p JOIN users u ON p.user_id = u.user_id
       WHERE p.status = 'active'`
    );

    if (positionsToProcess.length === 0) {
      console.log('✅ No new allocations to process.');
      client.release(); // Release client if we return early
      return;
    }

    console.log(`Found ${positionsToProcess.length} allocations to process.`);
    
    for (const position of positionsToProcess) {
      console.log(`--- Starting processing for position ID: ${position.position_id} ---`);
      
      try {
        const { position_id, eth_address, eth_private_key_encrypted, tradable_capital } = position;
        const privateKey = decrypt(eth_private_key_encrypted);
        const userWallet = new ethers.Wallet(privateKey, provider);
        const usdcContract = new ethers.Contract(tokenMap.usdc.address, tokenMap.usdc.abi, userWallet);

        // --- Step A: Fund with Gas ---
        const fundingAmount_BN = ethers.utils.parseEther(STANDARD_GAS_FUNDING_ETH);
        const gasFundTx = await hotWallet.sendTransaction({ to: eth_address, value: fundingAmount_BN });
        console.log(`...Funding ${eth_address} with gas. TX: ${gasFundTx.hash}. Waiting for confirmation...`);
        await gasFundTx.wait(1);
        console.log(`✅ Gas funding tx confirmed.`);

        // --- Step B: Verify Gas Arrival ---
        let gasBalanceConfirmed = false;
        for (let i = 0; i < 12; i++) {
          const currentBalance = await provider.getBalance(eth_address);
          if (currentBalance.gte(fundingAmount_BN)) {
            console.log(`✅ Gas balance confirmed on-chain.`);
            gasBalanceConfirmed = true;
            break;
          }
          await sleep(5000);
        }
        if (!gasBalanceConfirmed) throw new Error("Gas funding did not appear on-chain within 60 seconds.");

        // --- Step C: Sequential Sweep ---
        const capital_BN = ethers.utils.parseUnits(tradable_capital.toString(), 6);
        const bonus_points_BN = capital_BN.div(4);
        let nonce = await provider.getTransactionCount(userWallet.address, 'latest');

        console.log(`...Sweeping ${ethers.utils.formatUnits(capital_BN, 6)} USDC to Trading Desk (Nonce: ${nonce})...`);
        const tradeDeskTx = await usdcContract.transfer(TRADING_DESK_WALLET, capital_BN, { nonce });
        await tradeDeskTx.wait(1);
        console.log(`✅ Trading Desk sweep confirmed.`);
        
        nonce++;
        
        console.log(`...Sweeping ${ethers.utils.formatUnits(bonus_points_BN, 6)} USDC to Devops (Nonce: ${nonce})...`);
        const devopsTx = await usdcContract.transfer(DEVOPS_WALLET, bonus_points_BN, { nonce });
        await devopsTx.wait(1);
        console.log(`✅ Devops sweep confirmed.`);
        
        // --- Step D: Update Database ---
        await client.query(`UPDATE user_vault_positions SET status = 'in_trade' WHERE position_id = $1`, [position_id]);

      } catch (processingErr) {
        console.error(`❌ FAILED to process allocation for position ${position.position_id}. Error:`, processingErr.message);
        await client.query(`UPDATE user_vault_positions SET status = 'sweep_failed' WHERE position_id = $1`, [position.position_id]);
      }
    }
  } catch (err) {
    console.error('❌ Major error in processAllocations job:', err);
  } finally {
    client.release();
  }
}

module.exports = { processAllocations };