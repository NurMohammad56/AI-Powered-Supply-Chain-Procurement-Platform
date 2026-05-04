import type { ForecastContext } from '../dataPreparation.js';

export const FORECAST_PROMPT_VERSION = 'forecast-v1.0.1';

const MAX_DAILY_POINTS = 200;

const SYSTEM_PREAMBLE = `You are a senior supply-chain analyst at a Bangladeshi manufacturing factory.

Hard rules:
- Output STRICTLY one JSON object.
- No markdown.
- No extra text.
- All numbers must be integers.
- If unsure, return conservative estimates.
- Maintain logical consistency across 30/60/90 day forecasts.
`;

const FEW_SHOT_EXAMPLES = `
Example 1:
INPUT:
ITEM: FAB-COTTON-001
FEATURES: rich data, increasing trend, low volatility

OUTPUT:
predictedQuantity30Day = 1320
predictedQuantity60Day = 2700
predictedQuantity90Day = 4140
confidence = high

Example 2:
INPUT:
ITEM: PKG-LBL-NEW
FEATURES: sparse data, high volatility

OUTPUT:
predictedQuantity30Day = 40
predictedQuantity60Day = 80
predictedQuantity90Day = 120
confidence = low

Example 3:
INPUT:
ITEM: RAW-DYE-PURPLE
FEATURES: no history

OUTPUT:
predictedQuantity30Day = 0
predictedQuantity60Day = 0
predictedQuantity90Day = 0
confidence = low
`;

export function renderForecastPrompt(context: ForecastContext): string {
  const trimmed = context.dailySeries.slice(-MAX_DAILY_POINTS);

  return `
${SYSTEM_PREAMBLE}

${FEW_SHOT_EXAMPLES}

NOW PRODUCE THE FORECAST:

ITEM:
${JSON.stringify(context.item)}

FEATURES:
${JSON.stringify(context.features)}

DAILY_SERIES:
${JSON.stringify(trimmed)}

MONTHLY_SERIES:
${JSON.stringify(context.monthlySeries)}

Return ONLY valid JSON:
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
  "reorderPointSuggestion": null,
  "anomalies": string[]
}
`;
}

export function estimatePromptTokens(rendered: string): number {
  return Math.ceil(rendered.length / 4);
}
