// jobs/pollDeposits.js
const { ethers } = require('ethers');
const pool = require('../db');

const ALCHEMY_URL = process.env.ALCHEMY_URL;

// ✅ Explicitly define network: Ethereum Mainnet (name + chainId)
const network = {
  name: 'homestead',  // Ethereum mainnet alias
  chainId: 1
};

const provider = new ethers.providers.JsonRpcProvider(ALCHEMY_URL, network);

async function pollDeposits() {
  try {
    const { rows: users } = await pool.query(
      `SELECT user_id, eth_address, balance FROM users WHERE eth_address IS NOT NULL`
    );

    for (const user of users) {
      const onChainBalance = await provider.getBalance(user.eth_address);
      const ethBalance = parseFloat(ethers.utils.formatEther(onChainBalance));
      const dbBalance = parseFloat(user.balance);

      if (ethBalance > dbBalance) {
        const depositAmount = ethBalance - dbBalance;

        await pool.query('BEGIN');
        await pool.query(
          `UPDATE users SET balance = $1 WHERE user_id = $2`,
          [ethBalance, user.user_id]
        );

        await pool.query(
          `INSERT INTO deposits (user_id, amount) VALUES ($1, $2)`,
          [user.user_id, depositAmount]
        );
        await pool.query('COMMIT');

        console.log(`💰 Detected new deposit of ${depositAmount} ETH for user ${user.user_id}`);
      }
    }
  } catch (err) {
    console.error('Deposit poll error:', err);
    await pool.query('ROLLBACK');
  }
}

module.exports = pollDeposits;
