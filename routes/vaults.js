// server/routes/vaults.js

const express = require('express');
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const tokenMap = require('../utils/tokens/tokenMap'); // We need tokenMap for decimals

const router = express.Router();

// --- Allocate Funds to Vault Endpoint (FINAL with safe parsing) ---
router.post('/invest', authenticateToken, async (req, res) => {
  const { vaultId, amount } = req.body;
  const userId = req.user.id;
  const client = await pool.connect();
  try {
    const amountStr = amount.toString();
    const decimalPattern = new RegExp(`^\\d+(\\.\\d{1,${tokenMap.usdc.decimals}})?$`);
    if (!decimalPattern.test(amountStr)) { return res.status(400).json({ error: 'Invalid amount format.' }); }
    const totalAmount_BN = ethers.utils.parseUnits(amountStr, tokenMap.usdc.decimals);
    const minAllocation_BN = ethers.utils.parseUnits('100', tokenMap.usdc.decimals);
    if (totalAmount_BN.lt(minAllocation_BN)) { return res.status(400).json({ error: 'Minimum allocation is $100.' }); }

    await client.query('BEGIN');
    const userResult = await client.query('SELECT balance, referred_by_user_id, account_tier FROM users WHERE user_id = $1 FOR UPDATE', [userId]);
    const vaultResult = await client.query('SELECT fee_percentage, is_fee_tier_based FROM vaults WHERE vault_id = $1', [vaultId]);
    if (userResult.rows.length === 0) throw new Error("User not found.");
    if (vaultResult.rows.length === 0) throw new Error(`Vault ${vaultId} not found.`);

    const userData = userResult.rows[0];
    const vaultData = vaultResult.rows[0];
    const availableBalance_BN = ethers.utils.parseUnits(userData.balance.toString(), 6);
    if (availableBalance_BN.lt(totalAmount_BN)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds.' });
    }

    let finalFeePercentage = parseFloat(vaultData.fee_percentage);
    if (vaultData.is_fee_tier_based) {
      const discount = (userData.account_tier - 1) * 0.02;
      finalFeePercentage = Math.max(0.10, finalFeePercentage - discount);
    }
    
    const feeMultiplier = Math.round(finalFeePercentage * 100);
    const bonusPointsAmount_BN = totalAmount_BN.mul(feeMultiplier).div(100);
    const tradableAmount_BN = totalAmount_BN.sub(bonusPointsAmount_BN);
    const newBalance_BN = availableBalance_BN.sub(totalAmount_BN);
    const tradableAmount = ethers.utils.formatUnits(tradableAmount_BN, 6);
    const depositFeeAmount = ethers.utils.formatUnits(bonusPointsAmount_BN, 6);

    await client.query('UPDATE users SET balance = $1 WHERE user_id = $2', [ethers.utils.formatUnits(newBalance_BN, 6), userId]);
    await client.query(`INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount) VALUES ($1, $2, 'DEPOSIT', $3)`,[userId, vaultId, tradableAmount]);
    await client.query('INSERT INTO bonus_points (user_id, points_amount, source) VALUES ($1, $2, $3)', [userId, depositFeeAmount, `DEPOSIT_FEE_VAULT_${vaultId}`]);
    
    // --- YOUR TREASURY & XP LOGIC (NOW INCLUDED AND CORRECT) ---
    const depositFeeSplits = { 'DEPOSIT_FEES_LP_SEEDING': 1, 'DEPOSIT_FEES_LP_REWARDS': 15, 'DEPOSIT_FEES_TEAM': 25, 'DEPOSIT_FEES_TREASURY': 20, 'DEPOSIT_FEES_COMMUNITY': 20, 'DEPOSIT_FEES_BUYBACK': 10, 'DEPOSIT_FEES_STRATEGIC': 9 };
    await client.query(`UPDATE treasury_ledgers SET balance = balance + $1 WHERE ledger_name = 'DEPOSIT_FEES_TOTAL'`, [depositFeeAmount]);
    const totalDesc = `Total Deposit Fee of ${depositFeeAmount} from user ${userId}.`;
    await client.query(`INSERT INTO treasury_transactions (to_ledger_id, amount, description) VALUES ((SELECT ledger_id FROM treasury_ledgers WHERE ledger_name = 'DEPOSIT_FEES_TOTAL'), $1, $2)`, [depositFeeAmount, totalDesc]);
    
    for (const ledgerName in depositFeeSplits) {
      const pct = depositFeeSplits[ledgerName];
      const splitAmount_BN = bonusPointsAmount_BN.mul(pct).div(100);
      if (!splitAmount_BN.isZero()) {
        const splitAmountFormatted = ethers.utils.formatUnits(splitAmount_BN, 6);
        await client.query(`UPDATE treasury_ledgers SET balance = balance + $1 WHERE ledger_name = $2`, [splitAmountFormatted, ledgerName]);
        const splitDesc = `Allocated ${pct}% of deposit fee to ${ledgerName}.`;
        await client.query( `INSERT INTO treasury_transactions (from_ledger_id, to_ledger_id, amount, description) VALUES ((SELECT ledger_id FROM treasury_ledgers WHERE ledger_name = 'DEPOSIT_FEES_TOTAL'), (SELECT ledger_id FROM treasury_ledgers WHERE ledger_name = $1), $2, $3)`, [ledgerName, splitAmountFormatted, splitDesc] );
      }
    }

    const allocationDescription = `Allocated ${amountStr} USDC to Vault ${vaultId}.`;
    await client.query(`INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status) VALUES ($1, 'VAULT_ALLOCATION', $2, $3, 'USDC', 'COMPLETED')`, [userId, allocationDescription, amountStr]);

    const xpForAmount = totalAmount_BN.div(ethers.utils.parseUnits('10', 6)).toNumber();
    if (xpForAmount > 0) {
      await client.query('UPDATE users SET xp = xp + $1 WHERE user_id = $2', [xpForAmount, userId]);
    }

    // Check if this is the user's first ever deposit into ANY vault
    const firstDepositCheck = await client.query("SELECT COUNT(*) FROM vault_ledger_entries WHERE user_id = $1 AND entry_type = 'DEPOSIT'", [userId]);
    const isFirstEverDeposit = parseInt(firstDepositCheck.rows[0].count) === 1; // It's 1 because we just inserted it
    if (isFirstEverDeposit && userData.referred_by_user_id) {
      const referralXP = totalAmount_BN.div(ethers.utils.parseUnits('10', 6)).toNumber();
      if (referralXP > 0) {
        await client.query('UPDATE users SET xp = xp + $1 WHERE user_id = $2', [referralXP, userData.referred_by_user_id]);
      }
    }
    // --- END OF YOUR LOGIC ---

    await client.query('COMMIT');
    res.status(200).json({ message: 'Allocation successful!' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Allocation transaction error:', err);
    res.status(500).json({ error: 'An error occurred during the allocation process.' });
  } finally {
    client.release();
  }
});


// --- Withdraw From Vault Endpoint ---
router.post('/withdraw', authenticateToken, async (req, res) => {
  const { vaultId, amount } = req.body;
  const userId = req.user.id;
  const client = await pool.connect();
  try {
    const withdrawalAmount = parseFloat(amount);
    if (isNaN(withdrawalAmount) || withdrawalAmount <= 0) { return res.status(400).json({ error: 'A valid, positive withdrawal amount is required.' }); }
    await client.query('BEGIN');
    const balanceResult = await client.query("SELECT COALESCE(SUM(amount), 0) as current_balance FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2", [userId, vaultId]);
    const currentBalance = parseFloat(balanceResult.rows[0].current_balance);
    if (withdrawalAmount > currentBalance) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Withdrawal amount exceeds your capital in this vault.' });
    }
    await client.query(`INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount) VALUES ($1, $2, 'WITHDRAWAL_REQUEST', $3)`, [userId, vaultId, -withdrawalAmount]);
    const description = `Requested withdrawal of ${withdrawalAmount.toFixed(2)} USDC from Vault ${vaultId}.`;
    await client.query(`INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status) VALUES ($1, 'VAULT_WITHDRAWAL_REQUEST', $2, $3, 'USDC', 'PENDING')`, [userId, description, withdrawalAmount]);
    await client.query('COMMIT');
    res.status(200).json({ message: 'Withdrawal request submitted successfully.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Vault withdrawal request error:', err);
    res.status(500).json({ error: 'An error occurred during the withdrawal request.' });
  } finally {
    client.release();
  }
});


module.exports = router;
