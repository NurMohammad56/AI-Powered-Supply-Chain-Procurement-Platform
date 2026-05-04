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

let transport;

if (isDevelopment && process.env.NODE_ENV !== 'production') {
  try {
    transport = pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        singleLine: false,
        ignore: 'pid,hostname',
      },
    });
  } catch (err) {
    console.warn('pino-pretty not available, falling back to standard logger');
  }
}

export const logger: Logger = transport ? pino(baseOptions, transport) : pino(baseOptions);

/**
 * Per-request child logger. Carries requestId, tenantId, userId, route.
 * `req.id` may be `string | number` per `pino-http`'s typings; we coerce
 * to string for log consistency.
 */
export function childLoggerFor(req: Request): Logger {
  const rawId = (req as Request & { id?: unknown }).id;
  const requestId = typeof rawId === 'string' ? rawId : rawId != null ? String(rawId) : undefined;
  return logger.child({
    requestId,
    tenantId: req.context?.tenantId.toString(),
    userId: req.context?.userId.toString(),
    route: req.route?.path ?? req.path,
  });
}
