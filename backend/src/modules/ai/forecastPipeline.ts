import { ChatGroq } from '@langchain/groq';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessageChunk } from '@langchain/core/messages';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { renderForecastPrompt, FORECAST_PROMPT_VERSION, estimatePromptTokens } from './prompts/forecastPrompt.js';
import {
  coerceForecast,
  extractJsonObject,
  type StrictForecastResponse,
} from './validators/forecastValidator.js';
import type { ForecastContext } from './dataPreparation.js';

export type AiProvider = 'groq' | 'gemini';

export interface PipelineResult {
  response: StrictForecastResponse;
  provider: AiProvider;
  model: string;
  promptVersion: string;
  failoverInvoked: boolean;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  rawPrompt: string;
  rawResponse: string;
  coerced: boolean;
  fallback: boolean;
}

/**
 * Per-provider circuit breaker. Trips after N consecutive failures and
 * stays open for `cooldownMs`; the pipeline routes around an open
 * breaker to the alternate provider.
 *
 * Process-local on purpose - each backend instance carries its own
 * counters so a flaky pod does not poison every worker. Distributed
 * coordination would be over-engineering for this scale.
 */
class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly name: string,
    private readonly threshold: number,
    private readonly cooldownMs: number,
  ) {}

  isOpen(now = Date.now()): boolean {
    if (this.openedAt === null) return false;
    if (now - this.openedAt >= this.cooldownMs) {
      // Cooldown elapsed - half-open: clear the gate, the next call decides.
      this.openedAt = null;
      this.failures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openedAt = Date.now();
      logger.warn(
        { event: 'ai.circuit_breaker.open', provider: this.name, failures: this.failures },
        'AI circuit breaker tripped',
      );
    }
  }
}

const groqBreaker = new CircuitBreaker('groq', env.AI_FAILURE_THRESHOLD, env.AI_COOLDOWN_MS);
const geminiBreaker = new CircuitBreaker('gemini', env.AI_FAILURE_THRESHOLD, env.AI_COOLDOWN_MS);

/** Lazy provider construction so missing keys do not blow up at boot. */
function getGroq(): BaseChatModel | null {
  if (!env.GROQ_API_KEY) return null;
  return new ChatGroq({
    apiKey: env.GROQ_API_KEY,
    model: env.GROQ_MODEL,
    temperature: 0.1,
    maxTokens: 2048,
    timeout: env.AI_PER_CALL_TIMEOUT_MS,
  });
}

function getGemini(): BaseChatModel | null {
  if (!env.GEMINI_API_KEY) return null;
  return new ChatGoogleGenerativeAI({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    temperature: 0.1,
    maxOutputTokens: 2048,
  });
}

interface ProviderInvocation {
  provider: AiProvider;
  model: string;
  text: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

async function invokeProvider(args: {
  client: BaseChatModel;
  provider: AiProvider;
  model: string;
  prompt: string;
}): Promise<ProviderInvocation> {
  const start = Date.now();
  const result = await args.client.invoke(args.prompt);
  const latencyMs = Date.now() - start;
  const text = typeof result.content === 'string' ? result.content : extractContentText(result.content);
  const usage = readUsageMetadata(result);
  return {
    provider: args.provider,
    model: args.model,
    text,
    promptTokens: usage.prompt,
    completionTokens: usage.completion,
    latencyMs,
  };
}

function extractContentText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && 'text' in c && typeof (c as { text: unknown }).text === 'string') {
          return (c as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function readUsageMetadata(msg: AIMessageChunk): { prompt: number; completion: number } {
  const meta = (msg as unknown as {
    usage_metadata?: { input_tokens?: number; output_tokens?: number };
    response_metadata?: {
      tokenUsage?: { promptTokens?: number; completionTokens?: number };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
  }).usage_metadata;
  if (meta?.input_tokens !== undefined || meta?.output_tokens !== undefined) {
    return { prompt: meta.input_tokens ?? 0, completion: meta.output_tokens ?? 0 };
  }
  const respMeta = (msg as unknown as {
    response_metadata?: {
      tokenUsage?: { promptTokens?: number; completionTokens?: number };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
  }).response_metadata;
  if (respMeta?.tokenUsage) {
    return {
      prompt: respMeta.tokenUsage.promptTokens ?? 0,
      completion: respMeta.tokenUsage.completionTokens ?? 0,
    };
  }
  if (respMeta?.usage) {
    return {
      prompt: respMeta.usage.input_tokens ?? 0,
      completion: respMeta.usage.output_tokens ?? 0,
    };
  }
  return { prompt: 0, completion: 0 };
}

/**
 * Run the forecast pipeline end-to-end: data context -> prompt ->
 * primary LLM (Groq) -> validate -> fallback to Gemini on any failure
 * mode (network, breaker open, parse error). Always resolves with a
 * usable result even if both providers fail; the deterministic baseline
 * is the floor of correctness.
 */
export async function runForecastPipeline(context: ForecastContext): Promise<PipelineResult> {
  const prompt = renderForecastPrompt(context);
  const promptTokensEstimate = estimatePromptTokens(prompt);

  const leadTimeDays = context.item.preferredSupplierLeadTimeDays ?? 14;
  let failoverInvoked = false;

  const groq = getGroq();
  if (groq && !groqBreaker.isOpen()) {
    try {
      const invocation = await invokeProvider({
        client: groq,
        provider: 'groq',
        model: env.GROQ_MODEL,
        prompt,
      });
      const parsed = tryParseAndCoerce(invocation.text, context, leadTimeDays);
      if (parsed) {
        groqBreaker.recordSuccess();
        return buildResult({
          invocation,
          parsed,
          failoverInvoked,
          rawPrompt: prompt,
          fallbackPromptTokens: promptTokensEstimate,
        });
      }
      // Parse failure counts as a soft failure for breaker purposes.
      groqBreaker.recordFailure();
      failoverInvoked = true;
      logger.warn(
        { event: 'ai.parse_failed', provider: 'groq', textLength: invocation.text.length },
        'Groq returned unparseable output; failing over',
      );
    } catch (err) {
      groqBreaker.recordFailure();
      failoverInvoked = true;
      logger.warn(
        { err, event: 'ai.provider_error', provider: 'groq' },
        'Groq invocation failed; failing over',
      );
    }
  } else if (groq) {
    failoverInvoked = true;
    logger.info({ event: 'ai.breaker_open', provider: 'groq' }, 'Groq breaker open; routing to Gemini');
  }

  const gemini = getGemini();
  if (gemini && !geminiBreaker.isOpen()) {
    try {
      const invocation = await invokeProvider({
        client: gemini,
        provider: 'gemini',
        model: env.GEMINI_MODEL,
        prompt,
      });
      const parsed = tryParseAndCoerce(invocation.text, context, leadTimeDays);
      if (parsed) {
        geminiBreaker.recordSuccess();
        return buildResult({
          invocation,
          parsed,
          failoverInvoked: true,
          rawPrompt: prompt,
          fallbackPromptTokens: promptTokensEstimate,
        });
      }
      geminiBreaker.recordFailure();
      logger.warn(
        { event: 'ai.parse_failed', provider: 'gemini', textLength: invocation.text.length },
        'Gemini returned unparseable output; using deterministic baseline',
      );
    } catch (err) {
      geminiBreaker.recordFailure();
      logger.warn(
        { err, event: 'ai.provider_error', provider: 'gemini' },
        'Gemini invocation failed; using deterministic baseline',
      );
    }
  }

  // Both providers exhausted - return deterministic baseline.
  const baseline = coerceForecast({
    features: context.features,
    leadTimeDays,
    rawJson: undefined,
  });
  logger.error(
    {
      event: 'ai.both_providers_failed',
      itemId: context.item.id,
      groqOpen: groqBreaker.isOpen(),
      geminiOpen: geminiBreaker.isOpen(),
    },
    'Both AI providers failed; deterministic baseline returned',
  );
  return {
    response: baseline.response,
    provider: 'groq',
    model: env.GROQ_MODEL,
    promptVersion: FORECAST_PROMPT_VERSION,
    failoverInvoked: true,
    latencyMs: 0,
    promptTokens: promptTokensEstimate,
    completionTokens: 0,
    rawPrompt: prompt,
    rawResponse: '',
    coerced: baseline.coerced,
    fallback: true,
  };
}

function tryParseAndCoerce(
  text: string,
  context: ForecastContext,
  leadTimeDays: number,
): { response: StrictForecastResponse; coerced: boolean; fallback: boolean } | null {
  let json: unknown;
  try {
    json = extractJsonObject(text);
  } catch {
    return null;
  }
  return coerceForecast({
    features: context.features,
    leadTimeDays,
    rawJson: json,
  });
}

function buildResult(args: {
  invocation: ProviderInvocation;
  parsed: { response: StrictForecastResponse; coerced: boolean; fallback: boolean };
  failoverInvoked: boolean;
  rawPrompt: string;
  fallbackPromptTokens: number;
}): PipelineResult {
  return {
    response: args.parsed.response,
    provider: args.invocation.provider,
    model: args.invocation.model,
    promptVersion: FORECAST_PROMPT_VERSION,
    failoverInvoked: args.failoverInvoked,
    latencyMs: args.invocation.latencyMs,
    promptTokens: args.invocation.promptTokens || args.fallbackPromptTokens,
    completionTokens: args.invocation.completionTokens || Math.ceil(args.invocation.text.length / 4),
    rawPrompt: args.rawPrompt,
    rawResponse: args.invocation.text,
    coerced: args.parsed.coerced,
    fallback: args.parsed.fallback,
  };
}

/**
 * Run a free-form text prompt against the same provider chain. Used by
 * the report generator (Markdown out, no JSON contract). Returns the
 * raw text + provenance.
 */
export async function runTextPipeline(prompt: string): Promise<{
  text: string;
  provider: AiProvider;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  failoverInvoked: boolean;
}> {
  let failoverInvoked = false;

  const groq = getGroq();
  if (groq && !groqBreaker.isOpen()) {
    try {
      const invocation = await invokeProvider({
        client: groq,
        provider: 'groq',
        model: env.GROQ_MODEL,
        prompt,
      });
      groqBreaker.recordSuccess();
      return { ...invocation, failoverInvoked };
    } catch (err) {
      groqBreaker.recordFailure();
      failoverInvoked = true;
      logger.warn({ err, event: 'ai.text.groq_failed' }, 'Groq text invocation failed; failing over');
    }
  } else if (groq) {
    failoverInvoked = true;
  }

  const gemini = getGemini();
  if (gemini && !geminiBreaker.isOpen()) {
    try {
      const invocation = await invokeProvider({
        client: gemini,
        provider: 'gemini',
        model: env.GEMINI_MODEL,
        prompt,
      });
      geminiBreaker.recordSuccess();
      return { ...invocation, failoverInvoked: true };
    } catch (err) {
      geminiBreaker.recordFailure();
      logger.error({ err, event: 'ai.text.gemini_failed' }, 'Gemini text invocation failed');
    }
  }

  throw new Error('AI text pipeline: both providers unavailable');
}
