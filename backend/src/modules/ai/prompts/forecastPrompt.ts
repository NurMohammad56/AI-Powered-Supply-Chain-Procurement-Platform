import { PromptTemplate } from '@langchain/core/prompts';

import type { ForecastContext } from '../dataPreparation.js';

/**
 * Versioned prompt identifier - persisted on every forecast row in
 * `provenance.promptVersion`. Bump when the template materially changes;
 * historical forecasts remain comparable because the original version is
 * preserved.
 */
export const FORECAST_PROMPT_VERSION = 'forecast-v1.0.0';

/**
 * Maximum number of daily-series points to inline. 180 days fits well
 * within Groq's 128k-token Llama-3.3 context with substantial headroom
 * for the schema + reasoning. If a tenant's window expands past this,
 * the data-prep layer must downsample before invoking the prompt.
 */
const MAX_DAILY_POINTS = 200;

const SYSTEM_PREAMBLE = `You are a senior supply-chain analyst at a Bangladeshi manufacturing factory.
You produce demand forecasts that procurement managers use to place
purchase orders worth real money. Accuracy and calibrated uncertainty
matter more than confidence. Stay grounded in the supplied data.

Hard rules:
- Output STRICTLY one JSON object that conforms to the schema below.
- Do NOT include any text before or after the JSON.
- Do NOT use markdown code fences.
- Every numeric prediction must be non-negative and rounded to a whole
  unit (purchasing happens in integer quantities).
- If the data is too sparse to forecast responsibly, return a
  conservative forecast with confidence = "low" and explain in
  reasoning - do NOT refuse.
- predictedRange.lower <= predictedQuantity <= predictedRange.upper.
- The 60-day prediction must be >= the 30-day prediction; the 90-day
  must be >= the 60-day (cumulative semantics).
- reorderPoint = (averageDailyConsumption * leadTimeDays) +
  (safetyStockFactor * stdDeviation * sqrt(leadTimeDays)).

Edge-case guidance:
- dataSparsity = "empty": return zeros across all horizons,
  confidence = "low", reasoning explains there is no consumption
  history to learn from.
- dataSparsity = "sparse": down-weight noise; lean on median over
  mean; widen the prediction interval.
- coefficientOfVariation > 1.0: demand is highly volatile; widen
  intervals further and call this out in reasoning.
- seasonalityDetected = true: explicitly mention which lag (weekly or
  monthly) and adjust the horizon predictions accordingly.
- recencyBiasScore > 1.5 or < 0.66: trend has shifted recently; weight
  the last 30 days more heavily and say so.

Required JSON schema:
{
  "predictedQuantity30Day": number,
  "predictedQuantity60Day": number,
  "predictedQuantity90Day": number,
  "predictedRange30Day": { "lower": number, "upper": number },
  "predictedRange60Day": { "lower": number, "upper": number },
  "predictedRange90Day": { "lower": number, "upper": number },
  "confidence": "low" | "medium" | "high",
  "reasoning": string,
  "seasonalityDetected": boolean,
  "seasonalityNote": string | null,
  "reorderPointSuggestion": {
    "quantity": number,
    "safetyStockFactor": number,
    "leadTimeDaysAssumed": number
  } | null,
  "anomalies": string[]
}`;

const FEW_SHOT_EXAMPLES = `Example 1 - rich data, clear upward trend:
INPUT_FEATURES: {
  "windowDays": 180, "totalConsumed": 7200, "averageDailyConsumption": 40,
  "medianDailyConsumption": 38, "stdDeviation": 9.5, "coefficientOfVariation": 0.24,
  "trendDirection": "increasing", "trendSlopeUnitsPerDay": 0.12,
  "seasonalityDetected": true, "seasonalityScore": 0.42,
  "dataSparsity": "rich", "recencyBiasScore": 1.18
}
ITEM: { "sku": "FAB-COTTON-001", "preferredSupplierLeadTimeDays": 14 }
OUTPUT: {"predictedQuantity30Day":1320,"predictedQuantity60Day":2700,"predictedQuantity90Day":4140,"predictedRange30Day":{"lower":1180,"upper":1480},"predictedRange60Day":{"lower":2380,"upper":3050},"predictedRange90Day":{"lower":3600,"upper":4750},"confidence":"high","reasoning":"180 days of dense data with low CV (0.24) and a steady upward trend (+0.12 units/day). Recent 30-day usage is 18% above the prior baseline, supporting the growth signal. Weekly seasonality is present (score 0.42) so the intervals are widened slightly to absorb peak weeks. Forecasts cumulative the trend over each horizon.","seasonalityDetected":true,"seasonalityNote":"Weekly cycle detected - peaks land mid-week.","reorderPointSuggestion":{"quantity":620,"safetyStockFactor":1.65,"leadTimeDaysAssumed":14},"anomalies":[]}

Example 2 - new item with sparse history:
INPUT_FEATURES: {
  "windowDays": 28, "totalConsumed": 35, "averageDailyConsumption": 1.25,
  "medianDailyConsumption": 0, "stdDeviation": 2.1, "coefficientOfVariation": 1.68,
  "trendDirection": "flat", "trendSlopeUnitsPerDay": 0.01,
  "seasonalityDetected": false, "seasonalityScore": 0.08,
  "dataSparsity": "sparse", "zeroConsumptionDays": 22, "recencyBiasScore": 1.0
}
ITEM: { "sku": "PKG-LBL-NEW", "preferredSupplierLeadTimeDays": 7 }
OUTPUT: {"predictedQuantity30Day":40,"predictedQuantity60Day":80,"predictedQuantity90Day":120,"predictedRange30Day":{"lower":15,"upper":90},"predictedRange60Day":{"lower":35,"upper":180},"predictedRange90Day":{"lower":55,"upper":270},"confidence":"low","reasoning":"Only 28 days of history with 22 zero-consumption days. Coefficient of variation is 1.68 (highly volatile), so the median (0) is unreliable as a baseline. Forecast extrapolates the mean cautiously and widens the interval substantially. Recommend a re-run after 60 more days of data.","seasonalityDetected":false,"seasonalityNote":null,"reorderPointSuggestion":{"quantity":18,"safetyStockFactor":2.0,"leadTimeDaysAssumed":7},"anomalies":["Sparse history - prediction interval is wide by design."]}

Example 3 - empty history:
INPUT_FEATURES: { "windowDays": 0, "totalConsumed": 0, "averageDailyConsumption": 0, "medianDailyConsumption": 0, "stdDeviation": 0, "coefficientOfVariation": 0, "trendDirection": "flat", "trendSlopeUnitsPerDay": 0, "seasonalityDetected": false, "seasonalityScore": 0, "dataSparsity": "empty", "zeroConsumptionDays": 0, "recencyBiasScore": 1 }
ITEM: { "sku": "RAW-DYE-PURPLE", "preferredSupplierLeadTimeDays": null }
OUTPUT: {"predictedQuantity30Day":0,"predictedQuantity60Day":0,"predictedQuantity90Day":0,"predictedRange30Day":{"lower":0,"upper":0},"predictedRange60Day":{"lower":0,"upper":0},"predictedRange90Day":{"lower":0,"upper":0},"confidence":"low","reasoning":"No consumption history is available for this item. A forecast cannot be produced responsibly. The procurement manager should review historical paper records or initiate a small trial order to seed the model.","seasonalityDetected":false,"seasonalityNote":null,"reorderPointSuggestion":null,"anomalies":["Empty consumption history."]}`;

const TEMPLATE = `${SYSTEM_PREAMBLE}

${FEW_SHOT_EXAMPLES}

NOW PRODUCE THE FORECAST FOR THIS ITEM.

ITEM:
{itemJson}

FEATURES:
{featuresJson}

DAILY_SERIES (most recent {dailySeriesLength} days, oldest first):
{dailySeriesJson}

MONTHLY_SERIES:
{monthlySeriesJson}

Respond with ONLY the JSON object.`;

export const forecastPromptTemplate = PromptTemplate.fromTemplate(TEMPLATE);

/** Render the prompt for a prepared forecast context. */
export async function renderForecastPrompt(context: ForecastContext): Promise<string> {
  const trimmed = context.dailySeries.slice(-MAX_DAILY_POINTS);
  return forecastPromptTemplate.format({
    itemJson: JSON.stringify(context.item),
    featuresJson: JSON.stringify(context.features),
    dailySeriesLength: trimmed.length.toString(),
    dailySeriesJson: JSON.stringify(trimmed),
    monthlySeriesJson: JSON.stringify(context.monthlySeries),
  });
}

/** Approximate token count for the rendered prompt (~4 chars per token). */
export function estimatePromptTokens(rendered: string): number {
  return Math.ceil(rendered.length / 4);
}
