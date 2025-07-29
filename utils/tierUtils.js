// utils/tierUtils.js

const TIER_THRESHOLDS = {
  // Tier 5 is disabled for now
  4: 3000,
  3: 1500,
  2: 750,
  1: 0
};

const calculateUserTier = (userXp) => {
  const sortedTiers = Object.keys(TIER_THRESHOLDS).sort((a, b) => b - a);
  for (const tier of sortedTiers) {
    if (userXp >= TIER_THRESHOLDS[tier]) {
      return parseInt(tier, 10);
    }
  }
  return 1;
};

const getFeeForTier = (accountTier) => {
  switch (accountTier) {
    case 4: return 0.14;
    case 3: return 0.16;
    case 2: return 0.18;
    default: return 0.20; // Base fee is 20% for Tier 1
  }
};

module.exports = {
  calculateUserTier,
  getFeeForTier,
  TIER_THRESHOLDS
};