import mongoose from 'mongoose';

import { env, isProduction } from './env.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);
mongoose.set('strictPopulate', true);

let connecting: Promise<typeof mongoose> | null = null;

export async function connectDatabase(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (connecting) return connecting;

  connecting = mongoose
    .connect(env.MONGO_URI, {
      maxPoolSize: env.MONGO_MAX_POOL_SIZE,
      minPoolSize: env.MONGO_MIN_POOL_SIZE,
      serverSelectionTimeoutMS: 5_000,
      socketTimeoutMS: 20_000,
      retryWrites: true,
      autoIndex: !isProduction,
      compressors: ['zstd', 'zlib'],
    })
    .then((m) => {
      logger.info({ event: 'mongo.connected', host: m.connection.host }, 'MongoDB connected');
      return m;
    })
    .catch((err: unknown) => {
      logger.fatal({ err, event: 'mongo.connect_failed' }, 'MongoDB connection failed');
      throw err;
    });

  return connecting;
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  logger.info({ event: 'mongo.disconnected' }, 'MongoDB disconnected');
}

mongoose.connection.on('disconnected', () => {
  logger.warn({ event: 'mongo.disconnected' }, 'MongoDB connection lost');
});

mongoose.connection.on('reconnected', () => {
  logger.info({ event: 'mongo.reconnected' }, 'MongoDB reconnected');
});

mongoose.connection.on('error', (err: Error) => {
  logger.error({ err, event: 'mongo.error' }, 'MongoDB error');
});

export { mongoose };
