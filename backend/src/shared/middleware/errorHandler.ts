import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import mongoose from 'mongoose';

import { logger } from '../../config/logger.js';
import { AppError } from '../errors/AppError.js';
import { ErrorCodes } from '../errors/errorCodes.js';
import type { ErrorEnvelope } from '../http/apiResponse.js';

const TENANCY_MARKERS = ['TENANCY_SCOPE_MISSING', 'TENANCY_VIOLATION'];

/**
 * Global error handler. Three classes of error:
 *   - AppError       -> passthrough with stable code + status
 *   - ZodError       -> 400 VALIDATION_FAILED with field path details
 *   - everything else -> fatal log + opaque 500 with requestId
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.id;

  if (err instanceof AppError) {
    const body: ErrorEnvelope = {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
    if (err.status >= 500 && err.isOperational === false) {
      logger.error({ err, requestId }, 'Operational error 5xx');
    } else if (err.status >= 500) {
      logger.error({ err, requestId }, 'AppError 5xx');
    }
    res.status(err.status).json(body);
    return;
  }

  if (err instanceof ZodError) {
    const body: ErrorEnvelope = {
      error: {
        code: ErrorCodes.VALIDATION_FAILED,
        message: 'Request validation failed',
        details: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
        ...(requestId ? { requestId } : {}),
      },
    };
    res.status(400).json(body);
    return;
  }

  if (err instanceof mongoose.Error.CastError) {
    const body: ErrorEnvelope = {
      error: {
        code: ErrorCodes.BAD_REQUEST,
        message: 'Invalid identifier format',
        ...(requestId ? { requestId } : {}),
      },
    };
    res.status(400).json(body);
    return;
  }

  if (err instanceof mongoose.Error.ValidationError) {
    const body: ErrorEnvelope = {
      error: {
        code: ErrorCodes.VALIDATION_FAILED,
        message: 'Document validation failed',
        details: Object.entries(err.errors).map(([path, e]) => ({
          path,
          message: (e as { message?: string }).message ?? 'invalid',
        })),
        ...(requestId ? { requestId } : {}),
      },
    };
    res.status(400).json(body);
    return;
  }

  // Mongo duplicate key
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: number }).code === 11000
  ) {
    const body: ErrorEnvelope = {
      error: {
        code: ErrorCodes.RESOURCE_DUPLICATE,
        message: 'Resource already exists',
        ...(requestId ? { requestId } : {}),
      },
    };
    res.status(409).json(body);
    return;
  }

  // Tenancy plugin scope/violation errors are programmer mistakes - never expose them
  if (err instanceof Error && TENANCY_MARKERS.some((m) => err.message.includes(m))) {
    logger.fatal({ err, requestId, path: req.path }, 'Tenant scope error escaped to handler');
    const body: ErrorEnvelope = {
      error: {
        code: ErrorCodes.INTERNAL_ERROR,
        message: 'Something went wrong',
        ...(requestId ? { requestId } : {}),
      },
    };
    res.status(500).json(body);
    return;
  }

  // Unknown
  logger.fatal({ err, requestId, path: req.path, method: req.method }, 'Unhandled error');
  const body: ErrorEnvelope = {
    error: {
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Something went wrong',
      ...(requestId ? { requestId } : {}),
    },
  };
  res.status(500).json(body);
};

/**
 * 404 handler for unmatched routes. Mounted last, before `errorHandler`.
 */
export const notFoundHandler: ErrorRequestHandler = (_err, req, res, _next) => {
  res.status(404).json({
    error: {
      code: ErrorCodes.NOT_FOUND,
      message: `Route not found: ${req.method} ${req.path}`,
      ...(req.id ? { requestId: req.id } : {}),
    },
  });
};
