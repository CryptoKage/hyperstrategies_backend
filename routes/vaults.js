// server/routes/vaults.js
// FINAL VERSION: The fee calculation now correctly queries the new 'pins' table.

const express = require('express');
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const tokenMap = require('../utils/tokens/tokenMap');
const { calculateActiveEffects } = require('../utils/effectsEngine');
const { awardXp } = require('../utils/xpEngine');
const { ok, fail } = require('../utils/response'); 


const router = express.Router();

async function calculateAuthoritativeFee(dbClient, userId, vaultId, investmentAmount) {
    const tokenDecimals = tokenMap.usdc.decimals;
    const investmentAmountBigNum = ethers.utils.parseUnits(investmentAmount.toString(), tokenDecimals);
    const [vaultResult, userEffects] = await Promise.all([
        dbClient.query('SELECT * FROM vaults WHERE vault_id = $1', [vaultId]),
        calculateActiveEffects(userId, dbClient)
    ]);
    if (vaultResult.rows.length === 0) {
        throw new Error('Vault not found for fee calculation.');
    }
    const theVault = vaultResult.rows[0];
    const baseFeePct = parseFloat(theVault.fee_percentage) * 100;
    const totalPinDiscountPct = userEffects.fee_discount_pct || 0;
    let finalFeePct = baseFeePct - totalPinDiscountPct;
    if (finalFeePct < 0.5) finalFeePct = 0.5;
    const finalTradablePct = 100 - finalFeePct;
    const finalFeeAmount = investmentAmountBigNum.mul(Math.round(finalFeePct * 100)).div(10000);
    const finalTradableAmount = investmentAmountBigNum.sub(finalFeeAmount);
    return {
        baseFeePct, tierDiscountPct: 0, totalPinDiscountPct, finalFeePct,
        finalTradablePct, finalFeeAmountBN: finalFeeAmount,
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
            return res.status(400).json(fail('INSUFFICIENT_FUNDS'));
        }

        const feeBreakdown = await calculateAuthoritativeFee(dbClient, userId, vaultId, numericAmount);
        
        const newBalanceBigNum = userBalanceBigNum.sub(investmentAmountBigNum);
        await dbClient.query('UPDATE users SET balance = $1 WHERE user_id = $2', [ethers.utils.formatUnits(newBalanceBigNum, tokenDecimals), userId]);
        await dbClient.query('INSERT INTO bonus_points (user_id, points_amount, source) VALUES ($1, $2, $3)', [userId, feeBreakdown.finalFeeAmount, `DEPOSIT_FEE_VAULT_${vaultId}`]);
        await dbClient.query(`INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount, fee_amount, status) VALUES ($1, $2, 'DEPOSIT', $3, $4, 'PENDING_SWEEP')`, [userId, vaultId, feeBreakdown.finalTradableAmount, feeBreakdown.finalFeeAmount]);

        const vaultTypeResult = await dbClient.query('SELECT vault_type FROM vaults WHERE vault_id = $1', [vaultId]);
        if (vaultTypeResult.rows[0]?.vault_type === 'FARMING') {
            const activeProtocolsResult = await dbClient.query("SELECT protocol_id FROM farming_protocols WHERE vault_id = $1 AND status = 'FARMING'", [vaultId]);
            for (const protocol of activeProtocolsResult.rows) {
                await dbClient.query(`INSERT INTO farming_contribution_ledger (user_id, vault_id, protocol_id, entry_type, amount) VALUES ($1, $2, $3, 'CONTRIBUTION', $4)`, [userId, vaultId, protocol.protocol_id, feeBreakdown.finalTradableAmount]);
            }
        }

        const allocationDescription = `Allocated ${amount} USDC to Vault ${vaultId}.`;
        await dbClient.query(`INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status) VALUES ($1, 'VAULT_ALLOCATION', $2, $3, 'USDC', 'COMPLETED')`, [userId, allocationDescription, amount]);

        const xpForAmount = investmentAmountBigNum.div(ethers.utils.parseUnits('10', tokenDecimals)).toNumber();
        
        // --- THIS IS THE MAIN FIX: Pass the vaultId to the xpEngine ---
        await awardXp({
            userId: userId,
            xpAmount: xpForAmount,
            type: 'DEPOSIT_BONUS',
            descriptionKey: 'xp_history.deposit_bonus',
            descriptionVars: { amount: xpForAmount.toFixed(2), vaultId: vaultId },
            relatedVaultId: vaultId // Pass the vaultId
        }, dbClient);
        
        const firstDepositCheck = await dbClient.query("SELECT COUNT(*) FROM vault_ledger_entries WHERE user_id = $1 AND entry_type = 'DEPOSIT'", [userId]);
        if (parseInt(firstDepositCheck.rows[0].count) === 1 && theUser.referred_by_user_id) {
            await awardXp({
                userId: theUser.referred_by_user_id,
                xpAmount: xpForAmount,
                type: 'REFERRAL_BONUS',
                descriptionKey: 'xp_history.referral_bonus',
                descriptionVars: { amount: xpForAmount.toFixed(2), username: theUser.username },
                relatedVaultId: vaultId // Also attribute referral bonus to the vault
            }, dbClient);
        }
        
        await dbClient.query('COMMIT');
        res.status(200).json(ok('INVEST_SUCCESS'));

    } catch (err) {
        if(dbClient) await dbClient.query('ROLLBACK');
        console.error('Allocation transaction error:', err);
        res.status(500).json(fail('GENERIC_SERVER_ERROR'));
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
            return res.status(400).json(fail('INVALID_AMOUNT'));
        }
        await client.query('BEGIN');

        const vaultLockResult = await client.query('SELECT lock_period_days FROM vaults WHERE vault_id = $1', [vaultId]);
        const lockPeriodDays = vaultLockResult.rows[0]?.lock_period_days;
        if (lockPeriodDays > 0) {
            const lastDepositResult = await client.query(`SELECT created_at FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2 AND entry_type = 'DEPOSIT' ORDER BY created_at DESC LIMIT 1`, [userId, vaultId]);
            if (lastDepositResult.rows.length > 0) {
                const lockExpiresDate = new Date(lastDepositResult.rows[0].created_at);
                lockExpiresDate.setDate(lockExpiresDate.getDate() + lockPeriodDays);
                if (new Date() < lockExpiresDate) {
                    await client.query('ROLLBACK');
                    return res.status(400).json(fail('FUNDS_LOCKED', { date: lockExpiresDate.toLocaleDateString() }));
                }
            }
        }

        const balanceResult = await client.query("SELECT COALESCE(SUM(amount), 0) as current_balance FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2", [userId, vaultId]);
        const currentBalance = parseFloat(balanceResult.rows[0].current_balance);
        if (withdrawalAmount > currentBalance) {
            await client.query('ROLLBACK');
            return res.status(400).json(fail('WITHDRAWAL_EXCEEDS_CAPITAL'));
        }

        const description = `Requested withdrawal of ${withdrawalAmount.toFixed(2)} USDC from Vault ${vaultId}.`;
        await client.query(`INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status, related_vault_id) VALUES ($1, 'VAULT_WITHDRAWAL_REQUEST', $2, $3, 'USDC', 'PENDING_FUNDING', $4)`, [userId, description, withdrawalAmount, vaultId]);
        
        await client.query('COMMIT');
        res.status(200).json(ok('VAULT_WITHDRAWAL_SUCCESS'));

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Vault withdrawal request error:', err);
        res.status(500).json(fail('GENERIC_SERVER_ERROR'));
    } finally {
        client.release();
    }
});


router.post('/request-transfer', authenticateToken, async (req, res) => {
    const { fromVaultId, toVaultId, amount } = req.body;
    const userId = req.user.id;
    const client = await pool.connect();
    try {
        const transferAmount = parseFloat(amount);
        if (!fromVaultId || !toVaultId || isNaN(transferAmount) || transferAmount <= 0) {
            return res.status(400).json(fail('INVALID_TRANSFER_REQUEST'));
        }
        if (fromVaultId === toVaultId) {
            return res.status(400).json(fail('SAME_SOURCE_DESTINATION'));
        }

        await client.query('BEGIN');

        const balanceResult = await client.query("SELECT COALESCE(SUM(amount), 0) as current_balance FROM vault_ledger_entries WHERE user_id = $1 AND vault_id = $2", [userId, fromVaultId]);
        const currentBalance = parseFloat(balanceResult.rows[0].current_balance);

        if (transferAmount > currentBalance) {
            await client.query('ROLLBACK');
            return res.status(400).json(fail('TRANSFER_EXCEEDS_CAPITAL'));
        }

        await client.query(`INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount, status) VALUES ($1, $2, 'TRANSFER_FUNDS_HELD', $3, 'ACTIVE')`, [userId, fromVaultId, -transferAmount]);
        const transferResult = await client.query(`INSERT INTO vault_transfers (user_id, from_vault_id, to_vault_id, amount, status) VALUES ($1, $2, $3, $4, 'PENDING_UNWIND') RETURNING transfer_id`, [userId, fromVaultId, toVaultId, transferAmount]);
        
        const description = `Requested transfer of ${transferAmount.toFixed(2)} USDC from Vault ${fromVaultId} to Vault ${toVaultId}.`;
        await client.query(`INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status) VALUES ($1, 'VAULT_TRANSFER_REQUEST', $2, $3, 'USDC', 'PENDING')`, [userId, description, transferAmount]);

        await client.query('COMMIT');
        res.status(200).json(ok('TRANSFER_REQUEST_SUCCESS', {}, { transferId: transferResult.rows[0].transfer_id }));

    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505' && err.constraint === 'uq_one_pending_transfer_per_vault_pair') {
            return res.status(409).json(fail('DUPLICATE_TRANSFER_REQUEST'));
        }
        console.error('Vault transfer request error:', err);
        res.status(500).json(fail('GENERIC_SERVER_ERROR'));
    } finally {
        client.release();
    }
});

module.exports = router;
