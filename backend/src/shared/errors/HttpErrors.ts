import { AppError } from './AppError.js';
import { ErrorCodes, type ErrorCode } from './errorCodes.js';

export class BadRequestError extends AppError {
  constructor(code: ErrorCode | string = ErrorCodes.BAD_REQUEST, message = 'Bad Request', details?: unknown) {
    super(400, code, message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(code: ErrorCode | string = ErrorCodes.AUTH_TOKEN_INVALID, message = 'Unauthorized', details?: unknown) {
    super(401, code, message, details);
  }
}

export class PaymentRequiredError extends AppError {
  constructor(
    code: ErrorCode | string = ErrorCodes.TIER_GATE,
    message = 'Subscription upgrade required',
    details?: unknown,
  ) {
    super(402, code, message, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(code: ErrorCode | string = ErrorCodes.FORBIDDEN, message = 'Forbidden', details?: unknown) {
    super(403, code, message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(code: ErrorCode | string = ErrorCodes.NOT_FOUND, message = 'Resource not found', details?: unknown) {
    super(404, code, message, details);
  }
}

export class ConflictError extends AppError {
  constructor(code: ErrorCode | string = ErrorCodes.CONFLICT, message = 'Conflict', details?: unknown) {
    super(409, code, message, details);
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown, message = 'Request validation failed') {
    super(400, ErrorCodes.VALIDATION_FAILED, message, details);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(
    code: ErrorCode | string = ErrorCodes.RATE_LIMITED,
    message = 'Too many requests',
    details?: unknown,
  ) {
    super(429, code, message, details);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(
    code: ErrorCode | string = ErrorCodes.SERVICE_UNAVAILABLE,
    message = 'Service unavailable',
    details?: unknown,
  ) {
    super(503, code, message, details);
  }
}

export class InternalError extends AppError {
  constructor(
    code: ErrorCode | string = ErrorCodes.INTERNAL_ERROR,
    message = 'Internal server error',
    details?: unknown,
  ) {
    super(500, code, message, details, false);
  }
}
