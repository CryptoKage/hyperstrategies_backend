// jobs/collectUsdcFees.js .

const { ethers } = require('ethers');
const pool = require('../db');
const tokenMap = require('../utils/tokens/tokenMap');
const usdcAbi = require('../utils/tokens/usdc.json');
const { decrypt } = require('../utils/walletUtils');

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const hotWalletAddress = process.env.HOT_WALLET_ADDRESS;

async function collectUsdcFees() {
  console.log('🔁 Starting USDC fee collection job...');

  try {
    const { rows: pendingFees } = await pool.query(
      `SELECT * FROM gas_fees_usdc WHERE collected = false`
    );

    if (pendingFees.length === 0) {
      console.log('✅ No USDC fees pending collection.');
      return;
    }

    for (const fee of pendingFees) {
      const { id, user_id, wallet_address, usdc_amount } = fee;
      console.log(`➡️ Collecting ${usdc_amount} USDC from ${wallet_address}`);

      try {
        const userRes = await pool.query(
          `SELECT eth_private_key_encrypted FROM users WHERE eth_address = $1`,
          [wallet_address]
        );

        if (userRes.rows.length === 0) {
          console.error(`❌ Wallet ${wallet_address} not found in users.`);
          continue;
        }

        const encryptedKey = userRes.rows[0].eth_private_key_encrypted;
        const decryptedKey = decrypt(encryptedKey);
        const userWallet = new ethers.Wallet(decryptedKey, provider);

        const usdc = new ethers.Contract(tokenMap.usdc.address, usdcAbi, userWallet);
        const decimals = tokenMap.usdc.decimals;
        const amount = ethers.utils.parseUnits(usdc_amount.toString(), decimals);

        const tx = await usdc.transfer(hotWalletAddress, amount);
        await tx.wait();

        console.log(`✅ Collected from ${wallet_address}. TX: ${tx.hash}`);

        await pool.query(
          `UPDATE gas_fees_usdc SET collected = true WHERE id = $1`,
          [id]
        );
      } catch (err) {
        console.error(`❌ Error collecting from ${wallet_address}:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ Collection job failed:', err);
  }
}

collectUsdcFees();

module.exports = collectUsdcFees;
