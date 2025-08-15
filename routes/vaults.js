// server/routes/vaults.js
// FINAL VERSION: The fee calculation now correctly queries the new 'pins' table.

const express = require('express');
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const tokenMap = require('../utils/tokens/tokenMap');

const router = express.Router();

async function calculateAuthoritativeFee(dbClient, userId, vaultId, investmentAmount) {
    const tokenDecimals = tokenMap.usdc.decimals;
    const investmentAmountBigNum = ethers.utils.parseUnits(investmentAmount.toString(), tokenDecimals);

    const vaultResult = await dbClient.query('SELECT * FROM vaults WHERE vault_id = $1', [vaultId]);
    const userResult = await dbClient.query('SELECT account_tier FROM users WHERE user_id = $1', [userId]);

    if (vaultResult.rows.length === 0 || userResult.rows.length === 0) {
        throw new Error('User or Vault not found for fee calculation.');
    }
    const theVault = vaultResult.rows[0];
    const theUser = userResult.rows[0];

    const baseFeePct = parseFloat(theVault.fee_percentage) * 100;
    let tierDiscountPct = 0;
    if (theVault.is_fee_tier_based && theUser.account_tier > 1) {
        tierDiscountPct = (theUser.account_tier - 1) * 2.0;
    }

    // --- THE FIX: This query now joins the new 'pins' table with pin_definitions ---
    const userPinsResult = await dbClient.query(`
        SELECT pd.pin_effects_config FROM pins p
        JOIN pin_definitions pd ON p.pin_name = pd.pin_name
        WHERE p.owner_id = $1 AND pd.pin_effects_config->>'deposit_fee_discount_pct' IS NOT NULL;
    `, [userId]);

    let totalPinDiscountPct = 0;
    if (userPinsResult.rows.length > 0) {
        for (const perk of userPinsResult.rows) {
            const discount = parseFloat(perk.pin_effects_config.deposit_fee_discount_pct);
            if (!isNaN(discount)) {
                totalPinDiscountPct += discount;
            }
        }
    }

    let finalFeePct = baseFeePct - tierDiscountPct - totalPinDiscountPct;
    if (finalFeePct < 0.5) finalFeePct = 0.5;
    const finalTradablePct = 100 - finalFeePct;

    const baseFeeAmount = investmentAmountBigNum.mul(Math.round(baseFeePct * 100)).div(10000);
    const finalFeeAmount = investmentAmountBigNum.mul(Math.round(finalFeePct * 100)).div(10000);
    const finalTradableAmount = investmentAmountBigNum.sub(finalFeeAmount);

    return {
        baseFeePct,
        tierDiscountPct,
        totalPinDiscountPct,
        finalFeePct,
        finalTradablePct,
        finalFeeAmount: ethers.utils.formatUnits(finalFeeAmount, tokenDecimals),
        finalTradableAmount: ethers.utils.formatUnits(finalTradableAmount, tokenDecimals)
    };
}

router.post('/calculate-investment-fee', authenticateToken, async (req, res) => {
    const { vaultId, amount } = req.body;
    const userId = req.user.id;
    const numericAmount = parseFloat(amount);
    if (!vaultId || isNaN(numericAmount) || numericAmount <= 0) {
        return res.status(200).json(null);
    }
    const dbClient = await pool.connect();
    try {
        const feeBreakdown = await calculateAuthoritativeFee(dbClient, userId, vaultId, numericAmount);
        res.status(200).json(feeBreakdown);
    } catch (error) {
        console.error('Error in fee calculation endpoint:', error);
        res.status(500).json({ message: "Error calculating fee." });
    } finally {
        if (dbClient) dbClient.release();
    }
});

router.post('/invest', authenticateToken, async (req, res) => {
    const { vaultId, amount } = req.body;
    const userId = req.user.id;
    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');
        
        const numericAmount = parseFloat(amount);
        const tokenDecimals = tokenMap.usdc.decimals;

        const userResult = await dbClient.query('SELECT * FROM users WHERE user_id = $1 FOR UPDATE', [userId]);
        if (userResult.rows.length === 0) throw new Error("User not found.");
        const theUser = userResult.rows[0];

        const userBalanceBigNum = ethers.utils.parseUnits(theUser.balance.toString(), tokenDecimals);
        const investmentAmountBigNum = ethers.utils.parseUnits(numericAmount.toString(), tokenDecimals);

        if (userBalanceBigNum.lt(investmentAmountBigNum)) {
            await dbClient.query('ROLLBACK');
            return res.status(400).json({ messageKey: 'errors.insufficientFunds' });
        }

        const feeBreakdown = await calculateAuthoritativeFee(dbClient, userId, vaultId, numericAmount);
        const newBalanceBigNum = userBalanceBigNum.sub(investmentAmountBigNum);
        
        await dbClient.query('UPDATE users SET balance = $1 WHERE user_id = $2', [ethers.utils.formatUnits(newBalanceBigNum, tokenDecimals), userId]);
        await dbClient.query('INSERT INTO bonus_points (user_id, points_amount, source) VALUES ($1, $2, $3)', [userId, feeBreakdown.finalFeeAmount, `DEPOSIT_FEE_VAULT_${vaultId}`]);
        
        await dbClient.query(
            `INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount, status) 
             VALUES ($1, $2, 'DEPOSIT', $3, 'PENDING_SWEEP')`,
            [userId, vaultId, feeBreakdown.finalTradableAmount]
        );
        
        const feeToDistributeStr = feeBreakdown.finalFeeAmount;
        await dbClient.query(`UPDATE treasury_ledgers SET balance = balance + $1 WHERE ledger_name = 'DEPOSIT_FEES_TOTAL'`, [feeToDistributeStr]);
        const totalDesc = `Total Deposit Fee of ${feeToDistributeStr} from user ${userId} for vault ${vaultId}.`;
        await dbClient.query(`INSERT INTO treasury_transactions (to_ledger_id, amount, description) VALUES ((SELECT ledger_id FROM treasury_ledgers WHERE ledger_name = 'DEPOSIT_FEES_TOTAL'), $1, $2)`, [feeToDistributeStr, totalDesc]);
        
        const allocationDescription = `Allocated ${amount} USDC to Vault ${vaultId}.`;
        await dbClient.query(`INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status) VALUES ($1, 'VAULT_ALLOCATION', $2, $3, 'USDC', 'COMPLETED')`, [userId, allocationDescription, amount]);

        const xpForAmount = investmentAmountBigNum.div(ethers.utils.parseUnits('10', tokenDecimals)).toNumber();
        if (xpForAmount > 0) {
            await dbClient.query('UPDATE users SET xp = xp + $1 WHERE user_id = $2', [xpForAmount, userId]);
        }

        const firstDepositCheck = await dbClient.query("SELECT COUNT(*) FROM vault_ledger_entries WHERE user_id = $1 AND entry_type = 'DEPOSIT'", [userId]);
        if (parseInt(firstDepositCheck.rows[0].count) === 1 && theUser.referred_by_user_id) {
            await dbClient.query('UPDATE users SET xp = xp + $1 WHERE user_id = $2', [xpForAmount, theUser.referred_by_user_id]);
        }

        await dbClient.query('COMMIT');
        res.status(200).json({ message: 'Allocation successful!' });
    } catch (err) {
        if(dbClient) await dbClient.query('ROLLBACK');
        console.error('Allocation transaction error:', err);
        res.status(500).json({ message: 'An error occurred during the allocation process.' });
    } finally {
        if(dbClient) dbClient.release();
    }
});

router.get('/:vaultId/lock-status', authenticateToken, async (req, res) => {
    const { vaultId } = req.params;
    const userId = req.user.id;
    try {
        const vaultLockResult = await pool.query('SELECT lock_period_days FROM vaults WHERE vault_id = $1', [vaultId]);
        if (vaultLockResult.rows.length === 0) {
            return res.status(404).json({ message: 'Vault not found.' });
        }
        const lockPeriodDays = vaultLockResult.rows[0].lock_period_days;

        // If the vault has no lock period, it's never locked.
        if (!lockPeriodDays || lockPeriodDays <= 0) {
            return res.json({ isLocked: false, unlockDate: null });
        }

        const lastDepositResult = await pool.query(
            `SELECT created_at FROM vault_ledger_entries 
             WHERE user_id = $1 AND vault_id = $2 AND entry_type = 'DEPOSIT' 
             ORDER BY created_at DESC LIMIT 1`,
            [userId, vaultId]
        );

        // If there are no deposits, it can't be locked.
        if (lastDepositResult.rows.length === 0) {
            return res.json({ isLocked: false, unlockDate: null });
        }

        const lastDepositDate = new Date(lastDepositResult.rows[0].created_at);
        const lockExpiresDate = new Date(lastDepositDate);
        lockExpiresDate.setDate(lockExpiresDate.getDate() + lockPeriodDays);
        const isCurrentlyLocked = new Date() < lockExpiresDate;

        res.json({
            isLocked: isCurrentlyLocked,
            unlockDate: lockExpiresDate.toISOString()
        });

    } catch (err) {
        console.error(`Error checking lock status for vault ${vaultId}:`, err);
        res.status(500).send('Server Error');
    }
});


// --- UPDATED: The /withdraw route with the simple time lock ---
router.post('/withdraw', authenticateToken, async (req, res) => {
    const { vaultId, amount } = req.body;
    const userId = req.user.id; 
    const client = await pool.connect();
    try {
        const withdrawalAmount = parseFloat(amount);
        if (isNaN(withdrawalAmount) || withdrawalAmount <= 0) {
            return res.status(400).json({ error: 'A valid, positive withdrawal amount is required.' });
        }

        await client.query('BEGIN');

        // Re-checking the lock logic here on the server for security
        const vaultLockResult = await client.query('SELECT lock_period_days FROM vaults WHERE vault_id = $1', [vaultId]);
        const lockPeriodDays = vaultLockResult.rows[0]?.lock_period_days;

        const lastDepositResult = await client.query(
            `SELECT created_at FROM vault_ledger_entries 
             WHERE user_id = $1 AND vault_id = $2 AND entry_type = 'DEPOSIT' 
             ORDER BY created_at DESC LIMIT 1`,
            [userId, vaultId]
        );

        if (lockPeriodDays > 0 && lastDepositResult.rows.length > 0) {
            const lastDepositDate = new Date(lastDepositResult.rows[0].created_at);
            const lockExpiresDate = new Date(lastDepositDate);
            lockExpiresDate.setDate(lockExpiresDate.getDate() + lockPeriodDays);

            if (new Date() < lockExpiresDate) {
                await client.query('ROLLBACK');
                return res.status(400).json({ 
                    error: `Your funds are locked in this vault and cannot be withdrawn until ${lockExpiresDate.toLocaleDateString()}.` 
                });
            }
        }

        const balanceResult = await client.query(
            "SELECT COALESCE(SUM(amount), 0) as current_balance FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2", 
            [userId, vaultId]
        );
        const currentBalance = parseFloat(balanceResult.rows[0].current_balance);

        if (withdrawalAmount > currentBalance) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Withdrawal amount exceeds your capital in this vault.' });
        }

        await client.query(
            `INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount, status) 
             VALUES ($1, $2, 'WITHDRAWAL_REQUEST', $3, 'PENDING_APPROVAL')`, 
            [userId, vaultId, -withdrawalAmount]
        );
        const description = `Requested withdrawal of ${withdrawalAmount.toFixed(2)} USDC from Vault ${vaultId}.`;
        await client.query(
            `INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status) 
             VALUES ($1, 'VAULT_WITHDRAWAL_REQUEST', $2, $3, 'USDC', 'PENDING')`, 
            [userId, description, withdrawalAmount]
        );
        
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
