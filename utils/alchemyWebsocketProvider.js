// PASTE THIS ENTIRE CONTENT INTO: hyperstrategies_backend/utils/alchemyWebsocketProvider.js

const { Alchemy, Network } = require('alchemy-sdk');
const EventEmitter = require('events');

// We create an EventEmitter to allow other parts of our application to "subscribe" to new blocks.
class BlockEmitter extends EventEmitter {}
const blockEmitter = new BlockEmitter();

let alchemy;
let isConnected = false;

/**
 * Initializes the Alchemy WebSocket connection.
 * This function is designed to be called once when the server starts.
 * It sets up a listener for new blocks and handles automatic reconnection.
 */
function initializeWebSocketProvider() {
  console.log('🔌 Initializing Alchemy WebSocket provider...');

  const config = {
    apiKey: process.env.ALCHEMY_API_KEY,
    network: Network.ETH_MAINNET,
  };
  
  alchemy = new Alchemy(config);

  const connect = () => {
    console.log('Attempting to connect to Alchemy WebSocket...');
    
    // Subscribe to new block headers
    alchemy.ws.on('block', (blockNumber) => {
      if (!isConnected) {
        isConnected = true;
        console.log(`✅ WebSocket connected! First new block received: #${blockNumber}`);
      }
      // When a new block arrives, we "emit" an event that other files can listen for.
      blockEmitter.emit('newBlock', blockNumber);
    });

    // It's good practice to have a way to know when the connection drops
    const ws = alchemy.ws.getWebSocket();
    ws.on('close', () => {
      if (isConnected) {
        console.warn('🔌 WebSocket connection closed. Attempting to reconnect in 10 seconds...');
        isConnected = false;
        setTimeout(connect, 10000); // Attempt to reconnect after a delay
      }
    });

    ws.on('error', (error) => {
      console.error('🔌 WebSocket error:', error.message);
      // The 'close' event will usually fire after an error, triggering our reconnect logic.
    });
  };

  connect();
}

// We export the initializer and the emitter so other files can use them.
module.exports = {
  initializeWebSocketProvider,
  blockEmitter
};
