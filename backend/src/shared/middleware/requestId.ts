import { randomUUID } from 'node:crypto';

import type { Request, RequestHandler } from 'express';

const HEADER_IN = 'x-request-id';
const HEADER_OUT = 'X-Request-Id';

/**
 * Attaches a stable request id to every inbound request so it can be
 * carried through structured logs and surfaced in API responses.
 * Honours an inbound header from a trusted proxy (Render / Cloudflare)
 * if present and well-formed; otherwise generates a v4 UUID.
 *
 * `req.id` is augmented by `pino-http` as `string | number`; we always
 * write a string but the static type union is preserved for compat.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header(HEADER_IN);
  const id = isValidId(incoming) ? incoming : randomUUID();
  (req as Request & { id?: string }).id = id;
  res.setHeader(HEADER_OUT, id);
  next();
};

function isValidId(value: string | undefined): value is string {
  return !!value && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}
