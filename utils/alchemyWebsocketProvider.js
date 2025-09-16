// PASTE THIS ENTIRE CONTENT TO REPLACE: hyperstrategies_backend/utils/alchemyWebsocketProvider.js

const { Alchemy, Network } = require('alchemy-sdk');
const EventEmitter = require('events');

class BlockEmitter extends EventEmitter {}
const blockEmitter = new BlockEmitter();

let alchemy;
let lastBlockTimestamp = Date.now();
const HEARTBEAT_TIMEOUT = 3 * 60 * 1000; // 3 minutes

/**
 * Initializes the Alchemy WebSocket connection and a heartbeat mechanism.
 * This function is designed to be called once when the server starts.
 */
function initializeWebSocketProvider() {
  console.log('🔌 Initializing Alchemy WebSocket provider with heartbeat...');

  const connect = () => {
    console.log('Attempting to connect to Alchemy WebSocket...');
    
    const config = {
      apiKey: process.env.ALCHEMY_API_KEY,
      network: Network.ETH_MAINNET,
    };
    alchemy = new Alchemy(config);

    // Remove any old listeners before attaching new ones to prevent duplicates on reconnect.
    alchemy.ws.removeAllListeners();

    // Subscribe to new block headers
    alchemy.ws.on('block', (blockNumber) => {
      // Every time we get a block, update our heartbeat timestamp.
      lastBlockTimestamp = Date.now();
      console.log(`[WebSocket] Block received: #${blockNumber}`);
      
      // Emit the event for our other services (like the deposit scanner) to hear.
      blockEmitter.emit('newBlock', blockNumber);
    });
  };

  // The "watchdog" timer.
  // It runs periodically to ensure the connection is still alive.
  const startHeartbeatMonitor = () => {
    setInterval(() => {
      const now = Date.now();
      if (now - lastBlockTimestamp > HEARTBEAT_TIMEOUT) {
        console.warn(`🔌 [Heartbeat] No block received in over ${HEARTBEAT_TIMEOUT / 1000} seconds. Connection may be stale. Reconnecting...`);
        
        // Reset the timestamp to prevent immediate re-triggering.
        lastBlockTimestamp = now; 
        
        // Tear down the old connection and establish a new one.
        alchemy.ws.removeAllListeners();
        connect();
      }
    }, 30 * 1000); // Check every 30 seconds.
  };

  // Initial connection attempt and start the monitor.
  connect();
  startHeartbeatMonitor();
}

module.exports = {
  initializeWebSocketProvider,
  blockEmitter
};
