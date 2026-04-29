import type { ErrorCode } from './errorCodes.js';

/**
 * Base application error. Anything thrown that is `instanceof AppError` is
 * passed through to the client unchanged by the global error handler.
 *
 * Subclass for each canonical HTTP status; use `details` for structured
 * supplementary information (validation field paths, retry-after, etc.).
 */
export class AppError extends Error {
  public readonly status: number;
  public readonly code: ErrorCode | string;
  public readonly details?: unknown;
  public readonly isOperational: boolean;

  constructor(
    status: number,
    code: ErrorCode | string,
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
