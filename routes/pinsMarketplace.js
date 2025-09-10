// pinsmarketplace.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { ethers } = require('ethers'); // Using ethers for safe financial math
const authenticateToken = require('../middleware/authenticateToken');
const requireTier = require('../middleware/requireTier');
const { body, param, validationResult } = require('express-validator');

const MAX_PRICE = 1000000;
const MARKETPLACE_FEE_PERCENTAGE = 0.0025; // 0.25%

// All marketplace routes require authentication and a minimum account tier.
router.use(authenticateToken);
router.use(requireTier(2)); // Example: Tier 2 required to use the marketplace

// --- GET All Active Pin Listings ---
// This query is now more powerful, joining multiple tables to provide all necessary data to the frontend.
router.get('/listings', async (req, res) => {
  try {
    // 1. Define allowed filters and sort options to prevent SQL injection
    const allowedSortBy = ['price', 'created_at'];
    const { filterByPinName, sortBy, order = 'DESC' } = req.query;
    
    // 2. Start building the SQL query
    let query = `
      SELECT 
         l.listing_id, l.price, l.created_at,
         p.pin_id,
         u.username as seller_username,
         pd.pin_name, pd.pin_description, pd.image_filename
       FROM pin_listings l
       JOIN pins p ON l.pin_id = p.pin_id
       JOIN pin_definitions pd ON p.pin_name = pd.pin_name
       JOIN users u ON l.seller_id = u.user_id
       WHERE l.status = 'ACTIVE'
    `;
    const queryParams = [];

    // 3. Dynamically add a WHERE clause for filtering
    if (filterByPinName) {
      queryParams.push(filterByPinName);
      query += ` AND pd.pin_name = $${queryParams.length}`;
    }

    // 4. Dynamically and SAFELY add an ORDER BY clause for sorting
    const sortColumn = allowedSortBy.includes(sortBy) ? sortBy : 'created_at'; // Default sort
    const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC'; // Default order
    query += ` ORDER BY l.${sortColumn} ${sortOrder}`;

    // 5. Execute the final, constructed query
    const { rows } = await pool.query(query, queryParams);
    res.json(rows);

  } catch (err) {
    console.error('Error fetching pin listings:', err);
    res.status(500).send('Server Error');
  }
});

// --- List a Unique Pin for Sale ---
router.post(
  '/listings/list',
  [
    body('pinId').isInt({ gt: 0 }).withMessage('A valid pinId is required.'),
    body('price').isFloat({ gt: 0, lt: MAX_PRICE }).withMessage(`Price must be a positive number below ${MAX_PRICE}.`),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { pinId, price } = req.body;
    const userId = req.user.id;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Verify the user owns this specific pin instance
      const pinOwnership = await client.query('SELECT owner_id FROM pins WHERE pin_id = $1 FOR UPDATE', [pinId]);
      if (pinOwnership.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Pin not found.' });
      }
      if (pinOwnership.rows[0].owner_id !== userId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'You do not own this pin.' });
      }

      // 2. Verify this specific pin instance is not already listed
      const existingListing = await client.query("SELECT listing_id FROM pin_listings WHERE pin_id = $1 AND status = 'ACTIVE'", [pinId]);
      if (existingListing.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This pin is already listed for sale.' });
      }

      // 3. Create the new listing
      await client.query(
        "INSERT INTO pin_listings (pin_id, seller_id, price, status) VALUES ($1, $2, $3, 'ACTIVE')",
        [pinId, userId, price]
      );

      await client.query('COMMIT');
      res.status(201).json({ message: 'Your pin has been successfully listed for sale.' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error listing pin:', err);
      res.status(500).send('Server Error');
    } finally {
      client.release();
    }
  }
);

// --- Buy a Pin Listing ---
router.post(
  '/listings/:listingId/buy',
  [param('listingId').isInt({ gt: 0 }).withMessage('A valid listingId is required.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { listingId } = req.params;
    const buyerId = req.user.id;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Get and lock the listing to prevent race conditions
      const listingResult = await client.query("SELECT * FROM pin_listings WHERE listing_id = $1 FOR UPDATE", [listingId]);
      if (listingResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Listing not found.' });
      }

      const listing = listingResult.rows[0];
      if (listing.status !== 'ACTIVE') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'This listing is no longer active.' });
      }
      if (listing.seller_id === buyerId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'You cannot buy your own pin.' });
      }

      // 2. Check buyer's balance
      const buyerResult = await client.query('SELECT balance FROM users WHERE user_id = $1 FOR UPDATE', [buyerId]);
      const buyerBalance = ethers.utils.parseUnits(buyerResult.rows[0].balance.toString(), 6); // Assuming 6 decimals for USDC
      const listingPrice = ethers.utils.parseUnits(listing.price.toString(), 6);

      if (buyerBalance.lt(listingPrice)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient USDC balance.' });
      }

      // 3. Calculate fees and proceeds
      const feeAmount = listingPrice.mul(Math.round(MARKETPLACE_FEE_PERCENTAGE * 10000)).div(10000);
      const sellerProceeds = listingPrice.sub(feeAmount);

      // 4. Perform the atomic swap of funds and ownership
      await client.query('UPDATE users SET balance = balance - $1 WHERE user_id = $2', [ethers.utils.formatUnits(listingPrice, 6), buyerId]);
      await client.query('UPDATE users SET balance = balance + $1 WHERE user_id = $2', [ethers.utils.formatUnits(sellerProceeds, 6), listing.seller_id]);
      await client.query('UPDATE pins SET owner_id = $1 WHERE pin_id = $2', [buyerId, listing.pin_id]);

      // 5. Update the listing to 'SOLD'
      await client.query(
        "UPDATE pin_listings SET status = 'SOLD', buyer_id = $1, sold_at = NOW() WHERE listing_id = $2",
        [buyerId, listingId]
      );

      // 6. Record the fee revenue for auditing
      const marketplaceLedger = await client.query("SELECT ledger_id FROM treasury_ledgers WHERE ledger_name = 'MARKETPLACE_FEES_TOTAL'");
      if (marketplaceLedger.rows.length > 0) {
        const ledgerId = marketplaceLedger.rows[0].ledger_id;
        const feeAmountStr = ethers.utils.formatUnits(feeAmount, 6);
        await client.query('UPDATE treasury_ledgers SET balance = balance + $1 WHERE ledger_id = $2', [feeAmountStr, ledgerId]);
        const feeDescription = `Marketplace Fee from listing #${listingId} (Pin ID: ${listing.pin_id})`;
        await client.query('INSERT INTO treasury_transactions (to_ledger_id, amount, description) VALUES ($1, $2, $3)', [ledgerId, feeAmountStr, feeDescription]);
      }

      await client.query('COMMIT');
      res.json({ message: 'Pin purchased successfully!' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error buying pin:', err);
      res.status(500).send('Server Error');
    } finally {
      client.release();
    }
  }
);

// --- Cancel a Listing ---
router.delete('/listings/:listingId', async (req, res) => {
  const { listingId } = req.params;
  const userId = req.user.id;
  try {
    const result = await pool.query(
      "UPDATE pin_listings SET status = 'CANCELLED' WHERE listing_id = $1 AND seller_id = $2 AND status = 'ACTIVE'",
      [listingId, userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Active listing not found or you are not the owner.' });
    }
    res.json({ message: 'Your listing has been cancelled.' });
  } catch (err) {
    console.error('Error cancelling listing:', err);
    res.status(500).send('Server Error');
  }
});

router.get('/my-listings', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT 
         l.listing_id, l.price, l.created_at,
         pd.pin_name, pd.image_filename
       FROM pin_listings l
       JOIN pins p ON l.pin_id = p.pin_id
       JOIN pin_definitions pd ON p.pin_name = pd.pin_name
       WHERE l.seller_id = $1 AND l.status = 'ACTIVE'
       ORDER BY l.created_at DESC`,
      [userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching my-listings:', err);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
