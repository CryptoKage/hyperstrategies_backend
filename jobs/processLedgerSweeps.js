// processledgersweeps.js

const { ethers } = require('ethers');
const pool = require('../db');
const { decrypt } = require('../utils/walletUtils');
const tokenMap = require('../utils/tokens/tokenMap');
const { ensureGasCushion } = require('../utils/gas');

const provider = new ethers.providers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);

async function processLedgerSweeps() {
  console.log('⚙️ Checking for PENDING_SWEEP deposits in the ledger...');
  const client = await pool.connect();
  try {
    // 1. Fetch all pending deposits, now including our new 'fee_amount' column.
    const { rows: depositsToProcess } = await client.query(
      `SELECT 
         vle.entry_id, 
         vle.user_id, 
         vle.amount as tradable_capital,
         vle.fee_amount,  -- <-- We fetch our new, accurate fee column
         u.eth_address, 
         u.eth_private_key_encrypted
       FROM vault_ledger_entries vle
       JOIN users u ON vle.user_id = u.user_id
       WHERE vle.entry_type = 'DEPOSIT' AND vle.status = 'PENDING_SWEEP'`
    );

    if (depositsToProcess.length === 0) {
      console.log('No pending deposits to sweep.');
      return; // Exit early if there's no work to do
    }

    console.log(`Found ${depositsToProcess.length} ledger deposits to sweep.`);
    for (const deposit of depositsToProcess) {
      try {
        console.log(`--- Starting sweep for ledger entry ID: ${deposit.entry_id} ---`);
        
        await ensureGasCushion(deposit.user_id, deposit.eth_address);

        const privateKey = decrypt(deposit.eth_private_key_encrypted);
        if (!privateKey) {
          throw new Error('Decryption failed, private key is null.');
        }
        const userWallet = new ethers.Wallet(privateKey, provider);
        const usdcContract = new ethers.Contract(tokenMap.usdc.address, tokenMap.usdc.abi, userWallet);
        
        // --- THIS IS THE FIX ---
        // No more guessing or reverse-engineering the fee.
        // We read the exact, correct amounts directly from the database.
        const tradableCapital_BN = ethers.utils.parseUnits(deposit.tradable_capital.toString(), 6);
        const depositFee_BN = ethers.utils.parseUnits(deposit.fee_amount.toString(), 6);
        // --- END OF FIX ---
        
        let nonce = await provider.getTransactionCount(userWallet.address, 'latest');
        
        // Sweep 1: Tradable Capital to Trading Desk
        if (tradableCapital_BN.gt(0)) {
            const tradeDeskTx = await usdcContract.transfer(process.env.TRADING_DESK_WALLET_ADDRESS, tradableCapital_BN, { nonce, gasLimit: 100000 });
            await tradeDeskTx.wait(1);
            console.log(`✅ Trading Desk sweep confirmed for entry ${deposit.entry_id}.`);
            nonce++;
        }
        
        // Sweep 2: Deposit Fee to DevOps Wallet
        if (depositFee_BN.gt(0)) {
            const devopsTx = await usdcContract.transfer(process.env.HS_DEVOPS_WALLET_ADDRESS, depositFee_BN, { nonce, gasLimit: 100000 });
            await devopsTx.wait(1);
            console.log(`✅ Devops sweep confirmed for entry ${deposit.entry_id}.`);
        }

        // Update the ledger entry status to SWEPT
        await client.query(`UPDATE vault_ledger_entries SET status = 'SWEPT' WHERE entry_id = $1`, [deposit.entry_id]);
        console.log(`--- Finished processing for ledger entry ID: ${deposit.entry_id} ---`);

      } catch (processingErr) {
        console.error(`❌ FAILED to process sweep for ledger entry ${deposit.entry_id}. Error:`, processingErr.message);
        await client.query(`UPDATE vault_ledger_entries SET status = 'SWEEP_FAILED' WHERE entry_id = $1`, [deposit.entry_id]);
      }
    }
  } catch (err) {
    console.error('❌ Major error in processLedgerSweeps job:', err);
  } finally {
    client.release();
  }
}

module.exports = { processLedgerSweeps };
