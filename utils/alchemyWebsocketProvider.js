const { ethers } = require('ethers');

// Shared Alchemy WebSocket provider for listening to new blocks
const network = process.env.ALCHEMY_NETWORK || 'homestead';
const apiKey = process.env.ALCHEMY_API_KEY;

const provider = new ethers.providers.AlchemyWebSocketProvider(network, apiKey);

module.exports = provider;
