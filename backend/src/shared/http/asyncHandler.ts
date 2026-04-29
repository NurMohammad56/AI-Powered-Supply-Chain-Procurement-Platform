import type { NextFunction, Request, Response } from 'express';

/**
 * Wraps an async route handler so any rejection is funneled into Express's
 * `next(err)` and lands in the global error handler. Removes the need for
 * try/catch boilerplate inside controllers.
 *
 * Uses Express's loose `Request`/`Response` typings so controllers retain
 * the framework's default `req.body: any` (validated upstream by the
 * `validate(zodSchema)` middleware). Controllers can still cast or use
 * Zod-inferred types when stronger guarantees are warranted.
 */
type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => unknown;

export function asyncHandler(fn: AsyncRouteHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
