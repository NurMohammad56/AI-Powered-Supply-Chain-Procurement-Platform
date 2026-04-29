import { Router } from 'express';

import { validate } from '../../shared/middleware/validate.js';
import { rbacFor } from '../../shared/middleware/rbac.js';
import { idempotencyKey } from '../../shared/middleware/idempotency.js';
import {
  AcceptQuotationRequestSchema,
  CreateQuotationRequestSchema,
  ListQuotationsQuerySchema,
  QuotationIdParamSchema,
  QuotationTokenParamSchema,
  SubmitQuotationResponseSchema,
} from './quotation.dto.js';
import { quotationController } from './quotation.controller.js';

/**
 * Authenticated quotation routes - mounted under `/api/quotations`.
 */
export const quotationRouter = Router();

quotationRouter.get(
  '/',
  rbacFor('supplier.read'),
  validate(ListQuotationsQuerySchema, 'query'),
  quotationController.list,
);
quotationRouter.post(
  '/',
  rbacFor('supplier.quote.send'),
  idempotencyKey,
  validate(CreateQuotationRequestSchema),
  quotationController.create,
);
quotationRouter.get(
  '/:id',
  rbacFor('supplier.read'),
  validate(QuotationIdParamSchema, 'params'),
  quotationController.get,
);
quotationRouter.post(
  '/:id/cancel',
  rbacFor('supplier.quote.send'),
  validate(QuotationIdParamSchema, 'params'),
  quotationController.cancel,
);
quotationRouter.post(
  '/:id/accept',
  rbacFor('supplier.quote.send'),
  idempotencyKey,
  validate(QuotationIdParamSchema, 'params'),
  validate(AcceptQuotationRequestSchema),
  quotationController.accept,
);
quotationRouter.get(
  '/:id/compare',
  rbacFor('supplier.read'),
  validate(QuotationIdParamSchema, 'params'),
  quotationController.compareQuotes,
);

/**
 * Public quotation response router - mounted under `/api/public/quotations`.
 * No JWT required; access gated by one-time response token.
 */
export const publicQuotationRouter = Router();

publicQuotationRouter.post(
  '/responses/:token',
  validate(QuotationTokenParamSchema, 'params'),
  validate(SubmitQuotationResponseSchema),
  quotationController.submitResponse,
);
