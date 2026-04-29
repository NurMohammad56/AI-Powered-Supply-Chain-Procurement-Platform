import { PromptTemplate } from '@langchain/core/prompts';

export const REPORT_PROMPT_VERSION = 'weekly-report-v1.0.0';

export interface WeeklyReportInputs {
  tenantName: string;
  weekStart: string;
  weekEnd: string;
  /** Aggregated metrics from the analytics layer. */
  metrics: {
    totalMovements: number;
    totalConsumed: number;
    totalReceived: number;
    poCount: number;
    poTotalValue: number;
    poFullyReceivedCount: number;
    onTimeDeliveryRate: number | null;
    lowStockItemCount: number;
    deadStockItemCount: number;
    topConsumedItems: Array<{ sku: string; name: string; consumed: number }>;
    topSpendSuppliers: Array<{ legalName: string; spend: number; poCount: number }>;
    forecastsGenerated: number;
  };
}

const TEMPLATE = `You are a senior supply-chain consultant writing a weekly executive
brief for the owner of a Bangladeshi manufacturing factory. The owner
reads in a hurry; lead with what they need to act on this week.

Style:
- Markdown only (no JSON, no code fences).
- Headings exactly: "## Highlights", "## Risks & alerts",
  "## Supplier performance", "## Recommendations for next week".
- Each section has 3-6 short bullet points; every bullet must reference
  a specific metric from the data block.
- Currency values are BDT unless explicitly USD; always include the
  unit. Round percentages to one decimal place.
- Do NOT invent numbers. If a metric is missing or null, omit the
  bullet.
- Never include disclaimers, apologies, or "as an AI" language.

DATA:
TENANT: {tenantName}
PERIOD: {weekStart} to {weekEnd}
METRICS:
{metricsJson}

Produce the report now.`;

export const reportPromptTemplate = PromptTemplate.fromTemplate(TEMPLATE);

export async function renderReportPrompt(inputs: WeeklyReportInputs): Promise<string> {
  return reportPromptTemplate.format({
    tenantName: inputs.tenantName,
    weekStart: inputs.weekStart,
    weekEnd: inputs.weekEnd,
    metricsJson: JSON.stringify(inputs.metrics, null, 2),
  });
}
