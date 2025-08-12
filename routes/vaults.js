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
    const dbClient = await pool.connect();

    try {
        const investmentAmountStr = amount.toString();
        const vaultDataResult = await dbClient.query('SELECT * FROM vaults WHERE id = $1', [vaultId]);
        if (vaultDataResult.rows.length === 0) throw new Error(`Vault ${vaultId} not found.`);
        const theVault = vaultDataResult.rows[0];
        const tokenDecimals = theVault.token_decimals;

        // --- Input Validation (Preserved from old logic) ---
        const decimalPattern = new RegExp(`^\\d+(\\.\\d{1,${tokenDecimals}})?$`);
        if (!decimalPattern.test(investmentAmountStr)) {
            return res.status(400).json({ messageKey: 'errors.invalidAmountFormat' });
        }

        const investmentAmountBigNum = ethers.utils.parseUnits(investmentAmountStr, tokenDecimals);
        const minAllocationBigNum = ethers.utils.parseUnits(theVault.min_allocation_usd || '100', tokenDecimals);
        if (investmentAmountBigNum.lt(minAllocationBigNum)) {
            return res.status(400).json({ messageKey: 'errors.minimumAllocation', context: { min: theVault.min_allocation_usd || '100' } });
        }

        await dbClient.query('BEGIN');

        // --- Fetch User Data (Preserved from old logic) ---
        const userResult = await dbClient.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        if (userResult.rows.length === 0) throw new Error("User not found.");
        const theUser = userResult.rows[0];

        const userBalanceBigNum = ethers.BigNumber.from(theUser.balance);
        if (userBalanceBigNum.lt(investmentAmountBigNum)) {
            await dbClient.query('ROLLBACK');
            return res.status(400).json({ messageKey: 'errors.insufficientFunds' });
        }

        // --- FEE CALCULATION (MERGED LOGIC: Tiers + Pins) ---
        let feeBasisPointsAfterTiers = ethers.BigNumber.from(theVault.deposit_fee_bps);

        // 1. Apply Tier-Based Discount first
        if (theVault.is_fee_tier_based) {
            const tierDiscountBps = (theUser.account_tier - 1) * 200; // 2% per tier = 200 bps
            feeBasisPointsAfterTiers = feeBasisPointsAfterTiers.sub(tierDiscountBps);
            // Ensure fee doesn't go below a minimum floor if one is set (e.g. 1% = 100 bps)
            if (feeBasisPointsAfterTiers.lt(100)) feeBasisPointsAfterTiers = ethers.BigNumber.from(100);
        }

        // 2. Apply Pin-Based Discount on top of the tier-adjusted fee
        const userPinsResult = await dbClient.query(`
            SELECT pd.pin_effects_config FROM user_pins up
            JOIN pin_definitions pd ON up.pin_name = pd.pin_name
            WHERE up.user_id = $1 AND pd.pin_effects_config IS NOT NULL;
        `, [userId]);

        let pinDiscountRate = ethers.BigNumber.from(0); // 0% pin discount by default
        if (userPinsResult.rows.length > 0) {
            for (const perk of userPinsResult.rows) {
                const effects = perk.pin_effects_config;
                if (effects && effects.fee_discount_pct) {
                    const currentPinDiscount = ethers.BigNumber.from(effects.fee_discount_pct);
                    if (currentPinDiscount.gt(pinDiscountRate)) {
                        pinDiscountRate = currentPinDiscount; // Use the best Pin discount
                    }
                }
            }
        }
        console.log(`User ${userId} has Tier discount + Pin discount of ${pinDiscountRate.toString()}%`);

        const discountMultiplier = ethers.BigNumber.from(100).sub(pinDiscountRate);
        const finalFeeBasisPoints = feeBasisPointsAfterTiers.mul(discountMultiplier).div(100);

        // --- Final Capital Calculation ---
        const finalizedFeeComponent = investmentAmountBigNum.mul(finalFeeBasisPoints).div(10000);
        const capitalForTrade = investmentAmountBigNum.sub(finalizedFeeComponent);
        const awardedBonusPoints = finalizedFeeComponent.div(ethers.utils.parseUnits('1', tokenDecimals - 2));

        // --- UPDATE DATABASE (All logic preserved and merged) ---
        const newBalanceBigNum = userBalanceBigNum.sub(investmentAmountBigNum);
        await dbClient.query('UPDATE users SET balance = $1, bonus_points = bonus_points + $2 WHERE id = $3', [newBalanceBigNum.toString(), awardedBonusPoints.toString(), userId]);

        await dbClient.query(
            `INSERT INTO vault_ledger_entries (user_id, vault_id, transaction_type, amount, fee_paid, status) VALUES ($1, $2, 'DEPOSIT', $3, $4, 'PENDING_SWEEP')`,
            [userId, vaultId, capitalForTrade.toString(), finalizedFeeComponent.toString()]
        );

        // --- PRESERVED V1 LOGIC: Treasury & XP Distribution ---
        const feeToDistributeStr = ethers.utils.formatUnits(finalizedFeeComponent, tokenDecimals);
        const depositFeeSplits = { 'DEPOSIT_FEES_LP_SEEDING': 1, 'DEPOSIT_FEES_LP_REWARDS': 15, 'DEPOSIT_FEES_TEAM': 25, 'DEPOSIT_FEES_TREASURY': 20, 'DEPOSIT_FEES_COMMUNITY': 20, 'DEPOSIT_FEES_BUYBACK': 10, 'DEPOSIT_FEES_STRATEGIC': 9 };
        
        await dbClient.query(`UPDATE treasury_ledgers SET balance = balance + $1 WHERE ledger_name = 'DEPOSIT_FEES_TOTAL'`, [feeToDistributeStr]);
        const totalDesc = `Total Deposit Fee of ${feeToDistributeStr} from user ${userId} for vault ${vaultId}.`;
        await dbClient.query(`INSERT INTO treasury_transactions (to_ledger_id, amount, description) VALUES ((SELECT id FROM treasury_ledgers WHERE ledger_name = 'DEPOSIT_FEES_TOTAL'), $1, $2)`, [feeToDistributeStr, totalDesc]);
        
        for (const ledgerName in depositFeeSplits) {
            const pct = depositFeeSplits[ledgerName];
            const splitAmount = finalizedFeeComponent.mul(pct).div(100);
            if (!splitAmount.isZero()) {
                const splitAmountFormatted = ethers.utils.formatUnits(splitAmount, tokenDecimals);
                await dbClient.query(`UPDATE treasury_ledgers SET balance = balance + $1 WHERE ledger_name = $2`, [splitAmountFormatted, ledgerName]);
            }
        }

        const allocationDescription = `Allocated ${investmentAmountStr} USDC to Vault ${vaultId}.`;
        await dbClient.query(`INSERT INTO user_activity_log (user_id, activity_type, description, amount_primary, symbol_primary, status) VALUES ($1, 'VAULT_ALLOCATION', $2, $3, 'USDC', 'COMPLETED')`, [userId, allocationDescription, investmentAmountStr]);

        const xpForAmount = investmentAmountBigNum.div(ethers.utils.parseUnits('10', tokenDecimals)).toNumber();
        if (xpForAmount > 0) {
            await dbClient.query('UPDATE users SET xp = xp + $1 WHERE id = $2', [xpForAmount, userId]);
        }

        const firstDepositCheck = await dbClient.query("SELECT COUNT(*) FROM vault_ledger_entries WHERE user_id = $1 AND transaction_type = 'DEPOSIT'", [userId]);
        if (parseInt(firstDepositCheck.rows[0].count) === 1 && theUser.referred_by_user_id) {
            await dbClient.query('UPDATE users SET xp = xp + $1 WHERE id = $2', [xpForAmount, theUser.referred_by_user_id]);
            console.log(`Awarded ${xpForAmount} referral XP to user ${theUser.referred_by_user_id}.`);
        }
        // --- END OF PRESERVED LOGIC ---

        await dbClient.query('COMMIT');
        res.status(200).json({ message: 'Allocation successful!' });

    } catch (err) {
        await dbClient.query('ROLLBACK');
        console.error('Allocation transaction error:', err);
        res.status(500).json({ message: 'An error occurred during the allocation process.' });
    } finally {
        dbClient.release();
    }
});

router.post('/calculate-investment-fee', authenticateToken, async (req, res) => {
    // This is a read-only endpoint to preview fees. No transactions are made.
    const { vaultId, amount } = req.body;
    const userId = req.user.id;

    const numericAmount = parseFloat(amount);
    if (!vaultId || isNaN(numericAmount) || numericAmount <= 0) {
        // Silently fail if input is invalid, as this is a preview endpoint
        return res.status(200).json({ baseFee: '0', finalFee: '0' });
    }

    const dbClient = await pool.connect();
    try {
        // --- Fetch Vault and User Data ---
        const vaultResult = await dbClient.query('SELECT * FROM vaults WHERE id = $1', [vaultId]);
        const userResult = await dbClient.query('SELECT account_tier FROM users WHERE id = $1', [userId]);

        if (vaultResult.rows.length === 0 || userResult.rows.length === 0) {
            throw new Error('User or Vault not found for fee calculation.');
        }

        const theVault = vaultResult.rows[0];
        const theUser = userResult.rows[0];
        const tokenDecimals = theVault.token_decimals;
        const investmentAmountBigNum = ethers.utils.parseUnits(numericAmount.toFixed(tokenDecimals), tokenDecimals);

        // --- Perform the same fee logic as the /invest endpoint ---

        // 1. Calculate the base fee (before any discounts)
        const baseFeeBasisPoints = ethers.BigNumber.from(theVault.deposit_fee_bps);
        const baseFeeComponent = investmentAmountBigNum.mul(baseFeeBasisPoints).div(10000);

        // 2. Apply Tier-Based Discount
        let feeBasisPointsAfterTiers = ethers.BigNumber.from(theVault.deposit_fee_bps);
        if (theVault.is_fee_tier_based) {
            const tierDiscountBps = (theUser.account_tier - 1) * 200; // 2% per tier
            feeBasisPointsAfterTiers = feeBasisPointsAfterTiers.sub(tierDiscountBps);
            if (feeBasisPointsAfterTiers.lt(100)) feeBasisPointsAfterTiers = ethers.BigNumber.from(100);
        }

        // 3. Apply Pin-Based Discount
        const userPinsResult = await dbClient.query(`
            SELECT pd.pin_name, pd.pin_effects_config FROM user_pins up
            JOIN pin_definitions pd ON up.pin_name = pd.pin_name
            WHERE up.user_id = $1 AND pd.pin_effects_config->>'fee_discount_pct' IS NOT NULL;
        `, [userId]);

        let pinDiscountRate = ethers.BigNumber.from(0);
        let bestPinName = null;
        if (userPinsResult.rows.length > 0) {
            for (const perk of userPinsResult.rows) {
                const effects = perk.pin_effects_config;
                const currentPinDiscount = ethers.BigNumber.from(effects.fee_discount_pct);
                if (currentPinDiscount.gt(pinDiscountRate)) {
                    pinDiscountRate = currentPinDiscount;
                    bestPinName = perk.pin_name;
                }
            }
        }
        
        // --- Calculate the final fee ---
        const discountMultiplier = ethers.BigNumber.from(100).sub(pinDiscountRate);
        const finalFeeBasisPoints = feeBasisPointsAfterTiers.mul(discountMultiplier).div(100);
        const finalizedFeeComponent = investmentAmountBigNum.mul(finalFeeBasisPoints).div(10000);

        // --- Prepare the response payload ---
        const feeBreakdownPayload = {
            baseFee: ethers.utils.formatUnits(baseFeeComponent, tokenDecimals),
            finalFee: ethers.utils.formatUnits(finalizedFeeComponent, tokenDecimals),
            hasPinDiscount: !pinDiscountRate.isZero(),
            pinDiscountPercentage: pinDiscountRate.toString(),
            pinName: bestPinName,
            netInvestment: ethers.utils.formatUnits(investmentAmountBigNum.sub(finalizedFeeComponent), tokenDecimals)
        };

        res.status(200).json(feeBreakdownPayload);

    } catch (error) {
        console.error('Error in fee calculation endpoint:', error);
        // Don't send a 500, as it could break the frontend UI. Send a neutral response.
        res.status(200).json({ baseFee: '0', finalFee: '0' });
    } finally {
        dbClient.release();
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
    await client.query(`INSERT INTO vault_ledger_entries (user_id, vault_id, entry_type, amount, status) VALUES ($1, $2, 'WITHDRAWAL_REQUEST', $3, 'PENDING_APPROVAL')`, [userId, vaultId, -withdrawalAmount]);
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
