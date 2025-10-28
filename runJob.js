// hyperstrategies_backend/runJob.js
require('dotenv').config();

const jobName = process.argv[2];
if (!jobName) {
  console.error('❌ ERROR: Please provide the name of the job to run.');
  console.log('Available jobs: pollDeposits, updateVaultPerformance, processWithdrawals, awardStakingXP');
  process.exit(1);
}

const run = async () => {
  console.log(`--- Manually triggering job: ${jobName} ---`);
  try {
    let jobFunction;
    switch (jobName) {
      case 'pollDeposits':
        jobFunction = require('./jobs/pollDeposits').pollDeposits;
        break;
      case 'updateVaultPerformance':
        jobFunction = require('./jobs/updateVaultPerformance').updateVaultPerformance;
        break;
      case 'processWithdrawals':
        jobFunction = require('./jobs/queueProcessor').processWithdrawals;
        break;
      case 'awardStakingXP':
        jobFunction = require('./jobs/awardStakingXP').processTimeWeightedRewards;
        break;
      default:
        console.error(`❌ ERROR: Job "${jobName}" not found.`);
        process.exit(1);
    }
    await jobFunction();
    console.log(`--- ✅ Job "${jobName}" finished successfully. ---`);
    process.exit(0);
  } catch (error) {
    console.error(`--- ❌ Job "${jobName}" failed. ---`, error);
    process.exit(1);
  }
};
run();
