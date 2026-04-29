import type { RequestHandler } from 'express';
import type { z } from 'zod';

import { ValidationError } from '../errors/HttpErrors.js';

type Source = 'body' | 'query' | 'params' | 'headers';

/**
 * Validates a request segment against a Zod schema and replaces the raw
 * value with the parsed (typed, coerced, defaulted) result. Controllers
 * that read `req.body` after this middleware get the schema's inferred
 * type guarantees - no defensive re-checks required.
 */
export function validate<S extends z.ZodTypeAny>(schema: S, source: Source = 'body'): RequestHandler {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      }));
      return next(new ValidationError(details));
    }
    Object.defineProperty(req, source, {
      value: parsed.data,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    next();
  };
}
