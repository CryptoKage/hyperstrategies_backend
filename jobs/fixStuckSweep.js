// jobs/fixStuckSweep.js
const { ethers } = require('ethers');
const pool = require('../db');
const { decrypt } = require('../utils/walletUtils');
const tokenMap = require('../utils/tokens/tokenMap');
const erc20Abi = require('../utils/abis/erc20.json');
require('dotenv').config();

const USER_ID_TO_FIX = '71bd55c5-d7c3-4465-9a0b-31a2c727eb27';
const DEVOPS_WALLET = process.env.DEVOPS_WALLET_ADDRESS;

const fixSweep = async () => {
  console.log(`--- Starting custom sweep for user ${USER_ID_TO_FIX} ---`);
  const client = await pool.connect();
  const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
  
  try {
    await client.query('BEGIN');

    // 1. Get user position and key
    const posResult = await client.query('SELECT tradable_capital FROM user_vault_positions WHERE user_id = $1', [USER_ID_TO_FIX]);
    const userResult = await client.query('SELECT eth_address, eth_private_key_encrypted FROM users WHERE user_id = $1', [USER_ID_TO_FIX]);

    const tradableCapital = parseFloat(posResult.rows[0].tradable_capital);
    const devopsFeeAmount = (tradableCapital / 0.8) * 0.2; // Recalculate the 20% fee
    const devopsFee_BN = ethers.utils.parseUnits(devopsFeeAmount.toFixed(6), 6);
    
    const privateKey = decrypt(userResult.rows[0].eth_private_key_encrypted);
    const userWallet = new ethers.Wallet(privateKey, provider);
    const usdcContract = new ethers.Contract(tokenMap.usdc.address, erc20Abi, userWallet);

    console.log(`Attempting to sweep ${ethers.utils.formatUnits(devopsFee_BN, 6)} USDC to Devops wallet ${DEVOPS_WALLET}`);

    // 2. Execute ONLY the Devops sweep
    const tx = await usdcContract.transfer(DEVOPS_WALLET, devopsFee_BN);
    console.log(`Devops sweep transaction sent! Hash: ${tx.hash}`);
    await tx.wait();
    console.log('✅ Devops sweep confirmed.');

    // 3. Mark the position as fully 'in_trade'
    await client.query("UPDATE user_vault_positions SET status = 'in_trade' WHERE user_id = $1", [USER_ID_TO_FIX]);
    console.log('✅ User position status updated to in_trade.');
    
    await client.query('COMMIT');
    console.log('--- Fix script completed successfully! ---');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Fix script failed:', err);
  } finally {
    client.release();
  }
};

fixSweep();
