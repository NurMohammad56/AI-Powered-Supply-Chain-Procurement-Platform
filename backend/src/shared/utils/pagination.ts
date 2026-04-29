import { Types } from 'mongoose';
import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface Cursor {
  after: Types.ObjectId | null;
  limit: number;
}

export interface Page<T> {
  rows: T[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export const cursorQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined ? DEFAULT_PAGE_SIZE : Number(v)))
    .pipe(z.number().int().positive().max(MAX_PAGE_SIZE)),
});

export type CursorQueryInput = z.input<typeof cursorQuerySchema>;
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

/**
 * Decode an opaque base64url cursor produced by `encodeCursor`.
 * Returns null on any malformed input rather than throwing - the caller
 * should treat null as "start from the beginning".
 */
export function decodeCursor(raw: string | undefined): Types.ObjectId | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    if (!Types.ObjectId.isValid(decoded)) return null;
    return new Types.ObjectId(decoded);
  } catch {
    return null;
  }
}

export function encodeCursor(id: Types.ObjectId | string | undefined): string | null {
  if (!id) return null;
  return Buffer.from(id.toString(), 'utf8').toString('base64url');
}

export function buildCursor(query: CursorQuery): Cursor {
  return {
    after: decodeCursor(query.cursor),
    limit: query.limit,
  };
}

/**
 * Given a query result of `limit + 1` rows (the standard cursor-pagination
 * trick), trim the sentinel and produce the page envelope.
 */
export function paginate<T extends { _id: Types.ObjectId | string }>(
  rows: T[],
  limit: number,
): Page<T> {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last._id) : null;
  return { rows: slice, nextCursor, hasMore, limit };
}
