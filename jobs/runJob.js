// ==============================================================================
// START: PASTE THIS into your new root runJob.js file
// ==============================================================================
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
      
      case 'pollDeposits':
        const { pollDeposits } = require('./jobs/pollDeposits');
        await pollDeposits();
        break;
        
      case 'processWithdrawals':
        const { processWithdrawals } = require('./jobs/queueProcessor');
        await processWithdrawals();
        break;
        
      // Add other job names here as needed...

      default:
        console.error(`❌ ERROR: Job "${jobName}" not found.`);
        console.log('Available jobs: updateVaultPerformance, pollDeposits, processWithdrawals');
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
// ==============================================================================
// END OF FILE
// ==============================================================================
