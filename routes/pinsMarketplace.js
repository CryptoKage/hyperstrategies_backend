const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const requireTier = require('../middleware/requireTier');
const { body, param, validationResult } = require('express-validator'); 

const MAX_PRICE = 1000000;

// All marketplace routes require authentication and minimum tier 2
router.use(authenticateToken);
router.use(requireTier(2));

// Get all active tab listings
router.get('/tabs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.listing_id, t.tab_id, t.name, t.description, l.price, l.seller_id
       FROM tab_listings l
       JOIN tabs t ON l.tab_id = t.tab_id
       WHERE l.status = 'ACTIVE'
       ORDER BY l.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching tab listings:', err);
    res.status(500).send('Server Error');
  }
});

// List a tab for sale
router.post(
  '/tabs/list',
  [
    body('tabId').isInt({ gt: 0 }).withMessage('tabId must be a positive integer'),
    body('price')
      .isFloat({ gt: 0, lt: MAX_PRICE })
      .withMessage(`price must be a positive number below ${MAX_PRICE}`),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { tabId, price } = req.body;
    const numericPrice = parseFloat(price);
    const userId = req.user.id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tabRes = await client.query('SELECT owner_id FROM tabs WHERE tab_id = $1', [tabId]);
      if (tabRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Tab not found' });
      }
      if (tabRes.rows[0].owner_id !== userId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Not owner of this tab' });
      }
      const existingRes = await client.query(
        "SELECT listing_id FROM tab_listings WHERE tab_id = $1 AND status = 'ACTIVE'",
        [tabId]
      );
      if (existingRes.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Tab already listed' });
      }
      await client.query(
        'INSERT INTO tab_listings (tab_id, seller_id, price, status) VALUES ($1, $2, $3, ' +
          "'ACTIVE')",
        [tabId, userId, numericPrice]
      );
      await client.query('COMMIT');
      res.status(201).json({ message: 'Tab listed for sale' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error listing tab:', err);
      res.status(500).send('Server Error');
    } finally {
      client.release();
    }
  }
);

// Buy a tab listing
router.post(
  '/tabs/:listingId/buy',
  [param('listingId').isInt({ gt: 0 }).withMessage('listingId must be a positive integer')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { listingId } = req.params;
    const buyerId = req.user.id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const listingRes = await client.query(
        `SELECT l.listing_id, l.tab_id, l.price, l.seller_id, l.status
         FROM tab_listings l
         WHERE l.listing_id = $1 FOR UPDATE`,
        [listingId]
      );
      if (listingRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Listing not found' });
      }
      const listing = listingRes.rows[0];
      const listingPrice = parseFloat(listing.price);
      if (isNaN(listingPrice) || listingPrice <= 0 || listingPrice >= MAX_PRICE) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid listing price' });
      }
      if (listing.status !== 'ACTIVE') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Listing not active' });
      }
      if (listing.seller_id === buyerId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cannot buy your own tab' });
      }
      const balanceRes = await client.query('SELECT balance FROM users WHERE user_id = $1', [buyerId]);
      if (balanceRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Buyer not found' });
      }
      const buyerBalance = parseFloat(balanceRes.rows[0].balance);
      if (buyerBalance < listingPrice) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient balance' });
      }
      await client.query('UPDATE users SET balance = balance - $1 WHERE user_id = $2', [listingPrice, buyerId]);
      await client.query('UPDATE users SET balance = balance + $1 WHERE user_id = $2', [listingPrice, listing.seller_id]);
      await client.query('UPDATE tabs SET owner_id = $1 WHERE tab_id = $2', [buyerId, listing.tab_id]);
      await client.query(
        "UPDATE tab_listings SET status = 'SOLD', buyer_id = $1, sold_at = NOW() WHERE listing_id = $2",
        [buyerId, listingId]
      );
      await client.query('COMMIT');
      res.json({ message: 'Tab purchased successfully' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error buying tab:', err);
      res.status(500).send('Server Error');
    } finally {
      client.release();
    }
  }
);

// Cancel a listing
router.delete('/tabs/:listingId', async (req, res) => {
  const { listingId } = req.params;
  const userId = req.user.id;
  try {
    const result = await pool.query(
      "UPDATE tab_listings SET status = 'CANCELLED' WHERE listing_id = $1 AND seller_id = $2 AND status = 'ACTIVE'",
      [listingId, userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Listing not found or cannot cancel' });
    }
    res.json({ message: 'Listing cancelled' });
  } catch (err) {
    console.error('Error cancelling listing:', err);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
