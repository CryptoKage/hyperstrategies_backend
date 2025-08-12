const { ethers } = require('ethers');
const pool = require('../db');
const tokenMap = require('../utils/tokens/tokenMap');

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);

async function sweepDepositsToTradingDesk() {
  console.log('⚙️ Checking for pending deposits to sweep to trading desk...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Find all unswept DEPOSIT entries and lock them for processing
    const { rows: unsweptDeposits } = await client.query(
      `SELECT entry_id, amount 
       FROM vault_ledger_entries 
       WHERE entry_type = 'DEPOSIT' AND status = 'PENDING_SWEEP'
       FOR UPDATE SKIP LOCKED`
    );

    if (unsweptDeposits.length === 0) {
      console.log('No pending deposits to sweep.');
      await client.query('COMMIT'); // Commit to release any locks
      return;
    }
    console.log(`Found ${unsweptDeposits.length} deposits to sweep.`);

    // 2. Calculate the total amount to sweep
    const totalToSweep_BN = unsweptDeposits.reduce(
      (sum, deposit) => sum.add(ethers.utils.parseUnits(deposit.amount.toString(), 6)),
      ethers.BigNumber.from(0)
    );

    if (totalToSweep_BN.isZero()) {
      console.log('Total sweep amount is zero, nothing to transfer.');
      await client.query('COMMIT');
      return;
    }

    // 3. Perform the single on-chain transfer from the hot wallet
    const hotWallet = new ethers.Wallet(process.env.HOT_WALLET_PRIVATE_KEY, provider);
    const usdcContract = new ethers.Contract(tokenMap.usdc.address, tokenMap.usdc.abi, hotWallet);
    
    console.log(`Sweeping ${ethers.utils.formatUnits(totalToSweep_BN, 6)} USDC to trading desk...`);
    const tx = await usdcContract.transfer(process.env.TRADING_DESK_WALLET_ADDRESS, totalToSweep_BN);
    await tx.wait(1);
    console.log(`✅ Sweep transaction confirmed. Hash: ${tx.hash}`);

    // 4. Update the status of all processed entries to 'SWEPT'
    const entryIds = unsweptDeposits.map(d => d.entry_id);
    await client.query(
      "UPDATE vault_ledger_entries SET status = 'SWEPT' WHERE entry_id = ANY($1::int[])",
      [entryIds]
    );

    await client.query('COMMIT');
    console.log(`✅ Successfully swept ${unsweptDeposits.length} deposits.`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Major error in sweepDeposits job:', err);
  } finally {
    client.release();
  }
}

module.exports = { sweepDepositsToTradingDesk };
