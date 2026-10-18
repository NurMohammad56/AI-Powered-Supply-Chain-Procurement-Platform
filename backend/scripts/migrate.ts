import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { Forecast } from '../src/modules/ai/models/forecast.model.js';

async function main() {
  await connectDatabase();
  const exists = await Forecast.db
    .db!.listCollections({ name: Forecast.collection.collectionName })
    .hasNext();
  if (exists) {
    const indexes = await Forecast.collection.indexes();
    for (const index of indexes) {
      if (index.key.expiresAt === 1 && index.expireAfterSeconds !== undefined && index.name) {
        await Forecast.collection.dropIndex(index.name);
        console.log(
          'Removed forecast TTL index: history is retained; expiresAt still controls cache freshness.',
        );
      }
    }
  }
  await Forecast.createIndexes();
  console.log('Forecast history migration complete; no documents deleted.');
}
main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(disconnectDatabase);
