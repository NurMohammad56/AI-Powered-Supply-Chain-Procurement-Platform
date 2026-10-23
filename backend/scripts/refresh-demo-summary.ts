import { readFile, writeFile } from 'node:fs/promises';
import mongoose, { Types } from 'mongoose';
import { env } from '../src/config/env.js';

async function main() {
  const manifest = JSON.parse(await readFile('artifacts/garments-demo-manifest.json', 'utf8'));
  const tenantId = new Types.ObjectId(manifest.tenantId);
  await mongoose.connect(env.MONGO_URI);
  const db = mongoose.connection.db!;
  manifest.databaseName = mongoose.connection.name;
  const collections: Record<string, number> = {};
  for (const collection of await db.listCollections().toArray())
    collections[collection.name] = await db
      .collection(collection.name)
      .countDocuments(collection.name === 'factories' ? { _id: tenantId } : { tenantId });
  const forecasts = await db.collection('forecasts').find({ tenantId }).toArray();
  const insights = await db.collection('aiinsights').find({ tenantId }).toArray();
  manifest.finalCounts = {
    items: await db.collection('items').countDocuments({ tenantId, archivedAt: null }),
    stockMovements: collections.stockmovements,
    stockBalances: collections.stockbalances,
    purchaseOrders: collections.purchaseorders,
    forecasts: forecasts.length,
    liveAiForecasts: forecasts.filter((f) => !f.provenance?.fallback && f.rawResponse).length,
    aiInsights: insights.length,
    emailDeliveries: collections.emaildeliveries,
  };
  manifest.collectionCounts = collections;
  manifest.verifiedAt = new Date().toISOString();
  await writeFile('artifacts/garments-demo-manifest.json', JSON.stringify(manifest, null, 2));
  await writeFile(
    'artifacts/persisted-ai-responses.json',
    JSON.stringify(
      { forecasts: forecasts.filter((f) => !f.provenance?.fallback && f.rawResponse), insights },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(manifest.finalCounts));
}
main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
