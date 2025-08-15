// hyperstrategies_backend/utils/alchemyWebsocketProvider.js
// This new version is a robust module that handles connection errors and auto-reconnects.

const { ethers } = require('ethers');

const network = process.env.ALCHEMY_NETWORK || 'homestead';
const apiKey = process.env.ALCHEMY_API_KEY;

let provider;
let connectionAttempts = 0;

function initializeWebSocketProvider() {
  console.log('Attempting to connect to Alchemy WebSocket...');
  
  // Create a new provider instance
  provider = new ethers.providers.AlchemyWebSocketProvider(network, apiKey);

  // --- THIS IS THE CRITICAL ERROR HANDLING ---
  // Listen for the 'error' event on the provider's WebSocket connection
  provider._websocket.on('error', (error) => {
    console.error('--- WebSocket Error ---');
    console.error('An error occurred with the Alchemy WebSocket connection:', error.message);
    // The 'error' event is usually followed by a 'close' event, which will handle reconnection.
  });

  // Listen for the 'close' event
  provider._websocket.on('close', (code) => {
    console.warn(`--- WebSocket Closed ---`);
    console.warn(`Connection closed with code: ${code}. Attempting to reconnect in 10 seconds...`);
    
    // Clear the old provider and listeners to prevent memory leaks
    provider.removeAllListeners();
    
    // Attempt to reconnect after a delay
    connectionAttempts++;
    const delay = Math.min(10000 * connectionAttempts, 60000); // Exponential backoff, max 1 minute
    setTimeout(initializeWebSocketProvider, delay);
  });

  // Listen for a successful 'open' event
  provider._websocket.on('open', () => {
    console.log('✅ Alchemy WebSocket connection established successfully.');
    connectionAttempts = 0; // Reset connection attempts on success
  });

  // We also need to attach the 'block' listener here now
  // We will pass this listener in from index.js
}

function getProvider() {
    if (!provider) {
        throw new Error("WebSocket provider has not been initialized.");
    }
    return provider;
}

// Start the initial connection attempt
initializeWebSocketProvider();

// Export the function to get the provider instance
module.exports = { getProvider };
