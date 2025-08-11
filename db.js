// db.js

const fs = require('fs');
const path = require('path'); // <-- Import the 'path' module
const { Pool } = require('pg');
require('dotenv').config();

// Ensure all required environment variables for the database are present.
const requiredEnvVars = [
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_DATABASE',
];

const missingVars = requiredEnvVars.filter((key) => !process.env[key]);

if (missingVars.length > 0) {
  throw new Error(
    `Missing required database environment variables: ${missingVars.join(', ')}`
  );
}

// --- NEW: Check if we are in a production environment ---
const isProduction = process.env.NODE_ENV === 'production';

// --- NEW: Define the base configuration ---
const dbConfig = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
};

// --- NEW: Conditionally add SSL configuration only for production ---
if (isProduction) {
  // Use path.join to create a reliable path to the certificate file
  const caPath = path.join(__dirname, 'local', 'rds-ca.pem');
  
  dbConfig.ssl = {
    rejectUnauthorized: true,
    ca: fs.readFileSync(caPath).toString(),
  };
}

// Create the pool with the final configuration
const pool = new Pool(dbConfig);

// Log the final configuration (excluding sensitive information) for visibility.
console.log(
  `Database configuration loaded: ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`
);

module.exports = pool;
