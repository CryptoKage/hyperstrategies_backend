require('dotenv').config();

// This script allows you to run a specific background job from the command line.
// Example Usage: node runJob.js updateVaultPerformance

const jobName = process.argv[2];

if (!jobName) {
  console.error('❌ ERROR: Please provide the name of the job to run.');
  console.log('Example: node runJob.js updateVaultPerformance');
  process.exit(1);
}

const run = async () => {
  console.log(`--- Manually triggering job: ${jobName} ---`);
  
  try {
    switch (jobName) {
      case 'updateVaultPerformance':
        const { updateVaultPerformance } = require('./jobs/updateVaultPerformance');
        await updateVaultPerformance();
        break;
      
      case 'pollDeposits': {
        const { ethers } = require('ethers');
        const { scanBlockForDeposits } = require('./pollDeposits');

        const rpcUrl = process.env.ALCHEMY_RPC_URL;
        if (!rpcUrl) {
          throw new Error('ALCHEMY_RPC_URL environment variable is required to run the pollDeposits job manually.');
        }

        const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
        const latestBlock = await provider.getBlockNumber();
        await scanBlockForDeposits(latestBlock);
        break;
      }

          case 'reconstructHistory':
        const { runReconstruction } = require('./jobs/reconstructHistory');
        await runReconstruction();
        break;
        
      case 'processWithdrawals':
        const { processWithdrawals } = require('./jobs/queueProcessor');
        await processWithdrawals();
        break;
    

     case 'backfillPnl':
        const { runPnlBackfill } = require('./jobs/backfillVaultHistory');
        await runPnlBackfill();
        break;

        
      // Add other job names here as needed...

      default:
        console.error(`❌ ERROR: Job "${jobName}" not found.`);
        console.log('Available jobs: updateVaultPerformance, pollDeposits, processWithdrawals, backfillPnl');
        process.exit(1);
    }
    
    console.log(`--- ✅ Job "${jobName}" finished successfully. ---`);
    process.exit(0); // Exit with success code

  } catch (error) {
    console.error(`--- ❌ Job "${jobName}" failed. ---`);
    console.error(error);
    process.exit(1); // Exit with failure code
  }
};

run();
