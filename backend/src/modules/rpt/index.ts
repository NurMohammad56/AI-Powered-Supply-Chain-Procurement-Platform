/**
 * Public surface of the reporting / analytics module.
 */

export {
  KpiSnapshot,
  KPI_PERIODS,
  type KpiSnapshotDoc,
  type KpiPeriodGrain,
  type InventoryKpis,
  type ProcurementKpis,
  type SupplierKpis,
  type AiKpis,
} from './models/kpiSnapshot.model.js';

export {
  StockSnapshot,
  type StockSnapshotDoc,
  type StockSnapshotEntry,
} from './models/stockSnapshot.model.js';

export {
  ReportArtifact,
  REPORT_KINDS,
  type ReportArtifactDoc,
  type ReportKind,
  type ReportFormat,
  type ReportStatus,
} from './models/reportArtifact.model.js';

export {
  inventoryTurnoverByCategoryPipeline,
  spendBySupplierPipeline,
  supplierCostComparisonPipeline,
  cashFlowProjectionPipeline,
  deadStockPipeline,
  runInventoryTurnover,
  runSpendBySupplier,
  runSupplierCostComparison,
  runCashFlowProjection,
  runDeadStock,
  type PipelineRangeArgs,
} from './rpt.aggregations.js';
