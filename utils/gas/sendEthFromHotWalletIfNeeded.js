// utils/sendEthFromHotWalletIfNeeded.js
const { ethers } = require('ethers');
const fetch = require('node-fetch');
const pool = require('../db');
const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const hotWallet = new ethers.Wallet(process.env.HOT_WALLET_PRIVATE_KEY, provider);

async function getEthPriceUSD() {
  const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
  const data = await res.json();
  return data.ethereum.usd;
}

async function sendEthFromHotWalletIfNeeded(userId, userAddress) {
  const balance = await provider.getBalance(userAddress);
  const balanceEth = parseFloat(ethers.utils.formatEther(balance));

  const MIN_BALANCE = 0.0001;
  const FUND_AMOUNT = 0.0005;
  const FUND_CAP = 0.005; // safeguard: max 0.005 ETH ever sent per wallet

  if (balanceEth >= MIN_BALANCE) return null;

  // Check historical funding total
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount_eth), 0) AS total_sent FROM hot_wallet_funding_log WHERE user_id = $1`,
    [userId]
  );
  const totalSent = parseFloat(rows[0].total_sent);
  if (totalSent + FUND_AMOUNT > FUND_CAP) {
    console.warn(`⛔ User ${userId} reached funding cap`);
    return null;
  }

  const tx = await hotWallet.sendTransaction({
    to: userAddress,
    value: ethers.utils.parseEther(FUND_AMOUNT.toString())
  });

  const ethPrice = await getEthPriceUSD();
  const usdcCharge = parseFloat(FUND_AMOUNT) * ethPrice * 1.01; // +1%

  await pool.query('BEGIN');

  await pool.query(
    `INSERT INTO hot_wallet_funding_log (user_id, to_address, amount_eth, tx_hash)
     VALUES ($1, $2, $3, $4)`,
    [userId, userAddress, FUND_AMOUNT, tx.hash]
  );

  await pool.query(
    `INSERT INTO gas_fees_log (user_id, eth_sent, eth_price_usd, usdc_charged, tx_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, FUND_AMOUNT, ethPrice, usdcCharge.toFixed(6), tx.hash]
  );

  await pool.query(
    `UPDATE users SET balance = balance - $1 WHERE user_id = $2`,
    [usdcCharge.toFixed(6), userId]
  );

  await pool.query('COMMIT');

  console.log(`🚀 Funded ${FUND_AMOUNT} ETH to ${userAddress}, charged ${usdcCharge.toFixed(2)} USDC`);

  return tx.hash;
}

module.exports = { sendEthFromHotWalletIfNeeded };
