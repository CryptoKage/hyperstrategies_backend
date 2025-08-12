// FILE: hyperstrategies_backend/routes/pins.js
const express = require('express');
const router = express.Router();
const pool = require('../db'); // Your database connection pool

// GET /api/pins/definitions
// Fetches all pin definitions from the database.
router.get('/definitions', async (req, res) => {
    try {
        const queryResult = await pool.query('SELECT pin_name, pin_description, image_url FROM pin_definitions ORDER BY pin_name ASC');
        const allPinDefinitions = queryResult.rows;
        res.status(200).json(allPinDefinitions);
    } catch (error) {
        console.error('Failed to fetch pin definitions:', error);
        res.status(500).json({ message: 'Error fetching pin definitions.' });
    }
});

module.exports = router;
