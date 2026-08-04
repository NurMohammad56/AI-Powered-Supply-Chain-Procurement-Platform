import type { RequestHandler } from 'express';
import multer from 'multer';

import { BadRequestError, UnauthorizedError } from '../errors/HttpErrors.js';
import { ErrorCodes } from '../errors/errorCodes.js';
import type { FileKind } from '../security/fileUpload.js';
import { storeTenantUpload } from './upload.service.js';

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

function isMultipart(req: Parameters<RequestHandler>[0]): boolean {
  return Boolean(req.is('multipart/form-data'));
}

function mapMulterError(err: unknown): Error {
  if (err instanceof multer.MulterError) {
    return new BadRequestError(ErrorCodes.VALIDATION_FAILED, err.message, [
      { path: err.field ?? 'file', message: err.message },
    ]);
  }
  return err instanceof Error ? err : new Error('Unknown multipart parser error');
}

export function parseSingleMultipartFile(fieldName = 'file'): RequestHandler {
  return (req, res, next) => {
    if (!isMultipart(req)) return next();
    memoryUpload.single(fieldName)(req, res, (err) => {
      if (err) return next(mapMulterError(err));
      return next();
    });
  };
}

export function parseMultipartJsonField(fieldName = 'payload'): RequestHandler {
  return (req, _res, next) => {
    if (!isMultipart(req)) return next();
    const raw = req.body?.[fieldName];
    if (typeof raw !== 'string' || raw.trim() === '') return next();
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const otherFields = req.body as Record<string, unknown>;
      delete otherFields[fieldName];
      req.body = {
        ...parsed,
        ...otherFields,
      };
      return next();
    } catch {
      return next(
        new BadRequestError(ErrorCodes.VALIDATION_FAILED, 'Invalid JSON payload', [
          { path: fieldName, message: 'Invalid JSON payload' },
        ]),
      );
    }
  };
}

export function uploadMultipartFileToBody(opts: {
  bodyField: string;
  folder: string;
  allowedKinds: readonly FileKind[];
  fileField?: string;
  optional?: boolean;
}): RequestHandler {
  return (req, _res, next) => {
    if (!isMultipart(req)) return next();
    void (async () => {
      try {
        const file = req.file;
        if (!file) {
          if (opts.optional) return next();
          return next(
            new BadRequestError(ErrorCodes.VALIDATION_FAILED, 'File is required', [
              { path: opts.fileField ?? 'file', message: 'File is required' },
            ]),
          );
        }
        if (!req.context) {
          return next(
            new UnauthorizedError(ErrorCodes.AUTH_TOKEN_MISSING, 'Tenant context not resolved'),
          );
        }
        const stored = await storeTenantUpload({
          tenantId: req.context.tenantId.toString(),
          folder: opts.folder,
          file,
          allowedKinds: opts.allowedKinds,
          metadata: {
            actorUserId: req.context.userId.toString(),
            route: req.path,
          },
        });
        (req.body as Record<string, unknown>)[opts.bodyField] = stored.url;
        return next();
      } catch (err) {
        return next(err);
      }
    })();
  };
}
