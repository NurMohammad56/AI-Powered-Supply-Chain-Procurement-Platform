import type { TenantContext } from '../../shared/auth/types.js';
import {
  runCashFlowProjection,
  runDeadStock,
  runInventoryTurnover,
  runSpendBySupplier,
  runSupplierCostComparison,
} from './rpt.aggregations.js';
import type { ReportRangeQuery } from './rpt.dto.js';

export class RptService {
  async inventoryTurnover(ctx: TenantContext, q: ReportRangeQuery) {
    return runInventoryTurnover({
      tenantId: ctx.tenantId,
      from: new Date(q.from),
      to: new Date(q.to),
    });
  }

  async spendBySupplier(ctx: TenantContext, q: ReportRangeQuery) {
    return runSpendBySupplier({
      tenantId: ctx.tenantId,
      from: new Date(q.from),
      to: new Date(q.to),
    });
  }

  async supplierCostComparison(ctx: TenantContext, q: ReportRangeQuery) {
    return runSupplierCostComparison({
      tenantId: ctx.tenantId,
      from: new Date(q.from),
      to: new Date(q.to),
    });
  }

  async cashFlowProjection(ctx: TenantContext) {
    return runCashFlowProjection({ tenantId: ctx.tenantId });
  }

  async deadStock(ctx: TenantContext, q: ReportRangeQuery) {
    return runDeadStock({
      tenantId: ctx.tenantId,
      from: new Date(q.from),
      to: new Date(q.to),
    });
  }
}

export const rptService = new RptService();
