import { Router } from 'express';

import { rateLimitFileUpload } from '../../shared/middleware/rateLimit.js';
import { parseSingleMultipartFile } from '../../shared/uploads/multipart.js';
import { uploadController } from './upload.controller.js';

export const uploadRouter = Router();

uploadRouter.post(
  '/',
  rateLimitFileUpload,
  parseSingleMultipartFile('file'),
  uploadController.create,
);
