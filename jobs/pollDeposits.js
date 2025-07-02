// jobs/pollDeposits.js
const { ethers } = require('ethers');
const pool = require('../db');
const { getTokenAddress, getTokenAbi } = require('../utils/withdrawHelpers');

const ALCHEMY_RPC_URL = process.env.ALCHEMY_RPC_URL;
console.log('🚀 Using ALCHEMY_RPC_URL:', ALCHEMY_RPC_URL);

let provider;

async function initializeProvider() {
  try {
    provider = new ethers.providers.JsonRpcProvider(ALCHEMY_RPC_URL);
    const network = await provider.getNetwork();
    const block = await provider.getBlockNumber();
    console.log(`🔌 Connected to Ethereum network: ${network.name} (chainId: ${network.chainId})`);
    console.log(`✅ Alchemy provider connected. Current block number: ${block}`);
  } catch (err) {
    console.error('❌ Alchemy provider connection failed:', err);
  }
}

async function pollDeposits() {
  try {
    if (!provider) {
      console.warn('⚠️ Provider not initialized. Skipping deposit check.');
      return;
    }

    const { rows: users } = await pool.query(
      `SELECT user_id, eth_address, balance FROM users WHERE eth_address IS NOT NULL`
    );

    const usdcAddress = getTokenAddress('usdc');
    const usdcAbi = getTokenAbi();
    const usdcContract = new ethers.Contract(usdcAddress, usdcAbi, provider);

    for (const user of users) {
      const onChainRaw = await usdcContract.balanceOf(user.eth_address);
      const onChainBalance = parseFloat(ethers.utils.formatUnits(onChainRaw, 6));
      const dbBalance = parseFloat(user.balance);

      if (onChainBalance > dbBalance) {
        const depositAmount = onChainBalance - dbBalance;

        await pool.query('BEGIN');
        await pool.query(
          `UPDATE users SET balance = $1 WHERE user_id = $2`,
          [onChainBalance, user.user_id]
        );
        await pool.query(
          `INSERT INTO deposits (user_id, amount) VALUES ($1, $2)`,
          [user.user_id, depositAmount]
        );
        await pool.query('COMMIT');

        console.log(`💰 Detected USDC deposit of $${depositAmount} for user ${user.user_id}`);
      }
    }
  } catch (err) {
    console.error('Deposit poll error:', err);
    await pool.query('ROLLBACK');
  }
}

module.exports = {
  pollDeposits,
  initializeProvider,
};
