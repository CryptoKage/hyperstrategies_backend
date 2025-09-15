// ==============================================================================
// START: PASTE THIS into your new root testMoralis.js file
// ==============================================================================
require('dotenv').config();
const Moralis = require('moralis').default;
const { EvmChain } = require('@moralisweb3/common-evm-utils');

const runTest = async () => {
  console.log('--- Starting Moralis Isolation Test ---');
  
  const apiKey = process.env.MORALIS_API_KEY;
  if (!apiKey) {
    console.error('❌ ERROR: MORALIS_API_KEY is not set in your .env file.');
    return;
  }
  console.log('API Key found.');

  try {
    await Moralis.start({ apiKey });
    console.log('Moralis SDK started successfully.');

    const tokensToTest = [
      { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' }, // WETH
      { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' }  // WBTC
    ];
    
    console.log('Attempting to fetch prices for:', JSON.stringify(tokensToTest, null, 2));

    const priceResponse = await Moralis.EvmApi.token.getMultipleTokenPrices({
      chain: EvmChain.ETHEREUM,
      tokens: tokensToTest
    });

    console.log('✅ SUCCESS! Moralis API call succeeded.');
    console.log('API Response:', priceResponse.toJSON());

  } catch (error) {
    console.error('❌ TEST FAILED. The API call produced an error:');
    console.error('Error Code:', error.code);
    console.error('Error Message:', error.message);
    console.error('Full Error Object:', error);
  }
};

runTest();
// ==============================================================================
// END OF FILE
// ==============================================================================
