import { Router } from 'express';

import { validate } from '../../shared/middleware/validate.js';
import { rbacFor } from '../../shared/middleware/rbac.js';
import {
  AbcAnalysisQuerySchema,
  EoqQuerySchema,
  ReportRangeQuerySchema,
  UpsertBudgetRequestSchema,
} from './rpt.dto.js';
import { rptController } from './rpt.controller.js';
import { asyncHandler } from '../../shared/http/asyncHandler.js';
import { enqueueReport } from '../../shared/queue/queues.js';
import { ReportArtifact } from './models/reportArtifact.model.js';
import { presignGet } from '../../shared/storage/r2.client.js';
import { NotFoundError } from '../../shared/errors/HttpErrors.js';
import { objectIdStringSchema } from '../../shared/utils/objectId.js';
import { z } from 'zod';

export const rptRouter = Router();

rptRouter.post(
  '/weekly-digest',
  rbacFor('rpt.generate'),
  validate(ReportRangeQuerySchema),
  asyncHandler(async (req, res) => {
    if (!req.context) throw new NotFoundError();
    await enqueueReport('report.weekly_digest', {
      tenantId: req.context.tenantId.toString(),
      weekStart: req.body.from,
      weekEnd: req.body.to,
    });
    res.status(202).json({ data: { queued: true } });
  }),
);
rptRouter.get(
  '/artifacts',
  rbacFor('rpt.read'),
  asyncHandler(async (_req, res) => {
    const rows = await ReportArtifact.find().sort({ createdAt: -1 }).limit(100).lean().exec();
    res.json({ data: rows });
  }),
);
rptRouter.get(
  '/artifacts/:id/download',
  rbacFor('rpt.read'),
  validate(z.object({ id: objectIdStringSchema }), 'params'),
  asyncHandler(async (req, res) => {
    const artifact = await ReportArtifact.findById(req.params.id).lean().exec();
    if (!artifact || artifact.status !== 'ready' || !artifact.objectKey) throw new NotFoundError();
    res.json({ data: { url: await presignGet(artifact.objectKey) } });
  }),
);

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
rptRouter.get('/cash-flow-projection', rbacFor('rpt.read'), rptController.cashFlowProjection);
rptRouter.get(
  '/dead-stock',
  rbacFor('rpt.read'),
  validate(ReportRangeQuerySchema, 'query'),
  rptController.deadStock,
);
rptRouter.get(
  '/abc-analysis',
  rbacFor('rpt.read'),
  validate(AbcAnalysisQuerySchema, 'query'),
  rptController.abcAnalysis,
);
rptRouter.get('/eoq', rbacFor('rpt.read'), validate(EoqQuerySchema, 'query'), rptController.eoq);
rptRouter.get(
  '/budget',
  rbacFor('rpt.read'),
  validate(z.object({ monthStart: z.string().datetime().optional() }), 'query'),
  rptController.budgetStatus,
);
rptRouter.post(
  '/budget',
  rbacFor('rpt.budget.manage'),
  validate(UpsertBudgetRequestSchema),
  rptController.upsertBudget,
);
