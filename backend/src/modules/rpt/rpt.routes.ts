import { Router } from 'express';

import { validate } from '../../shared/middleware/validate.js';
import { rbacFor } from '../../shared/middleware/rbac.js';
import { ReportRangeQuerySchema } from './rpt.dto.js';
import { rptController } from './rpt.controller.js';

export const rptRouter = Router();

rptRouter.get(
  '/inventory-turnover',
  rbacFor('rpt.read'),
  validate(ReportRangeQuerySchema, 'query'),
  rptController.inventoryTurnover,
);
rptRouter.get(
  '/spend-by-supplier',
  rbacFor('rpt.read'),
  validate(ReportRangeQuerySchema, 'query'),
  rptController.spendBySupplier,
);
rptRouter.get(
  '/supplier-cost-comparison',
  rbacFor('rpt.read'),
  validate(ReportRangeQuerySchema, 'query'),
  rptController.supplierCostComparison,
);
rptRouter.get(
  '/cash-flow-projection',
  rbacFor('rpt.read'),
  rptController.cashFlowProjection,
);
rptRouter.get(
  '/dead-stock',
  rbacFor('rpt.read'),
  validate(ReportRangeQuerySchema, 'query'),
  rptController.deadStock,
);
