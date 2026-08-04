import type { Express } from 'express';

import { BadRequestError } from '../errors/HttpErrors.js';
import { ErrorCodes } from '../errors/errorCodes.js';
import {
  type FileKind,
  FileValidationError,
  sanitiseFilename,
  validateUpload,
} from '../security/fileUpload.js';
import { tenantKey, uploadObject } from '../storage/r2.client.js';

export interface StoredUpload {
  key: string;
  url: string;
  uploaded: boolean;
  filename: string;
  size: number;
  contentType: string;
  kind: FileKind;
}

export async function storeTenantUpload(args: {
  tenantId: string;
  folder: string;
  file: Express.Multer.File;
  allowedKinds: readonly FileKind[];
  metadata?: Record<string, string>;
}): Promise<StoredUpload> {
  if (!args.file?.buffer) {
    throw new BadRequestError(ErrorCodes.VALIDATION_FAILED, 'File is required', [
      { path: 'file', message: 'File is required' },
    ]);
  }

  const uploadInput = {
    filename: args.file.originalname,
    declaredMime: args.file.mimetype,
    body: args.file.buffer,
  };

  let lastError: FileValidationError | null = null;
  let matched:
    | {
        kind: FileKind;
        sanitisedFilename: string;
        size: number;
        mime: string;
      }
    | null = null;

  for (const kind of args.allowedKinds) {
    try {
      const validated = await validateUpload(uploadInput, kind);
      matched = { ...validated, kind };
      break;
    } catch (err) {
      if (!(err instanceof FileValidationError)) throw err;
      lastError = err;
    }
  }

  if (!matched) {
    throw new BadRequestError(
      ErrorCodes.VALIDATION_FAILED,
      lastError?.message ?? 'File upload validation failed',
      [{ path: 'file', message: lastError?.message ?? 'File upload validation failed' }],
    );
  }

  const filename = sanitiseFilename(args.file.originalname);
  const key = tenantKey(args.tenantId, args.folder, filename);
  const uploaded = await uploadObject({
    key,
    body: args.file.buffer,
    contentType: matched.mime,
    metadata: {
      originalFilename: filename,
      uploadKind: matched.kind,
      ...(args.metadata ?? {}),
    },
  });

  return {
    key: uploaded.key,
    url: uploaded.url,
    uploaded: uploaded.uploaded,
    filename: matched.sanitisedFilename,
    size: matched.size,
    contentType: matched.mime,
    kind: matched.kind,
  };
}
