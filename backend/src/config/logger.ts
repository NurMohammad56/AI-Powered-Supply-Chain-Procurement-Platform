import pino, { type Logger, type LoggerOptions } from 'pino';
import type { Request } from 'express';

import { env, isDevelopment, isTest } from './env.js';

const baseOptions: LoggerOptions = {
  level: isTest ? 'silent' : env.LOG_LEVEL,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.refreshToken',
      '*.accessToken',
      'body.password',
      'body.currentPassword',
      'body.newPassword',
      'body.token',
    ],
    censor: '[REDACTED]',
  },
  base: {
    service: 'scp-backend',
    env: env.NODE_ENV,
    version: env.GIT_SHA.slice(0, 7),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

const transport = isDevelopment
  ? pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        singleLine: false,
        ignore: 'pid,hostname',
      },
    })
  : undefined;

export const logger: Logger = transport ? pino(baseOptions, transport) : pino(baseOptions);

/**
 * Per-request child logger. Carries requestId, factoryId, userId, route.
 * Bound onto every authenticated request by the requestLogger middleware.
 */
export function childLoggerFor(req: Request): Logger {
  return logger.child({
    requestId: (req as Request & { id?: string }).id,
    factoryId: req.context?.factoryId.toString(),
    userId: req.context?.userId.toString(),
    route: req.route?.path ?? req.path,
  });
}
