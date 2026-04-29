import type { Request, Response } from 'express';

export interface ResponseMeta {
  requestId?: string;
  [k: string]: unknown;
}

export interface SuccessEnvelope<T> {
  data: T;
  meta?: ResponseMeta;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export interface PaginatedEnvelope<T> {
  data: T[];
  meta: ResponseMeta & {
    pagination: {
      nextCursor: string | null;
      limit: number;
      hasMore: boolean;
    };
  };
}

/**
 * Coerces `req.id` to a string. `pino-http` types `req.id` as `ReqId`
 * (`string | number`); the `requestId` middleware always sets a string,
 * but downstream code must defend against the type union.
 */
export function getRequestId(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  if (typeof id === 'string') return id;
  if (typeof id === 'number') return String(id);
  return undefined;
}

function metaFor(req: Request): ResponseMeta {
  const requestId = getRequestId(req);
  return requestId ? { requestId } : {};
}

export function ok<T>(req: Request, res: Response, data: T, status = 200): Response {
  const body: SuccessEnvelope<T> = { data, meta: metaFor(req) };
  return res.status(status).json(body);
}

export function created<T>(req: Request, res: Response, data: T): Response {
  return ok(req, res, data, 201);
}

export function noContent(res: Response): Response {
  return res.status(204).send();
}

export function paginated<T>(
  req: Request,
  res: Response,
  data: T[],
  pagination: { nextCursor: string | null; limit: number; hasMore: boolean },
): Response {
  const body: PaginatedEnvelope<T> = {
    data,
    meta: { ...metaFor(req), pagination },
  };
  return res.status(200).json(body);
}
