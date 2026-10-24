import { connectDatabase, disconnectDatabase, mongoose } from '../src/config/database.js';
import { PLANS } from '../src/modules/billing/plans.js';

async function main() {
  try {
    await connectDatabase();
    const database = mongoose.connection.db;
    if (!database) throw new Error('Database is unavailable');
    // Deliberate cross-tenant policy migration; no expiry, usage or paid rows change.
    const result = await database
      .collection('subscriptions')
      .updateMany(
        { tier: 'trial', seats: { $ne: PLANS.trial.seatLimit } },
        { $set: { seats: PLANS.trial.seatLimit } },
      );
    console.log(
      `Trial seat policy migrated to ${PLANS.trial.seatLimit}; updated ${result.modifiedCount} trial subscriptions.`,
    );
  } finally {
    await disconnectDatabase();
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Trial seat migration failed');
  process.exitCode = 1;
});
