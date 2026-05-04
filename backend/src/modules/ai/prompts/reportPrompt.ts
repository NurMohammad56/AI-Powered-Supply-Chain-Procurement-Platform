import { PromptTemplate } from '@langchain/core/prompts';

export const REPORT_PROMPT_VERSION = 'weekly-report-v1.0.1';

export interface WeeklyReportInputs {
  tenantName: string;
  weekStart: string;
  weekEnd: string;
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

export function renderReportPrompt(inputs: WeeklyReportInputs): string {
  return `
You are a senior supply-chain consultant writing a weekly executive brief.

Style:
- Markdown only
- 4 sections:
  ## Highlights
  ## Risks & alerts
  ## Supplier performance
  ## Recommendations for next week
- 3–6 bullets per section
- No invented numbers
- No AI disclaimers

DATA:
TENANT: ${inputs.tenantName}
PERIOD: ${inputs.weekStart} to ${inputs.weekEnd}

METRICS:
${JSON.stringify(inputs.metrics, null, 2)}

Now generate the report.
`;
}
