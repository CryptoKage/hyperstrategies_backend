// runJob.js - CORRECTED

require('dotenv').config();
const { findAndCreditDeposits } = require('./jobs/pollDeposits');
const { updateVaultPerformance } = require('./jobs/updateVaultPerformance');
const { processWithdrawals } = require('./jobs/queueProcessor');
// Add any other jobs you want to run manually here.

const jobName = process.argv[2];

if (!jobName) {
  console.error('❌ ERROR: Please provide the name of the job to run.');
  console.log('Available jobs: syncDeposits, updateVaultPerformance, processWithdrawals');
  process.exit(1);
}

const run = async () => {
  console.log(`--- Manually triggering job: ${jobName} ---`);
  
  try {
    switch (jobName) {
      case 'syncDeposits':
        // This now calls our powerful full-history sync function.
        console.log('Running a full history scan for all user deposits...');
        await findAndCreditDeposits({ fromBlock: "0x0" });
        break;
      
      case 'updateVaultPerformance':
        await updateVaultPerformance();
        break;
        
      case 'processWithdrawals':
        await processWithdrawals();
        break;
        
      // Add other jobs here if you need them.

      default:
        console.error(`❌ ERROR: Job "${jobName}" not found.`);
        console.log('Available jobs: syncDeposits, updateVaultPerformance, processWithdrawals');
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
