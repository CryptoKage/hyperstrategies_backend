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
    if (!decimalPattern.test(amountStr)) {
      return res.status(400).json({ error: 'Invalid amount format.' });
    }
    const totalAmount_BN = ethers.utils.parseUnits(amountStr, tokenMap.usdc.decimals);
    const minAllocation_BN = ethers.utils.parseUnits('100', tokenMap.usdc.decimals);
    if (totalAmount_BN.lt(minAllocation_BN)) {
      return res.status(400).json({ error: 'Minimum allocation is $100.' });
    }

    await client.query('BEGIN');

const userQuery = `
      SELECT ROUND(balance::numeric, 6) as balance, referred_by_user_id, account_tier 
      FROM users WHERE user_id = $1 FOR UPDATE
    `;
    const vaultQuery = 'SELECT fee_percentage, is_fee_tier_based FROM vaults WHERE vault_id = $1';

    const [userResult, vaultResult] = await Promise.all([
      client.query(userQuery, [userId]),
      client.query(vaultQuery, [vaultId])
    ]);
    
    if (userResult.rows.length === 0) throw new Error("User not found during allocation.");
    if (vaultResult.rows.length === 0) throw new Error(`Vault with ID ${vaultId} not found.`);

    const userData = userResult.rows[0];
    const vaultData = vaultResult.rows[0];

    const availableBalance_BN = ethers.utils.parseUnits(userData.balance.toString(), tokenMap.usdc.decimals);

    if (availableBalance_BN.lt(totalAmount_BN)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds.' });
    }

    let finalFeePercentage;
    const baseFeePercentage = Number(vaultData.fee_percentage);

    if (vaultData.is_fee_tier_based) {
      const discountPercentage = (userData.account_tier - 1) * 0.02; 
      finalFeePercentage = baseFeePercentage - discountPercentage;
      finalFeePercentage = Math.max(0.10, finalFeePercentage);
    } else {
      finalFeePercentage = baseFeePercentage;
    }

    const feeMultiplier = Math.round(finalFeePercentage * 100);
    const depositFeeAmount_BN = totalAmount_BN.mul(feeMultiplier).div(100);
    const tradableAmount_BN = totalAmount_BN.sub(depositFeeAmount_BN);
    const newBalance_BN = availableBalance_BN.sub(totalAmount_BN);
    const depositFeeAmountFormatted = ethers.utils.formatUnits(depositFeeAmount_BN, tokenMap.usdc.decimals);

    await client.query('UPDATE users SET balance = $1 WHERE user_id = $2', [ethers.utils.formatUnits(newBalance_BN, tokenMap.usdc.decimals), userId]);
    
    const lockExpiresAt = new Date();
    lockExpiresAt.setMonth(lockExpiresAt.getMonth() + 1);

    const existingPosition = await client.query('SELECT position_id, tradable_capital, high_water_mark FROM user_vault_positions WHERE user_id = $1 AND vault_id = $2 FOR UPDATE', [userId, vaultId]);
    
    // --- THIS IS THE CORRECTED IF/ELSE STRUCTURE ---
    if (existingPosition.rows.length > 0) {
      const currentPosition = existingPosition.rows[0];

      const currentCapital_BN = ethers.utils.parseUnits(currentPosition.tradable_capital.toString(), tokenMap.usdc.decimals);
      const currentHWM_BN = ethers.utils.parseUnits(currentPosition.high_water_mark.toString(), tokenMap.usdc.decimals);
      
      const newCapital_BN = currentCapital_BN.add(tradableAmount_BN);
      const newHWM_BN = currentHWM_BN.add(tradableAmount_BN);

      await client.query( 'UPDATE user_vault_positions SET tradable_capital = $1, high_water_mark = $2, lock_expires_at = $3 WHERE position_id = $4', [ ethers.utils.formatUnits(newCapital_BN, tokenMap.usdc.decimals), ethers.utils.formatUnits(newHWM_BN, tokenMap.usdc.decimals), lockExpiresAt, currentPosition.position_id ] );
    } else {
      await client.query( `INSERT INTO user_vault_positions (user_id, vault_id, tradable_capital, status, lock_expires_at, high_water_mark) VALUES ($1, $2, $3, 'active', $4, $5)`, [ userId, vaultId, ethers.utils.formatUnits(tradableAmount_BN, tokenMap.usdc.decimals), lockExpiresAt, ethers.utils.formatUnits(tradableAmount_BN, tokenMap.usdc.decimals) ] );
    }
    
    await client.query('INSERT INTO bonus_points (user_id, points_amount) VALUES ($1, $2)', [userId, depositFeeAmountFormatted]);

    const depositFeeSplits = {
      'DEPOSIT_FEES_LP_SEEDING': 1,
      'DEPOSIT_FEES_LP_REWARDS': 15,
      'DEPOSIT_FEES_TEAM': 25,
      'DEPOSIT_FEES_TREASURY': 20,
      'DEPOSIT_FEES_COMMUNITY': 20,
      'DEPOSIT_FEES_BUYBACK': 10,
      'DEPOSIT_FEES_STRATEGIC': 9
    };
    await client.query(`UPDATE treasury_ledgers SET balance = balance + $1 WHERE ledger_name = 'DEPOSIT_FEES_TOTAL'`, [depositFeeAmountFormatted]);
    const totalDesc = `Total Deposit Fee of ${depositFeeAmountFormatted} from user ${userId}.`;
    await client.query(`INSERT INTO treasury_transactions (to_ledger_id, amount, description) VALUES ((SELECT ledger_id FROM treasury_ledgers WHERE ledger_name = 'DEPOSIT_FEES_TOTAL'), $1, $2)`, [depositFeeAmountFormatted, totalDesc]);

    for (const ledgerName in depositFeeSplits) {
      const pct = depositFeeSplits[ledgerName];
      const splitAmount_BN = depositFeeAmount_BN.mul(pct).div(100);
      if (!splitAmount_BN.isZero()) {
        const splitAmountFormatted = ethers.utils.formatUnits(splitAmount_BN, tokenMap.usdc.decimals);
        await client.query(`UPDATE treasury_ledgers SET balance = balance + $1 WHERE ledger_name = $2`, [splitAmountFormatted, ledgerName]);
        const splitDesc = `Allocated ${pct}% of deposit fee to ${ledgerName}.`;
        await client.query( `INSERT INTO treasury_transactions (from_ledger_id, to_ledger_id, amount, description) VALUES ((SELECT ledger_id FROM treasury_ledgers WHERE ledger_name = 'DEPOSIT_FEES_TOTAL'), (SELECT ledger_id FROM treasury_ledgers WHERE ledger_name = $1), $2, $3)`, [ledgerName, splitAmountFormatted, splitDesc] );
      }
    }

    const allocationDescription = `Allocated ${ethers.utils.formatUnits(totalAmount_BN, tokenMap.usdc.decimals)} USDC to Vault ${vaultId}.`;
    await client.query(
      `INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status)
       VALUES ($1, 'VAULT_ALLOCATION', $2, $3, 'USDC', 'COMPLETED')`,
      [userId, allocationDescription, amountStr]
    );

    const xpForAmount = totalAmount_BN.div(ethers.utils.parseUnits('10', tokenMap.usdc.decimals)).toNumber();
    if (xpForAmount > 0) {
      await client.query('UPDATE users SET xp = xp + $1 WHERE user_id = $2', [xpForAmount, userId]);
    }
    const positionCheck = await client.query('SELECT COUNT(*) FROM user_vault_positions WHERE user_id = $1', [userId]);
    const isFirstAllocation = parseInt(positionCheck.rows[0].count) === 1;
    if (isFirstAllocation) {
      const referrerId = userData.referred_by_user_id;
      if (referrerId) {
        const referralXP = totalAmount_BN.div(ethers.utils.parseUnits('10', tokenMap.usdc.decimals)).toNumber();
        await client.query('UPDATE users SET xp = xp + $1 WHERE user_id = $2', [referralXP, referrerId]);
      }
    }

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
  const { vaultId } = req.body;
  const userId = req.user.id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get the position and lock it for update to prevent race conditions
    const positionResult = await client.query(
      "SELECT position_id, tradable_capital, lock_expires_at FROM user_vault_positions WHERE user_id = $1 AND vault_id = $2 AND status = 'in_trade' FOR UPDATE",
      [userId, vaultId]
    );

    if (positionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'You do not have an active position in this vault to withdraw from.' });
    }

    const position = positionResult.rows[0];

    // Check the lock date
    if (position.lock_expires_at && new Date(position.lock_expires_at) > new Date()) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `This position is locked for withdrawal until ${new Date(position.lock_expires_at).toLocaleDateString()}.` });
    }

    const withdrawalAmountStr = position.tradable_capital.toString();
    const withdrawalAmount_BN = ethers.utils.parseUnits(withdrawalAmountStr, tokenMap.usdc.decimals);

    // --- THIS IS THE FIX ---
    // Instead of deleting the position, we update its status.
    await client.query(
      "UPDATE user_vault_positions SET status = 'withdrawal_pending' WHERE position_id = $1",
      [position.position_id]
    );

    // Create the activity log entry
    const withdrawalFormatted = Number(ethers.utils.formatUnits(withdrawalAmount_BN, tokenMap.usdc.decimals)).toFixed(2);
    const withdrawalDescription = `Requested withdrawal of ${withdrawalFormatted} USDC from Vault ${vaultId}.`;
    await client.query(
      `INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status)
       VALUES ($1, 'VAULT_WITHDRAWAL_REQUEST', $2, $3, 'USDC', 'PENDING')`,
      [userId, withdrawalDescription, withdrawalAmountStr]
    );

    await client.query('COMMIT');
    
    res.status(200).json({ message: 'Withdrawal request submitted successfully. The position is now pending processing.' });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Vault withdrawal request error:', err);
    res.status(500).json({ error: 'An error occurred during the withdrawal request.' });
  } finally {
    client.release();
  }
});


module.exports = router;
