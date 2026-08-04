import { created } from '../../shared/http/apiResponse.js';
import { asyncHandler } from '../../shared/http/asyncHandler.js';
import { BadRequestError, UnauthorizedError } from '../../shared/errors/HttpErrors.js';
import { ErrorCodes } from '../../shared/errors/errorCodes.js';
import { UploadFileRequestSchema } from './upload.dto.js';
import { storeTenantUpload } from '../../shared/uploads/upload.service.js';

export const uploadController = {
  create: asyncHandler(async (req, res) => {
    if (!req.context) {
      throw new UnauthorizedError(ErrorCodes.AUTH_TOKEN_MISSING, 'Tenant context not resolved');
    }
    if (!req.file) {
      throw new BadRequestError(ErrorCodes.VALIDATION_FAILED, 'File is required', [
        { path: 'file', message: 'File is required' },
      ]);
    }
    const parsed = UploadFileRequestSchema.parse(req.body);
    const uploaded = await storeTenantUpload({
      tenantId: req.context.tenantId.toString(),
      folder: parsed.folder ?? `uploads/${parsed.kind}`,
      file: req.file,
      allowedKinds: [parsed.kind],
      metadata: {
        actorUserId: req.context.userId.toString(),
        route: req.path,
      },
    });
    return created(req, res, uploaded);
  }),
};
