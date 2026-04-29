/**
 * Base application error. Anything thrown that is `instanceof AppError` is
 * passed through to the client unchanged by the global error handler.
 *
 * Subclass for each canonical HTTP status; use `details` for structured
 * supplementary information (validation field paths, retry-after, etc.).
 *
 * The `code` field is stored as `string` (intentionally wider than the
 * `ErrorCode` literal union) so that subclasses and ad-hoc instances can
 * raise codes for module-local error states without polluting the central
 * `ErrorCodes` catalogue. Stable, client-visible codes belong in
 * `errorCodes.ts`; ephemeral codes can be inlined.
 */
export class AppError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly isOperational: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    isOperational = true,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;
    Error.captureStackTrace?.(this, this.constructor);
  }

  toJSON(): { code: string; message: string; details?: unknown } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}
