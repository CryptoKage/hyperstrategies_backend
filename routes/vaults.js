// server/routes/vaults.js

const express = require('express');
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
// --- ANNOTATION --- We're not using tierUtils anymore, as the logic is more complex.

const router = express.Router();

// --- ANNOTATION --- A helper function to get the fee for a tier.
// We define it here since this is the only file that needs it right now.
const getFeePercentageForTier = (accountTier) => {
  switch (accountTier) {
    case 4: return 0.14; // 14%
    case 3: return 0.16; // 16%
    case 2: return 0.18; // 18%
    case 1:
    default: return 0.20; // 20%
  }
};

// --- Allocate Funds to Vault Endpoint (UPGRADED V2) ---
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

    // --- ANNOTATION --- We now run two queries in parallel to get user and vault data.
    const [userResult, vaultResult] = await Promise.all([
      client.query('SELECT balance, referred_by_user_id, account_tier FROM users WHERE user_id = $1 FOR UPDATE', [userId]),
      client.query('SELECT fee_percentage FROM vaults WHERE vault_id = $1', [vaultId])
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

    // --- ANNOTATION --- New Dynamic Fee Logic
    // 1. Get the vault's base fee from the database.
    const baseFeePercentage = parseFloat(vaultData.fee_percentage); // e.g., 0.20
    
    // 2. Calculate the tier-based discount.
    // Tiers 1,2,3,4 provide discounts of 0%, 2%, 4%, 6% respectively
    const discountPercentage = (userData.account_tier - 1) * 0.02; 
    
    // 3. Calculate the final, effective fee.
    let finalFeePercentage = baseFeePercentage - discountPercentage;
    // Ensure the fee doesn't go below a minimum (e.g., 10%)
    finalFeePercentage = Math.max(0.10, finalFeePercentage); 

    const feeMultiplier = Math.round(finalFeePercentage * 100);
    
    const bonusPointsAmount_BN = totalAmount_BN.mul(feeMultiplier).div(100);
    const tradableAmount_BN = totalAmount_BN.sub(bonusPointsAmount_BN);
    
    const newBalance_BN = availableBalance_BN.sub(totalAmount_BN);

    await client.query('UPDATE users SET balance = $1 WHERE user_id = $2', [ethers.utils.formatUnits(newBalance_BN, 6), userId]);
    
    const lockExpiresAt = new Date();
    lockExpiresAt.setMonth(lockExpiresAt.getMonth() + 1);

    const existingPosition = await client.query('SELECT tradable_capital FROM user_vault_positions WHERE user_id = $1 AND vault_id = $2', [userId, vaultId]);
    if (existingPosition.rows.length > 0) {
      const currentCapital_BN = ethers.utils.parseUnits(existingPosition.rows[0].tradable_capital.toString(), 6);
      const newCapital_BN = currentCapital_BN.add(tradableAmount_BN);
      await client.query('UPDATE user_vault_positions SET tradable_capital = $1, lock_expires_at = $2 WHERE user_id = $3 AND vault_id = $4', [ethers.utils.formatUnits(newCapital_BN, 6), lockExpiresAt, userId, vaultId]);
    } else {
      await client.query('INSERT INTO user_vault_positions (user_id, vault_id, tradable_capital, lock_expires_at, status) VALUES ($1, $2, $3, $4, $5)', [userId, vaultId, ethers.utils.formatUnits(tradableAmount_BN, 6), lockExpiresAt, 'active']);
    }
    
    await client.query('INSERT INTO bonus_points (user_id, points_amount) VALUES ($1, $2)', [userId, ethers.utils.formatUnits(bonusPointsAmount_BN, 6)]);
    
    const allocationDescription = `Allocated ${parseFloat(totalAmount_str).toFixed(2)} USDC to Vault ${vaultId}.`;
    await client.query(
      `INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status)
       VALUES ($1, 'VAULT_ALLOCATION', $2, $3, 'USDC', 'COMPLETED')`,
      [userId, allocationDescription, totalAmount_str]
    );

    // --- XP Logic (no changes needed) ---
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


// --- Withdraw From Vault Endpoint (UPGRADED) ---
// --- ANNOTATION --- This is now a WITHDRAWAL REQUEST endpoint. It doesn't move money instantly.
router.post('/withdraw', authenticateToken, async (req, res) => {
  const { vaultId } = req.body; // We no longer need amount, we withdraw the whole position.
  const userId = req.user.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- ANNOTATION --- Check the lock-in period first!
    const positionResult = await client.query('SELECT tradable_capital, lock_expires_at FROM user_vault_positions WHERE user_id = $1 AND vault_id = $2', [userId, vaultId]);
    if (positionResult.rows.length === 0) {
      return res.status(404).json({ error: 'You do not have a position in this vault.' });
    }
    const position = positionResult.rows[0];

    if (position.lock_expires_at && new Date(position.lock_expires_at) > new Date()) {
      return res.status(403).json({ error: `This position is locked for withdrawal until ${new Date(position.lock_expires_at).toLocaleDateString()}.` });
    }

    const withdrawalAmount = position.tradable_capital;

    // --- ANNOTATION --- Instead of moving money, we create a withdrawal request in our activity log.
    // A separate backend job will process these.
    const withdrawalDescription = `Requested withdrawal of ${parseFloat(withdrawalAmount).toFixed(2)} USDC from Vault ${vaultId}.`;
    await client.query(
      `INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status)
       VALUES ($1, 'VAULT_WITHDRAWAL_REQUEST', $2, $3, 'USDC', 'PENDING')`,
      [userId, withdrawalDescription, withdrawalAmount]
    );

    // --- ANNOTATION --- We also remove the position from the user_vault_positions table so they can't request it again.
    // The capital is now "in transit" managed by the withdrawal queue.
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

router.put('/positions/:vaultId/compound', authenticateToken, async (req, res) => {
  try {
    const { vaultId } = req.params;
    const { autoCompound } = req.body;
    const userId = req.user.id;

    // --- Validation ---
    if (typeof autoCompound !== 'boolean') {
      return res.status(400).json({ message: 'Invalid autoCompound value. Must be true or false.' });
    }

    // --- Database Update ---
    const result = await pool.query(
      `UPDATE user_vault_positions
       SET auto_compound = $1
       WHERE user_id = $2 AND vault_id = $3`,
      [autoCompound, userId, vaultId]
    );

    // Check if any row was actually updated. If not, the user doesn't have a position there.
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