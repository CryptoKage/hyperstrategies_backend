// ==============================================================================
// START: REPLACE the entire contents of utils/tierUtils.js
// ==============================================================================
const TIER_DATA = [
  { tier: 1, xpRequired: 0 },
  { tier: 2, xpRequired: 1000 },
  { tier: 3, xpRequired: 2000 },
  { tier: 4, xpRequired: 4000 },
  { tier: 5, xpRequired: 7000 },
  // Add tier 5 here when ready: { tier: 5, xpRequired: 5000 },
];

const calculateUserTier = (userXp) => {
  // Find the highest tier the user qualifies for
  const userTier = TIER_DATA.reduce((currentTier, tierInfo) => {
    return userXp >= tierInfo.xpRequired ? tierInfo.tier : currentTier;
  }, 1);
  return userTier;
};

// This function is no longer needed since fee discounts are handled by Pins,
// but we will leave it here commented out in case you want to re-introduce it later.
/*
const getFeeForTier = (accountTier) => {
  // ... old fee logic ...
};
*/

module.exports = {
  calculateUserTier,
  TIER_DATA // <-- We now export the raw data array
};
// ==============================================================================
// END OF REPLACEMENT
// ==============================================================================
