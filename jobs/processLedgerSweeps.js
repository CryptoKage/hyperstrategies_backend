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
    // --- NEW: Read from the ledger, and join with users to get wallet info ---
    const { rows: depositsToProcess } = await client.query(
      `SELECT 
         vle.entry_id, vle.user_id, vle.amount as tradable_capital,
         u.eth_address, u.eth_private_key_encrypted
       FROM vault_ledger_entries vle
       JOIN users u ON vle.user_id = u.user_id
       WHERE vle.entry_type = 'DEPOSIT' AND vle.status = 'PENDING_SWEEP'`
    );

    if (depositsToProcess.length > 0) {
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
          
          // NOTE: The ABI should be standardized later, but for now, we'll assume a standard ERC20 ABI
          const usdcContract = new ethers.Contract(tokenMap.usdc.address, tokenMap.usdc.abi, userWallet);
          
          const tradableCapital_BN = ethers.utils.parseUnits(deposit.tradable_capital.toString(), 6);
          
          // Calculate the original deposit fee based on the tradable capital (reverse engineering the fee)
          // This assumes a 20% fee. This logic will need to be made more robust if fees change.
          const totalAmount_BN = tradableCapital_BN.mul(100).div(80); // e.g., 80 * 100 / 80 = 100
          const depositFee_BN = totalAmount_BN.sub(tradableCapital_BN);
          
          let nonce = await provider.getTransactionCount(userWallet.address, 'latest');
          
          // Sweep 1: Tradable Capital to Trading Desk
          const tradeDeskTx = await usdcContract.transfer(process.env.TRADING_DESK_WALLET_ADDRESS, tradableCapital_BN, { nonce, gasLimit: 100000 });
          await tradeDeskTx.wait(1);
          console.log(`✅ Trading Desk sweep confirmed for entry ${deposit.entry_id}.`);
          
          nonce++;
          
          // Sweep 2: Deposit Fee to DevOps Wallet
          const devopsTx = await usdcContract.transfer(process.env.HS_DEVOPS_WALLET_ADDRESS, depositFee_BN, { nonce, gasLimit: 100000 });
          await devopsTx.wait(1);
          console.log(`✅ Devops sweep confirmed for entry ${deposit.entry_id}.`);

          // Update the ledger entry status to SWEPT
          await client.query(`UPDATE vault_ledger_entries SET status = 'SWEPT' WHERE entry_id = $1`, [deposit.entry_id]);
          console.log(`--- Finished processing for ledger entry ID: ${deposit.entry_id} ---`);

        } catch (processingErr) {
          console.error(`❌ FAILED to process sweep for ledger entry ${deposit.entry_id}. Error:`, processingErr.message);
          await client.query(`UPDATE vault_ledger_entries SET status = 'SWEEP_FAILED' WHERE entry_id = $1`, [deposit.entry_id]);
        }
      }
    }
  } catch (err) {
    console.error('❌ Major error in processLedgerSweeps job:', err);
  } finally {
    client.release();
  }
}

module.exports = { processLedgerSweeps };
