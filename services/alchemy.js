const { Alchemy, Network } = require('alchemy-sdk');

let cachedClient = null;

const NETWORK_MAPPINGS = [
  { names: ['ethereum', 'eth', 'mainnet', 'eth_mainnet'], chainId: '0x1', network: Network.ETH_MAINNET },
  { names: ['polygon', 'matic', 'polygon_mainnet', 'matic_mainnet'], chainId: '0x89', network: Network.MATIC_MAINNET },
  { names: ['arbitrum', 'arb', 'arbitrum_one'], chainId: '0xa4b1', network: Network.ARB_MAINNET },
  { names: ['optimism', 'opt', 'optimism_mainnet'], chainId: '0xa', network: Network.OPT_MAINNET },
  { names: ['base'], chainId: '0x2105', network: Network.BASE_MAINNET },
];

const chainIdLookup = new Map();
const chainNameLookup = new Map();

for (const mapping of NETWORK_MAPPINGS) {
  chainIdLookup.set(mapping.chainId.toLowerCase(), mapping.network);
  for (const alias of mapping.names) {
    chainNameLookup.set(alias.toLowerCase(), mapping.network);
  }
}

const DEFAULT_PRICE_CURRENCY = (process.env.ALCHEMY_PRICE_CURRENCY || 'usd').toLowerCase();

function getAlchemyClient() {
  if (cachedClient) {
    return cachedClient;
  }

  const apiKey = process.env.ALCHEMY_API_KEY;
  if (!apiKey) {
    throw new Error('ALCHEMY_API_KEY missing');
  }

  cachedClient = new Alchemy({ apiKey });
  return cachedClient;
}

function resolveNetworkByChainId(chainId) {
  if (chainId === undefined || chainId === null) {
    return Network.ETH_MAINNET;
  }

  if (typeof chainId === 'number') {
    const hex = '0x' + chainId.toString(16);
    if (chainIdLookup.has(hex)) {
      return chainIdLookup.get(hex);
    }
    return Network.ETH_MAINNET;
  }

  const normalized = String(chainId).toLowerCase();
  if (chainIdLookup.has(normalized)) {
    return chainIdLookup.get(normalized);
  }

  if (/^0x[0-9a-f]+$/i.test(normalized)) {
    console.warn(`[Alchemy] Unknown chain id ${chainId}. Defaulting to Ethereum for price lookups.`);
    return Network.ETH_MAINNET;
  }

  if (/^\d+$/.test(normalized)) {
    const parsed = Number.parseInt(normalized, 10);
    if (!Number.isNaN(parsed)) {
      const hex = '0x' + parsed.toString(16);
      if (chainIdLookup.has(hex)) {
        return chainIdLookup.get(hex);
      }
    }
  }

  console.warn(`[Alchemy] Unable to resolve chain id ${chainId}. Defaulting to Ethereum for price lookups.`);
  return Network.ETH_MAINNET;
}

function resolveNetworkByName(name) {
  if (!name) {
    return Network.ETH_MAINNET;
  }

  const normalized = String(name).toLowerCase();
  if (chainNameLookup.has(normalized)) {
    return chainNameLookup.get(normalized);
  }

  console.warn(`[Alchemy] Unknown chain name ${name}. Defaulting to Ethereum for price lookups.`);
  return Network.ETH_MAINNET;
}

function extractPrice(prices, currency = DEFAULT_PRICE_CURRENCY) {
  if (!Array.isArray(prices)) {
    return null;
  }

  const match = prices.find((price) =>
    price && typeof price.currency === 'string' && price.currency.toLowerCase() === currency
  );

  if (!match || match.value === undefined || match.value === null) {
    return null;
  }

  const numeric = Number.parseFloat(match.value);
  return Number.isFinite(numeric) ? numeric : null;
}

module.exports = {
  getAlchemyClient,
  resolveNetworkByChainId,
  resolveNetworkByName,
  extractPrice,
  DEFAULT_PRICE_CURRENCY,
  Network,
};
