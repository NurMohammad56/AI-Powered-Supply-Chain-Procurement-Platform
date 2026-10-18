import { Router } from 'express';

import { validate } from '../../shared/middleware/validate.js';
import { rbacFor } from '../../shared/middleware/rbac.js';
import { idempotencyKey } from '../../shared/middleware/idempotency.js';
import { rateLimitAi } from '../../shared/middleware/rateLimit.js';
import {
  BatchForecastRequestSchema,
  ForecastIdParamSchema,
  GenerateForecastRequestSchema,
  ListForecastsQuerySchema,
  OverrideForecastRequestSchema,
} from './ai.dto.js';
import { aiController } from './ai.controller.js';
import { AiInsight } from './models/aiInsight.model.js';
import { asyncHandler } from '../../shared/http/asyncHandler.js';

export const aiRouter = Router();

aiRouter.get(
  '/insights',
  rbacFor('ai.forecast.generate'),
  asyncHandler(async (_req, res) => {
    const rows = await AiInsight.find().sort({ createdAt: -1 }).limit(100).lean().exec();
    res.json({ data: rows });
  }),
);

aiRouter.get(
  '/forecasts',
  rbacFor('ai.forecast.generate'),
  validate(ListForecastsQuerySchema, 'query'),
  aiController.listForecasts,
);
aiRouter.post(
  '/forecasts',
  rbacFor('ai.forecast.generate'),
  rateLimitAi,
  idempotencyKey,
  validate(GenerateForecastRequestSchema),
  aiController.generateForecast,
);
aiRouter.get(
  '/forecasts/:id',
  rbacFor('ai.forecast.generate'),
  validate(ForecastIdParamSchema, 'params'),
  aiController.getForecast,
);
aiRouter.get(
  '/forecasts/:id/evaluation',
  rbacFor('ai.forecast.generate'),
  validate(ForecastIdParamSchema, 'params'),
  aiController.forecastEvaluation,
);
aiRouter.get(
  '/forecasts/:id/visualization',
  rbacFor('ai.forecast.generate'),
  validate(ForecastIdParamSchema, 'params'),
  aiController.forecastVisualization,
);
aiRouter.post(
  '/forecasts/:id/override',
  rbacFor('ai.forecast.override'),
  validate(ForecastIdParamSchema, 'params'),
  validate(OverrideForecastRequestSchema),
  aiController.overrideForecast,
);

aiRouter.post(
  '/forecasts/batch',
  rbacFor('ai.forecast.generate'),
  rateLimitAi,
  idempotencyKey,
  validate(BatchForecastRequestSchema),
  aiController.runBatch,
);

aiRouter.get('/usage', rbacFor('ai.forecast.generate'), aiController.getUsage);
