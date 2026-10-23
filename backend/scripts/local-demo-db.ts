import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

async function main() {
  const dbPath = path.resolve('.demo-data/mongo');
  await mkdir(dbPath, { recursive: true });
  const repl = await MongoMemoryReplSet.create({
    binary: { version: '7.0.14' },
    instanceOpts: [{ port: 27018, dbPath }],
    replSet: { name: 'demo-rs', count: 1, storageEngine: 'wiredTiger' },
  });
  console.log(
    'Persistent demo MongoDB ready: mongodb://127.0.0.1:27018/garments_demo?replicaSet=demo-rs',
  );
  const stop = async () => {
    await repl.stop({ doCleanup: false });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
