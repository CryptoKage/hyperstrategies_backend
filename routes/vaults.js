// server/routes/vaults.js
// FINAL CORRECTED VERSION: Reads the correct 'id' from JWT and uses 'user_id' for all database queries.

const express = require('express');
const { ethers } = require('ethers');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const tokenMap = require('../utils/tokens/tokenMap');


const router = express.Router();

router.post('/invest', authenticateToken, async (req, res) => {
    const { vaultId, amount } = req.body;
    const userId = req.user.id; 
    const dbClient = await pool.connect();
    try {
        const investmentAmountStr = amount.toString();
        const vaultDataResult = await dbClient.query('SELECT * FROM vaults WHERE vault_id = $1', [vaultId]);
        if (vaultDataResult.rows.length === 0) throw new Error(`Vault ${vaultId} not found.`);
        
        const theVault = vaultDataResult.rows[0];
        const tokenDecimals = tokenMap.usdc.decimals;
        
        const decimalPattern = new RegExp(`^\\d+(\\.\\d{1,${tokenDecimals}})?$`);
        if (!decimalPattern.test(investmentAmountStr)) { return res.status(400).json({ messageKey: 'errors.invalidAmountFormat' }); }

        const investmentAmountBigNum = ethers.utils.parseUnits(investmentAmountStr, tokenDecimals);
        const minAllocationBigNum = ethers.utils.parseUnits((theVault.min_allocation_usd || '100').toString(), tokenDecimals);
        if (investmentAmountBigNum.lt(minAllocationBigNum)) {
            return res.status(400).json({ messageKey: 'errors.minimumAllocation' });
        }

        await dbClient.query('BEGIN');
        const userResult = await dbClient.query('SELECT * FROM users WHERE user_id = $1 FOR UPDATE', [userId]);
        if (userResult.rows.length === 0) throw new Error("User not found.");
        const theUser = userResult.rows[0];

        const userBalanceBigNum = ethers.utils.parseUnits(theUser.balance.toString(), tokenDecimals);
        if (userBalanceBigNum.lt(investmentAmountBigNum)) {
            await dbClient.query('ROLLBACK');
            return res.status(400).json({ messageKey: 'errors.insufficientFunds' });
        }

        // --- Re-calculating the fee here to ensure server-side authority ---
        const baseFeePercentage = parseFloat(theVault.fee_percentage);
        let finalFeePercentage = baseFeePercentage;
        if (theVault.is_fee_tier_based) {
            const tierDiscount = (theUser.account_tier - 1) * 0.02;
            finalFeePercentage = Math.max(0.10, baseFeePercentage - tierDiscount);
        }

        const userPinsResult = await dbClient.query(`SELECT pd.pin_effects_config FROM user_pins up JOIN pin_definitions pd ON up.pin_name = pd.pin_name WHERE up.user_id = $1 AND pd.pin_effects_config->>'deposit_fee_discount_pct' IS NOT NULL;`, [userId]);
        let pinDiscountPercentage = 0;
        if (userPinsResult.rows.length > 0) {
            for (const perk of userPinsResult.rows) {
                const effects = perk.pin_effects_config;
                if(effects && effects.deposit_fee_discount_pct) {
                    const currentPinDiscount = parseFloat(effects.deposit_fee_discount_pct);
                    if (currentPinDiscount > pinDiscountPercentage) pinDiscountPercentage = currentPinDiscount;
                }
            }
        }
        
        const finalFeeAfterPins = finalFeePercentage * (1 - (pinDiscountPercentage / 100.0));
        const finalizedFeeComponent = investmentAmountBigNum.mul(Math.round(finalFeeAfterPins * 10000)).div(10000);
        const capitalForTrade = investmentAmountBigNum.sub(finalizedFeeComponent);
        const newBalanceBigNum = userBalanceBigNum.sub(investmentAmountBigNum);
        
        await dbClient.query('UPDATE users SET balance = $1 WHERE user_id = $2', [ethers.utils.formatUnits(newBalanceBigNum, tokenDecimals), userId]);
        await dbClient.query('INSERT INTO bonus_points (user_id, points_amount, source) VALUES ($1, $2, $3)', [userId, ethers.utils.formatUnits(finalizedFeeComponent, tokenDecimals), `DEPOSIT_FEE_VAULT_${vaultId}`]);
        await dbClient.query(`INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount, status) VALUES ($1, $2, 'DEPOSIT', $3, 'PENDING_SWEEP')`, [userId, vaultId, ethers.utils.formatUnits(capitalForTrade, tokenDecimals)]);
        
        // Your treasury and XP logic was also broken by my incorrect column names.
        // It has been corrected to use 'user_id' where appropriate.
        const feeToDistributeStr = ethers.utils.formatUnits(finalizedFeeComponent, tokenDecimals);
        await dbClient.query(`UPDATE treasury_ledgers SET balance = balance + $1 WHERE ledger_name = 'DEPOSIT_FEES_TOTAL'`, [feeToDistributeStr]);
        const totalDesc = `Total Deposit Fee of ${feeToDistributeStr} from user ${userId} for vault ${vaultId}.`;
        await dbClient.query(`INSERT INTO treasury_transactions (to_ledger_id, amount, description) VALUES ((SELECT ledger_id FROM treasury_ledgers WHERE ledger_name = 'DEPOSIT_FEES_TOTAL'), $1, $2)`, [feeToDistributeStr, totalDesc]);
        
        const allocationDescription = `Allocated ${investmentAmountStr} USDC to Vault ${vaultId}.`;
        await dbClient.query(`INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status) VALUES ($1, 'VAULT_ALLOCATION', $2, $3, 'USDC', 'COMPLETED')`, [userId, allocationDescription, investmentAmountStr]);

        const xpForAmount = investmentAmountBigNum.div(ethers.utils.parseUnits('10', tokenDecimals)).toNumber();
        if (xpForAmount > 0) {
            // --- THE FIX: Award XP using the correct column 'user_id' ---
            await dbClient.query('UPDATE users SET xp = xp + $1 WHERE user_id = $2', [xpForAmount, userId]);
        }

        const firstDepositCheck = await dbClient.query("SELECT COUNT(*) FROM vault_ledger_entries WHERE user_id = $1 AND transaction_type = 'DEPOSIT'", [userId]);
        if (parseInt(firstDepositCheck.rows[0].count) === 1 && theUser.referred_by_user_id) {
            // --- THE FIX: Award referral XP using the correct column 'user_id' ---
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

router.post('/calculate-investment-fee', authenticateToken, async (req, res) => {
const { vaultId, amount } = req.body;
const userId = req.user.id;

const numericAmount = parseFloat(amount);
if (!vaultId || isNaN(numericAmount) || numericAmount <= 0) {
    return res.status(200).json({ baseFee: '0', finalFee: '0' });
}
const dbClient = await pool.connect();
try {
    const vaultResult = await dbClient.query('SELECT * FROM vaults WHERE vault_id = $1', [vaultId]);
    const userResult = await dbClient.query('SELECT account_tier FROM users WHERE user_id = $1', [userId]);

    if (vaultResult.rows.length === 0 || userResult.rows.length === 0) {
        throw new Error('User or Vault not found for fee calculation.');
    }
    const theVault = vaultResult.rows[0];
    const theUser = userResult.rows[0];
    
    // --- THIS IS THE CORE LOGIC CHANGE ---
    // Use USDC decimals from our tokenMap, and get fee_percentage
    const tokenDecimals = tokenMap.usdc.decimals;
    const baseFeePercentage = parseFloat(theVault.fee_percentage); // e.g., 0.20
    const investmentAmountBigNum = ethers.utils.parseUnits(numericAmount.toFixed(tokenDecimals), tokenDecimals);

    const baseFeeComponent = investmentAmountBigNum.mul(Math.round(baseFeePercentage * 10000)).div(10000);

    let finalFeePercentage = baseFeePercentage;
    if (theVault.is_fee_tier_based) {
        const tierDiscount = (theUser.account_tier - 1) * 0.02; // e.g., 0.02 for Tier 2
        finalFeePercentage = Math.max(0.10, baseFeePercentage - tierDiscount);
    }

    const userPinsResult = await dbClient.query(`
        SELECT pd.pin_name, pd.pin_effects_config FROM user_pins up
        JOIN pin_definitions pd ON up.pin_name = pd.pin_name
        WHERE up.user_id = $1 AND pd.pin_effects_config->>'deposit_fee_discount_pct' IS NOT NULL;
    `, [userId]);

    let pinDiscountPercentage = 0;
    let bestPinName = null;
    if (userPinsResult.rows.length > 0) {
        for (const perk of userPinsResult.rows) {
            const effects = perk.pin_effects_config;
            if(effects && effects.deposit_fee_discount_pct) {
                const currentPinDiscount = parseFloat(effects.deposit_fee_discount_pct);
                if (currentPinDiscount > pinDiscountPercentage) {
                    pinDiscountPercentage = currentPinDiscount;
                    bestPinName = perk.pin_name;
                }
            }
        }
    }
    
    const finalFeeAfterPins = finalFeePercentage * (1 - (pinDiscountPercentage / 100.0));
    const finalizedFeeComponent = investmentAmountBigNum.mul(Math.round(finalFeeAfterPins * 10000)).div(10000);

    const feeBreakdownPayload = {
        baseFee: ethers.utils.formatUnits(baseFeeComponent, tokenDecimals),
        finalFee: ethers.utils.formatUnits(finalizedFeeComponent, tokenDecimals),
        hasPinDiscount: pinDiscountPercentage > 0,
        pinDiscountPercentage: pinDiscountPercentage.toString(),
        pinName: bestPinName,
        netInvestment: ethers.utils.formatUnits(investmentAmountBigNum.sub(finalizedFeeComponent), tokenDecimals)
    };
    res.status(200).json(feeBreakdownPayload);

} catch (error) {
    console.error('Error in fee calculation endpoint:', error);
    res.status(200).json({ baseFee: '0', finalFee: '0', netInvestment: '0' });
} finally {
    if (dbClient) dbClient.release();
}
});

// Your withdrawal code, corrected to use the right JWT property.
router.post('/withdraw', authenticateToken, async (req, res) => {
    const { vaultId, amount } = req.body;
    // --- THE FIX: Read 'id' from the JWT payload ---
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
      await client.query(`INSERT INTO vault_ledger_entries (user_id, vault_id, transaction_type, amount, status) VALUES ($1, $2, 'WITHDRAWAL_REQUEST', $3, 'PENDING_APPROVAL')`, [userId, vaultId, -withdrawalAmount]);
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
