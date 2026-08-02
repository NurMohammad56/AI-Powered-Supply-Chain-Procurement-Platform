import { Router } from 'express';

import { validate } from '../../shared/middleware/validate.js';
import { rbacFor } from '../../shared/middleware/rbac.js';
import { idempotencyKey } from '../../shared/middleware/idempotency.js';
import { rateLimitFileUpload } from '../../shared/middleware/rateLimit.js';
import {
  parseMultipartJsonField,
  parseSingleMultipartFile,
  uploadMultipartFileToBody,
} from '../../shared/uploads/multipart.js';
import {
  ApprovePoRequestSchema,
  CancelPoRequestSchema,
  CreateFromForecastRequestSchema,
  CreatePoRequestSchema,
  DispatchPoRequestSchema,
  ListPosQuerySchema,
  PoIdParamSchema,
  ReceivePoRequestSchema,
  RejectPoRequestSchema,
  SubmitPoRequestSchema,
  UpdatePoRequestSchema,
} from './po.dto.js';
import { poController } from './po.controller.js';

export const poRouter = Router();

poRouter.get(
  '/',
  rbacFor('po.read'),
  validate(ListPosQuerySchema, 'query'),
  poController.list,
);
poRouter.post(
  '/',
  rbacFor('po.create'),
  idempotencyKey,
  validate(CreatePoRequestSchema),
  poController.create,
);
poRouter.get(
  '/:id',
  rbacFor('po.read'),
  validate(PoIdParamSchema, 'params'),
  poController.get,
);
poRouter.patch(
  '/:id',
  rbacFor('po.update'),
  validate(PoIdParamSchema, 'params'),
  validate(UpdatePoRequestSchema),
  poController.update,
);

poRouter.post(
  '/:id/submit',
  rbacFor('po.submit'),
  idempotencyKey,
  validate(PoIdParamSchema, 'params'),
  validate(SubmitPoRequestSchema),
  poController.submit,
);
poRouter.post(
  '/:id/approve',
  rbacFor('po.approve'),
  idempotencyKey,
  validate(PoIdParamSchema, 'params'),
  validate(ApprovePoRequestSchema),
  poController.approve,
);
poRouter.post(
  '/:id/reject',
  rbacFor('po.reject'),
  idempotencyKey,
  validate(PoIdParamSchema, 'params'),
  validate(RejectPoRequestSchema),
  poController.reject,
);
poRouter.post(
  '/:id/dispatch',
  rbacFor('po.dispatch'),
  idempotencyKey,
  validate(PoIdParamSchema, 'params'),
  validate(DispatchPoRequestSchema),
  poController.dispatch,
);
poRouter.post(
  '/:id/cancel',
  rbacFor('po.cancel'),
  idempotencyKey,
  validate(PoIdParamSchema, 'params'),
  validate(CancelPoRequestSchema),
  poController.cancel,
);
poRouter.post(
  '/:id/close',
  rbacFor('po.update'),
  idempotencyKey,
  validate(PoIdParamSchema, 'params'),
  poController.close,
);

poRouter.post(
  '/:id/receipts',
  rbacFor('po.receive'),
  idempotencyKey,
  rateLimitFileUpload,
  parseSingleMultipartFile('file'),
  parseMultipartJsonField('payload'),
  uploadMultipartFileToBody({
    bodyField: 'grnDocumentUrl',
    folder: 'po-grn-documents',
    allowedKinds: ['image', 'document'],
    optional: true,
  }),
  validate(PoIdParamSchema, 'params'),
  validate(ReceivePoRequestSchema),
  poController.receive,
);
poRouter.get(
  '/:id/receipts',
  rbacFor('po.read'),
  validate(PoIdParamSchema, 'params'),
  poController.listReceipts,
);

// New: createFromForecast (AI-suggested PO), sendToSupplier (canonical
// dispatch + PDF + email), pdf download URL.
poRouter.post(
  '/from-forecast',
  rbacFor('po.create'),
  idempotencyKey,
  validate(CreateFromForecastRequestSchema),
  poController.createFromForecast,
);
poRouter.post(
  '/:id/send',
  rbacFor('po.dispatch'),
  idempotencyKey,
  validate(PoIdParamSchema, 'params'),
  validate(DispatchPoRequestSchema),
  poController.sendToSupplier,
);
poRouter.get(
  '/:id/pdf',
  rbacFor('po.read'),
  validate(PoIdParamSchema, 'params'),
  poController.getPdfDownload,
);
