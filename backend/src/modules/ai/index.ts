/**
 * Public surface of the AI module.
 */

export {
  Forecast,
  FORECAST_HORIZONS,
  type ForecastDoc,
  type ForecastHydrated,
  type ForecastHorizonDays,
  type ForecastConfidence,
  type ForecastInputPoint,
  type ForecastReorderSuggestion,
  type ForecastOverride,
  type ForecastProvenance,
  type AiProvider,
} from './models/forecast.model.js';

export { AiUsage, periodKey, type AiUsageDoc, type AiUsageHydrated } from './models/aiUsage.model.js';
