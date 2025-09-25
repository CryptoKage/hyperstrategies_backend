// /routes/system.js

const express = require('express');
const router = express.Router();
const pool = require('../db');

// This endpoint is public and can be cached by browsers.
router.get('/feature-flags', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT flag_name, is_enabled FROM feature_flags');
        
        // Convert the array of rows into a simple object like { flagName: boolean }
        const flags = rows.reduce((acc, flag) => {
            acc[flag.flag_name] = flag.is_enabled;
            return acc;
        }, {});

        res.json(flags);
    } catch (error) {
        console.error('Error fetching feature flags:', error);
        res.status(500).json({});
    }
});

module.exports = router;
