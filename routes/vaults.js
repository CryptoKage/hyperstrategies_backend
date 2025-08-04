// server/routes/vaults.js

const express = require('express');
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

const router = express.Router();

// --- Allocate Funds to Vault Endpoint (with Revenue Logging) ---
// --- Allocate Funds to Vault Endpoint (with High-Water Mark Logic) ---
router.post('/invest', authenticateToken, async (req, res) => {
  const { vaultId, amount } = req.body;
  const userId = req.user.id;
  const client = await pool.connect();

  try {
    const totalAmount_str = amount.toString();
    if (isNaN(parseFloat(totalAmount_str)) || parseFloat(totalAmount_str) < 100) {
      return res.status(400).json({ error: 'Minimum allocation is $100.' });
    }

    await client.query('BEGIN');

    const [userResult, vaultResult] = await Promise.all([
      client.query('SELECT balance, referred_by_user_id, account_tier FROM users WHERE user_id = $1 FOR UPDATE', [userId]),
      client.query('SELECT fee_percentage, is_fee_tier_based FROM vaults WHERE vault_id = $1', [vaultId])
    ]);
    
    if (userResult.rows.length === 0) throw new Error("User not found during allocation.");
    if (vaultResult.rows.length === 0) throw new Error(`Vault with ID ${vaultId} not found.`);

    const userData = userResult.rows[0];
    const vaultData = vaultResult.rows[0];
    
    const availableBalance_BN = ethers.utils.parseUnits(userData.balance.toString(), 6);
    const totalAmount_BN = ethers.utils.parseUnits(totalAmount_str, 6);

    if (availableBalance_BN.lt(totalAmount_BN)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds.' });
    }

    let finalFeePercentage;
    const baseFeePercentage = parseFloat(vaultData.fee_percentage);

    if (vaultData.is_fee_tier_based) {
      const discountPercentage = (userData.account_tier - 1) * 0.02; 
      finalFeePercentage = baseFeePercentage - discountPercentage;
      finalFeePercentage = Math.max(0.10, finalFeePercentage);
    } else {
      finalFeePercentage = baseFeePercentage;
    }

    const feeMultiplier = Math.round(finalFeePercentage * 100);
    const bonusPointsAmount_BN = totalAmount_BN.mul(feeMultiplier).div(100);
    const tradableAmount_BN = totalAmount_BN.sub(bonusPointsAmount_BN);
    const newBalance_BN = availableBalance_BN.sub(totalAmount_BN);
    const depositFeeAmount = ethers.utils.formatUnits(bonusPointsAmount_BN, 6);

    await client.query('UPDATE users SET balance = $1 WHERE user_id = $2', [ethers.utils.formatUnits(newBalance_BN, 6), userId]);
    
    const lockExpiresAt = new Date();
    lockExpiresAt.setMonth(lockExpiresAt.getMonth() + 1);

    // --- MODIFIED LOGIC FOR HIGH-WATER MARK ---
    const existingPosition = await client.query('SELECT position_id, tradable_capital, high_water_mark FROM user_vault_positions WHERE user_id = $1 AND vault_id = $2 FOR UPDATE', [userId, vaultId]);
    
    if (existingPosition.rows.length > 0) {
      // Logic for adding funds to an EXISTING position
      const currentPosition = existingPosition.rows[0];
      const currentCapital_BN = ethers.utils.parseUnits(currentPosition.tradable_capital.toString(), 6);
      const currentHWM_BN = ethers.utils.parseUnits(currentPosition.high_water_mark.toString(), 6);
      
      const newCapital_BN = currentCapital_BN.add(tradableAmount_BN);
      const newHWM_BN = currentHWM_BN.add(tradableAmount_BN); // Increase HWM by the new capital

      await client.query(
        'UPDATE user_vault_positions SET tradable_capital = $1, high_water_mark = $2, lock_expires_at = $3 WHERE position_id = $4', 
        [
          ethers.utils.formatUnits(newCapital_BN, 6), 
          ethers.utils.formatUnits(newHWM_BN, 6), 
          lockExpiresAt,
          currentPosition.position_id
        ]
      );
    } else {
      // Logic for creating a NEW position
      // The initial high_water_mark is set equal to the initial tradable_capital.
      await client.query(
        `INSERT INTO user_vault_positions 
         (user_id, vault_id, tradable_capital, status, lock_expires_at, high_water_mark) 
         VALUES ($1, $2, $3, 'active', $4, $5)`, 
        [
          userId, 
          vaultId, 
          ethers.utils.formatUnits(tradableAmount_BN, 6), 
          lockExpiresAt, 
          ethers.utils.formatUnits(tradableAmount_BN, 6) // Set initial HWM
        ]
      );
    }
    
    await client.query('INSERT INTO bonus_points (user_id, points_amount) VALUES ($1, $2)', [userId, depositFeeAmount]);
    
        await client.query(
      `UPDATE treasury_ledgers SET balance = balance + $1 WHERE ledger_name = 'DEPOSIT_FEES_TOTAL'`,
      [depositFeeAmount]
    );

    const ledgerDesc = `Deposit fee of ${depositFeeAmount} from user ${userId} for vault ${vaultId}.`;
    await client.query(
      `INSERT INTO treasury_transactions (to_ledger_id, amount, description)
       VALUES ((SELECT ledger_id FROM treasury_ledgers WHERE ledger_name = 'DEPOSIT_FEES_TOTAL'), $1, $2)`,
      [depositFeeAmount, ledgerDesc]
    );
    
    const allocationDescription = `Allocated ${parseFloat(totalAmount_str).toFixed(2)} USDC to Vault ${vaultId}.`;
    await client.query(
      `INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status)
       VALUES ($1, 'VAULT_ALLOCATION', $2, $3, 'USDC', 'COMPLETED')`,
      [userId, allocationDescription, totalAmount_str]
    );

    const xpForAmount = Math.floor(parseFloat(totalAmount_str) / 10);
    if (xpForAmount > 0) {
      await client.query('UPDATE users SET xp = xp + $1 WHERE user_id = $2', [xpForAmount, userId]);
    }
    const positionCheck = await client.query('SELECT COUNT(*) FROM user_vault_positions WHERE user_id = $1', [userId]);
    const isFirstAllocation = parseInt(positionCheck.rows[0].count) === 1;
    if (isFirstAllocation) {
      const referrerId = userData.referred_by_user_id;
      if (referrerId) {
        const referralXP = Math.floor(parseFloat(totalAmount_str) / 10);
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
    const positionResult = await client.query('SELECT tradable_capital, lock_expires_at FROM user_vault_positions WHERE user_id = $1 AND vault_id = $2', [userId, vaultId]);
    if (positionResult.rows.length === 0) {
      return res.status(404).json({ error: 'You do not have a position in this vault.' });
    }
    const position = positionResult.rows[0];
    if (position.lock_expires_at && new Date(position.lock_expires_at) > new Date()) {
      return res.status(403).json({ error: `This position is locked for withdrawal until ${new Date(position.lock_expires_at).toLocaleDateString()}.` });
    }
    const withdrawalAmount = position.tradable_capital;
    const withdrawalDescription = `Requested withdrawal of ${parseFloat(withdrawalAmount).toFixed(2)} USDC from Vault ${vaultId}.`;
    await client.query(
      `INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status)
       VALUES ($1, 'VAULT_WITHDRAWAL_REQUEST', $2, $3, 'USDC', 'PENDING')`,
      [userId, withdrawalDescription, withdrawalAmount]
    );
    await client.query('DELETE FROM user_vault_positions WHERE user_id = $1 AND vault_id = $2', [userId, vaultId]);
    await client.query('COMMIT');
    res.status(200).json({ message: 'Withdrawal request submitted successfully. It may take up to 48 hours to process.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Vault withdrawal request error:', err);
    res.status(500).json({ error: 'An error occurred during the withdrawal request.' });
  } finally {
    client.release();
  }
});

// --- Update Auto-Compound Endpoint ---
router.put('/positions/:vaultId/compound', authenticateToken, async (req, res) => {
  try {
    const { vaultId } = req.params;
    const { autoCompound } = req.body;
    const userId = req.user.id;
    if (typeof autoCompound !== 'boolean') {
      return res.status(400).json({ message: 'Invalid autoCompound value. Must be true or false.' });
    }
    const result = await pool.query(
      `UPDATE user_vault_positions SET auto_compound = $1 WHERE user_id = $2 AND vault_id = $3`,
      [autoCompound, userId, vaultId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'No active position found in this vault.' });
    }
    res.status(200).json({ 
      message: `Auto-compounding has been turned ${autoCompound ? 'ON' : 'OFF'}.`
    });
  } catch (err) {
    console.error('Error updating auto-compound setting:', err);
    res.status(500).send('Server Error');
  }
});

module.exports = router;