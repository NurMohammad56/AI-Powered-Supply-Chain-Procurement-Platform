import type { Types } from 'mongoose';

import { logger } from '../../config/logger.js';
import { emailClient } from '../../shared/email/resend.client.js';
import { recordAudit } from '../../shared/audit/index.js';
import { Factory } from '../auth/models/factory.model.js';
import { User } from '../auth/models/user.model.js';
import { StockMovement } from '../inventory/models/stockMovement.model.js';
import { StockBalance } from '../inventory/models/stockBalance.model.js';
import { PurchaseOrder } from '../po/models/purchaseOrder.model.js';
import { Supplier } from '../supplier/models/supplier.model.js';
import { Forecast } from './models/forecast.model.js';
import {
  REPORT_PROMPT_VERSION,
  renderReportPrompt,
  type WeeklyReportInputs,
} from './prompts/reportPrompt.js';
import { runTextPipeline } from './forecastPipeline.js';
import { aiUsageRepository, checkQuota, estimateCostMicroUsd } from './aiUsage.repository.js';

export interface WeeklyReportResult {
  tenantId: string;
  weekStart: string;
  weekEnd: string;
  markdown: string;
  pdfBuffer: Buffer | null;
  pdfRendered: boolean;
  emailSent: boolean;
  provider: 'groq' | 'gemini';
  promptVersion: string;
}

/**
 * Generate the full weekly report:
 *   1. Aggregate metrics over the [weekStart, weekEnd] window.
 *   2. Render the Markdown brief via the AI pipeline (Groq -> Gemini fallback).
 *   3. Convert Markdown -> HTML -> PDF (Puppeteer; gracefully no-op if
 *      Chromium is unavailable - the email still includes the Markdown).
 *   4. Email the result to the factory owner.
 *
 * Returns the artefacts so the worker can persist them for the audit
 * trail.
 */
export async function generateWeeklyReport(args: {
  tenantId: Types.ObjectId;
  weekStart: Date;
  weekEnd: Date;
}): Promise<WeeklyReportResult> {
  const factory = await Factory.findById(args.tenantId).lean().exec();
  if (!factory) {
    throw new Error(`Tenant not found: ${args.tenantId.toString()}`);
  }

  const metrics = await aggregateWeeklyMetrics({
    tenantId: args.tenantId,
    from: args.weekStart,
    to: args.weekEnd,
  });

  const inputs: WeeklyReportInputs = {
    tenantName: factory.name,
    weekStart: args.weekStart.toISOString().slice(0, 10),
    weekEnd: args.weekEnd.toISOString().slice(0, 10),
    metrics,
  };

  // Quota gate (use trial cap for pre-onboarded tenants).
  const tier = (factory as unknown as { tier?: 'trial' | 'starter' | 'growth' | 'enterprise' }).tier ?? 'trial';
  const estimatedTokens = Math.max(2_000, Math.ceil(JSON.stringify(metrics).length / 4) + 1_500);
  const quota = await checkQuota({
    tenantId: args.tenantId,
    tier,
    callKind: 'report',
    estimatedTokens,
  });
  if (!quota.allowed) {
    logger.warn(
      { event: 'report.quota_blocked', tenantId: args.tenantId.toString(), reason: quota.reason },
      'weekly report blocked by AI quota',
    );
    throw new Error(`AI quota exceeded for tenant; reason=${quota.reason ?? 'unknown'}`);
  }

  const prompt = await renderReportPrompt(inputs);
  const aiResult = await runTextPipeline(prompt);
  const markdown = aiResult.text.trim();

  const cost = estimateCostMicroUsd({
    provider: aiResult.provider,
    promptTokens: aiResult.promptTokens,
    completionTokens: aiResult.completionTokens,
  });
  await aiUsageRepository.increment({
    tenantId: args.tenantId,
    promptTokens: aiResult.promptTokens,
    completionTokens: aiResult.completionTokens,
    callKind: 'report',
    estimatedCostMicroUsd: cost,
  });

  const html = markdownToHtml(markdown, factory.name, inputs.weekStart, inputs.weekEnd);
  const pdfResult = await renderHtmlToPdf(html);

  const owner = await resolveOwnerEmail(args.tenantId, factory.ownerUserId);
  let emailSent = false;
  if (owner) {
    const emailResult = await emailClient.send({
      to: owner.email,
      subject: `Weekly procurement brief: ${inputs.weekStart} - ${inputs.weekEnd}`,
      html,
      text: markdown,
      tags: { kind: 'weekly_report', tenantId: args.tenantId.toString() },
    });
    emailSent = emailResult.delivered;
    if (!emailResult.delivered) {
      logger.warn(
        { event: 'report.email_failed', err: emailResult.error, tenantId: args.tenantId.toString() },
        'weekly report email failed',
      );
    }
  }

  void recordAudit({
    tenantId: args.tenantId,
    actorUserId: null,
    actorRole: 'system',
    action: 'rpt.weekly.generated',
    target: { kind: 'report', id: null },
    payload: {
      weekStart: inputs.weekStart,
      weekEnd: inputs.weekEnd,
      provider: aiResult.provider,
      pdfRendered: pdfResult.rendered,
      emailSent,
    },
  });

  return {
    tenantId: args.tenantId.toString(),
    weekStart: inputs.weekStart,
    weekEnd: inputs.weekEnd,
    markdown,
    pdfBuffer: pdfResult.buffer,
    pdfRendered: pdfResult.rendered,
    emailSent,
    provider: aiResult.provider,
    promptVersion: REPORT_PROMPT_VERSION,
  };
}

async function aggregateWeeklyMetrics(args: {
  tenantId: Types.ObjectId;
  from: Date;
  to: Date;
}): Promise<WeeklyReportInputs['metrics']> {
  const [
    movementAgg,
    poAgg,
    fullyReceivedCount,
    lowStockCount,
    deadStockCount,
    topConsumed,
    topSupplierSpend,
    forecastsGenerated,
    onTimeDeliveryRate,
  ] = await Promise.all([
    StockMovement.aggregate<{ totalMovements: number; totalConsumed: number; totalReceived: number }>([
      {
        $match: {
          tenantId: args.tenantId,
          performedAt: { $gte: args.from, $lte: args.to },
        },
      },
      {
        $group: {
          _id: null,
          totalMovements: { $sum: 1 },
          totalConsumed: {
            $sum: {
              $cond: [
                { $in: ['$type', ['out', 'transfer_out']] },
                { $abs: '$quantity' },
                {
                  $cond: [
                    { $and: [{ $eq: ['$type', 'adjustment'] }, { $lt: ['$quantity', 0] }] },
                    { $abs: '$quantity' },
                    0,
                  ],
                },
              ],
            },
          },
          totalReceived: {
            $sum: {
              $cond: [{ $in: ['$type', ['in', 'transfer_in']] }, '$quantity', 0],
            },
          },
        },
      },
    ]).exec(),
    PurchaseOrder.aggregate<{ poCount: number; poTotalValue: number }>([
      {
        $match: {
          tenantId: args.tenantId,
          createdAt: { $gte: args.from, $lte: args.to },
        },
      },
      {
        $group: {
          _id: null,
          poCount: { $sum: 1 },
          poTotalValue: { $sum: '$totals.total' },
        },
      },
    ]).exec(),
    PurchaseOrder.countDocuments({
      tenantId: args.tenantId,
      state: 'fully_received',
      closedAt: { $gte: args.from, $lte: args.to },
    }).exec(),
    StockBalance.countDocuments({
      tenantId: args.tenantId,
      lowStockSince: { $type: 'date' },
    }).exec(),
    StockBalance.countDocuments({
      tenantId: args.tenantId,
      lastMovementAt: { $lte: new Date(args.to.getTime() - 90 * 24 * 60 * 60 * 1000) },
    }).exec(),
    StockMovement.aggregate<{ sku: string; name: string; consumed: number }>([
      {
        $match: {
          tenantId: args.tenantId,
          performedAt: { $gte: args.from, $lte: args.to },
          type: { $in: ['out', 'transfer_out'] },
        },
      },
      { $group: { _id: '$itemId', consumed: { $sum: { $abs: '$quantity' } } } },
      { $sort: { consumed: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'items',
          localField: '_id',
          foreignField: '_id',
          as: 'item',
        },
      },
      { $unwind: '$item' },
      { $project: { _id: 0, sku: '$item.sku', name: '$item.name', consumed: 1 } },
    ]).exec(),
    PurchaseOrder.aggregate<{ legalName: string; spend: number; poCount: number }>([
      {
        $match: {
          tenantId: args.tenantId,
          createdAt: { $gte: args.from, $lte: args.to },
        },
      },
      {
        $group: {
          _id: '$supplierId',
          spend: { $sum: '$totals.total' },
          poCount: { $sum: 1 },
        },
      },
      { $sort: { spend: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'suppliers',
          localField: '_id',
          foreignField: '_id',
          as: 'supplier',
        },
      },
      { $unwind: '$supplier' },
      { $project: { _id: 0, legalName: '$supplier.legalName', spend: 1, poCount: 1 } },
    ]).exec(),
    Forecast.countDocuments({
      tenantId: args.tenantId,
      generatedAt: { $gte: args.from, $lte: args.to },
    }).exec(),
    computeOnTimeDeliveryRate({ tenantId: args.tenantId, from: args.from, to: args.to }),
  ]);

  // Reference unused Supplier import to keep the lookup intent clear in
  // the dependency graph (the aggregation already does the join, but the
  // type binding documents that the supplier collection is involved).
  void Supplier;

  const movementRow = movementAgg[0] ?? { totalMovements: 0, totalConsumed: 0, totalReceived: 0 };
  const poRow = poAgg[0] ?? { poCount: 0, poTotalValue: 0 };

  return {
    totalMovements: movementRow.totalMovements,
    totalConsumed: movementRow.totalConsumed,
    totalReceived: movementRow.totalReceived,
    poCount: poRow.poCount,
    poTotalValue: poRow.poTotalValue,
    poFullyReceivedCount: fullyReceivedCount,
    onTimeDeliveryRate,
    lowStockItemCount: lowStockCount,
    deadStockItemCount: deadStockCount,
    topConsumedItems: topConsumed,
    topSpendSuppliers: topSupplierSpend,
    forecastsGenerated,
  };
}

async function computeOnTimeDeliveryRate(args: {
  tenantId: Types.ObjectId;
  from: Date;
  to: Date;
}): Promise<number | null> {
  const result = await PurchaseOrder.aggregate<{ onTime: number; total: number }>([
    {
      $match: {
        tenantId: args.tenantId,
        state: 'fully_received',
        closedAt: { $gte: args.from, $lte: args.to },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        onTime: {
          $sum: { $cond: [{ $lte: ['$closedAt', '$expectedDeliveryAt'] }, 1, 0] },
        },
      },
    },
  ]).exec();
  const row = result[0];
  if (!row || row.total === 0) return null;
  return Math.round((row.onTime / row.total) * 1000) / 1000;
}

async function resolveOwnerEmail(
  tenantId: Types.ObjectId,
  ownerUserId: Types.ObjectId | null,
): Promise<{ email: string; fullName: string } | null> {
  if (ownerUserId) {
    const owner = await User.findOne({ _id: ownerUserId, tenantId })
      .select({ email: 1, fullName: 1 })
      .lean()
      .exec();
    if (owner?.email) return { email: owner.email, fullName: owner.fullName };
  }
  // Fallback: any user with role=owner on this tenant.
  const fallback = await User.findOne({ tenantId, role: 'owner', status: 'active' })
    .select({ email: 1, fullName: 1 })
    .lean()
    .exec();
  if (fallback?.email) return { email: fallback.email, fullName: fallback.fullName };
  return null;
}

/**
 * Convert Markdown to a self-contained HTML document suitable for PDF
 * conversion. Intentionally minimal - no external CSS, no JS, and
 * single-pass regex transforms for predictability.
 */
function markdownToHtml(markdown: string, tenantName: string, weekStart: string, weekEnd: string): string {
  const escaped = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const inlined = escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const blocks: string[] = [];
  let listBuffer: string[] = [];
  for (const rawLine of inlined.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('## ')) {
      flushList(listBuffer, blocks);
      listBuffer = [];
      blocks.push(`<h2>${line.slice(3)}</h2>`);
    } else if (line.startsWith('# ')) {
      flushList(listBuffer, blocks);
      listBuffer = [];
      blocks.push(`<h1>${line.slice(2)}</h1>`);
    } else if (/^[-*] /.test(line)) {
      listBuffer.push(line.slice(2));
    } else if (line === '') {
      flushList(listBuffer, blocks);
      listBuffer = [];
    } else {
      flushList(listBuffer, blocks);
      listBuffer = [];
      blocks.push(`<p>${line}</p>`);
    }
  }
  flushList(listBuffer, blocks);

  const safeTenant = tenantName.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Weekly procurement brief - ${safeTenant}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 720px; margin: 24px auto; padding: 0 16px; color: #1f2937; line-height: 1.5; }
  header { border-bottom: 2px solid #1E40AF; padding-bottom: 12px; margin-bottom: 24px; }
  header h1 { color: #1E40AF; margin: 0 0 4px 0; }
  header .meta { color: #4b5563; font-size: 13px; }
  h2 { color: #1E40AF; margin-top: 28px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
  ul { padding-left: 22px; }
  li { margin: 4px 0; }
  code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }
  footer { margin-top: 32px; color: #6b7280; font-size: 11px; border-top: 1px solid #e5e7eb; padding-top: 12px; }
</style>
</head>
<body>
<header>
  <h1>Weekly procurement brief</h1>
  <div class="meta">${safeTenant} - ${weekStart} to ${weekEnd}</div>
</header>
${blocks.join('\n')}
<footer>Generated by AI; verify figures against the dashboard before acting.</footer>
</body>
</html>`;
}

function flushList(buffer: string[], out: string[]): void {
  if (buffer.length === 0) return;
  out.push(`<ul>${buffer.map((b) => `<li>${b}</li>`).join('')}</ul>`);
}

/**
 * Render the report HTML to a PDF buffer using Puppeteer headless
 * Chromium. Returns `{ rendered: false, buffer: null }` when Chromium is
 * not available in the runtime (e.g. development boxes without the
 * binary) so callers can still email the Markdown body.
 */
interface PuppeteerLike {
  launch: (opts: Record<string, unknown>) => Promise<{
    newPage: () => Promise<{
      setContent: (html: string, opts: Record<string, unknown>) => Promise<unknown>;
      pdf: (opts: Record<string, unknown>) => Promise<Uint8Array>;
    }>;
    close: () => Promise<void>;
  }>;
}

interface ChromiumLike {
  executablePath: () => Promise<string>;
  args: string[];
}

async function renderHtmlToPdf(html: string): Promise<{ buffer: Buffer | null; rendered: boolean }> {
  let puppeteer: PuppeteerLike | null = null;
  let chromium: ChromiumLike | null = null;
  try {
    const puppeteerMod: unknown = await import('puppeteer-core');
    puppeteer = puppeteerMod as PuppeteerLike;
    const chromiumMod: unknown = await import('@sparticuz/chromium');
    chromium = (chromiumMod as { default: ChromiumLike }).default;
  } catch (err) {
    logger.warn({ err, event: 'report.pdf.deps_missing' }, 'puppeteer-core or chromium not available');
    return { buffer: null, rendered: false };
  }
  let browser: Awaited<ReturnType<PuppeteerLike['launch']>> | null = null;
  try {
    const executablePath = await chromium.executablePath();
    if (!executablePath) {
      logger.info({ event: 'report.pdf.no_chromium' }, 'Chromium binary unavailable; skipping PDF render');
      return { buffer: null, rendered: false };
    }
    browser = await puppeteer.launch({
      args: chromium.args ?? [],
      executablePath,
      headless: true,
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
    });
    return { buffer: Buffer.from(pdf), rendered: true };
  } catch (err) {
    logger.warn({ err, event: 'report.pdf.render_failed' }, 'PDF render failed; falling back to Markdown email');
    return { buffer: null, rendered: false };
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}
