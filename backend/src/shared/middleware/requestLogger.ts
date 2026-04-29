import { pinoHttp } from 'pino-http';
import type { RequestHandler } from 'express';

import { logger } from '../../config/logger.js';

export const requestLogger: RequestHandler = pinoHttp({
  logger,
  genReqId: (req) => (req as { id?: string }).id ?? '',
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customProps: (req) => {
    const ctx = (req as { context?: { factoryId?: { toString(): string }; userId?: { toString(): string } } })
      .context;
    return {
      factoryId: ctx?.factoryId?.toString(),
      userId: ctx?.userId?.toString(),
    };
  },
  serializers: {
    req: (req: { method: string; url: string; headers: Record<string, string>; remoteAddress?: string }) => ({
      method: req.method,
      url: req.url,
      ip: req.remoteAddress,
      ua: req.headers['user-agent'],
    }),
    res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
  },
});
