import { Router } from 'express';
import { rbacFor } from '../../shared/middleware/rbac.js';

import { rateLimitFileUpload } from '../../shared/middleware/rateLimit.js';
import { parseSingleMultipartFile } from '../../shared/uploads/multipart.js';
import { uploadController } from './upload.controller.js';

export const uploadRouter = Router();

uploadRouter.post(
  '/',
  rbacFor('file.upload'),
  rateLimitFileUpload,
  parseSingleMultipartFile('file'),
  uploadController.create,
);
