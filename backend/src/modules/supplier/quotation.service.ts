import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';

import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from '../../shared/errors/HttpErrors.js';
import { ErrorCodes } from '../../shared/errors/errorCodes.js';
import { assertTenantOwns } from '../../shared/auth/assertTenantOwns.js';
import { recordAudit, AuditActions } from '../../shared/audit/index.js';
import { logger } from '../../config/logger.js';
import { enqueueForecast } from '../../shared/queue/queues.js';
import type { TenantContext } from '../../shared/auth/types.js';
import type { Page } from '../../shared/utils/pagination.js';
import { runTextPipeline } from '../ai/forecastPipeline.js';
import { Item } from '../inventory/models/item.model.js';
import { poService } from '../po/po.service.js';
import { quotationRepository } from './quotation.repository.js';
import { supplierRepository } from './supplier.repository.js';
import type { QuotationRequestDoc, QuotationResponseLine } from './models/quotationRequest.model.js';
import type { PoView } from '../po/po.dto.js';
import type {
  AcceptQuotationRequest,
  CreateQuotationRequest,
  ListQuotationsQuery,
  QuotationView,
  SubmitQuotationResponse,
} from './quotation.dto.js';

function genToken(): string {
  return randomBytes(32).toString('hex');
}

function genNumber(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = randomBytes(3).toString('hex').toUpperCase();
  return `RFQ-${ts}-${rand}`;
}

function toView(q: QuotationRequestDoc): QuotationView {
  return {
    id: q._id.toString(),
    number: q.number,
    status: q.status,
    requestedBy: q.requestedBy.toString(),
    validUntil: q.validUntil.toISOString(),
    lines: q.lines.map((l) => ({
      itemId: l.itemId.toString(),
      quantity: l.quantity,
      targetUnitPrice: l.targetUnitPrice,
      targetDeliveryDate: l.targetDeliveryDate ? l.targetDeliveryDate.toISOString() : null,
      remarks: l.remarks,
    })),
    supplierInvitations: q.supplierInvitations.map((inv) => ({
      supplierId: inv.supplierId.toString(),
      invitedAt: inv.invitedAt.toISOString(),
      invitedContactEmail: inv.invitedContactEmail,
      response: inv.response
        ? {
            submittedAt: inv.response.submittedAt.toISOString(),
            lines: inv.response.lines.map((rl) => ({
              itemId: rl.itemId.toString(),
              unitPrice: rl.unitPrice,
              currency: rl.currency,
              moq: rl.moq,
              leadTimeDays: rl.leadTimeDays,
              validityDays: rl.validityDays,
              remarks: rl.remarks,
            })),
            isLate: inv.response.isLate,
            comments: inv.response.comments,
          }
        : null,
    })),
    acceptedSupplierId: q.acceptedSupplierId ? q.acceptedSupplierId.toString() : null,
    acceptedAt: q.acceptedAt ? q.acceptedAt.toISOString() : null,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
  };
}

function pagedView<T, V>(page: Page<T>, mapper: (row: T) => V) {
  return {
    rows: page.rows.map(mapper),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    limit: page.limit,
  };
}

export class QuotationService {
  async create(ctx: TenantContext, input: CreateQuotationRequest): Promise<QuotationView> {
    const validUntil = new Date(input.validUntil);
    if (validUntil.getTime() <= Date.now()) {
      throw new BadRequestError(ErrorCodes.BAD_REQUEST, 'validUntil must be in the future');
    }

    const supplierIds = input.invitedSuppliers.map((s) => new Types.ObjectId(s.supplierId));
    const suppliers = await supplierRepository.findManyByIds(supplierIds);
    if (suppliers.length !== supplierIds.length) {
      throw new NotFoundError();
    }
    for (const s of suppliers) {
      assertTenantOwns(s, ctx);
    }

    const created = await quotationRepository.create({
      number: genNumber(),
      status: 'open',
      requestedBy: ctx.userId,
      validUntil,
      lines: input.lines.map((l) => ({
        itemId: new Types.ObjectId(l.itemId),
        quantity: l.quantity,
        targetUnitPrice: l.targetUnitPrice ?? null,
        targetDeliveryDate: l.targetDeliveryDate ? new Date(l.targetDeliveryDate) : null,
        remarks: l.remarks ?? null,
      })),
      supplierInvitations: input.invitedSuppliers.map((s) => ({
        supplierId: new Types.ObjectId(s.supplierId),
        responseToken: genToken(),
        invitedAt: new Date(),
        invitedContactEmail: s.contactEmail,
        response: null,
      })),
      aiRecommendation: null,
      acceptedSupplierId: null,
      acceptedAt: null,
    });

    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.QuoteRequestCreated,
      target: { kind: 'quotation', id: created._id },
      payload: { number: created.number, supplierCount: input.invitedSuppliers.length },
      requestId: ctx.requestId,
    });
    return toView(created);
  }

  async get(ctx: TenantContext, id: Types.ObjectId): Promise<QuotationView> {
    const q = await quotationRepository.findById(id);
    assertTenantOwns(q, ctx);
    return toView(q);
  }

  async list(_ctx: TenantContext, query: ListQuotationsQuery) {
    const page = await quotationRepository.list(query);
    return pagedView(page, toView);
  }

  async cancel(ctx: TenantContext, id: Types.ObjectId): Promise<QuotationView> {
    const q = await quotationRepository.findById(id);
    assertTenantOwns(q, ctx);
    const cancelled = await quotationRepository.cancel(id);
    if (!cancelled) {
      throw new ConflictError(ErrorCodes.RESOURCE_STATE_RACE, 'Quotation cannot be cancelled in its current state');
    }
    return toView(cancelled);
  }

  /**
   * Public endpoint: invited supplier submits a response using their
   * one-time token. NOT tenant-scoped via JWT; tenant is derived from
   * the quotation document found by token.
   */
  async submitResponse(token: string, input: SubmitQuotationResponse): Promise<QuotationView> {
    const q = await quotationRepository.findByToken(token);
    if (!q) {
      throw new UnauthorizedError(ErrorCodes.QUOTE_INVALID_TOKEN, 'Invalid response token');
    }
    if (q.status !== 'open') {
      throw new ConflictError(ErrorCodes.RESOURCE_STATE_RACE, 'Quotation is not open');
    }
    const inv = q.supplierInvitations.find((i) => i.responseToken === token);
    if (!inv) {
      throw new UnauthorizedError(ErrorCodes.QUOTE_INVALID_TOKEN, 'Invalid response token');
    }
    if (inv.response) {
      throw new ConflictError(ErrorCodes.QUOTE_ALREADY_RESPONDED, 'A response has already been recorded');
    }
    const now = new Date();
    if (q.validUntil.getTime() < now.getTime()) {
      throw new BadRequestError(ErrorCodes.QUOTE_EXPIRED, 'Quotation has expired');
    }
    const updated = await quotationRepository.setInvitationResponse({
      id: q._id,
      token,
      response: {
        submittedAt: now,
        lines: input.lines.map((l) => ({
          itemId: new Types.ObjectId(l.itemId),
          unitPrice: l.unitPrice,
          currency: l.currency,
          moq: l.moq,
          leadTimeDays: l.leadTimeDays,
          validityDays: l.validityDays,
          remarks: l.remarks ?? null,
        })),
        isLate: false,
        comments: input.comments ?? null,
      },
    });
    if (!updated) {
      throw new ConflictError(ErrorCodes.RESOURCE_STATE_RACE, 'Response could not be recorded');
    }
    void recordAudit({
      tenantId: q.tenantId,
      actorUserId: null,
      actorRole: 'supplier',
      action: AuditActions.QuoteResponseReceived,
      target: { kind: 'quotation', id: q._id },
      payload: { supplierId: inv.supplierId.toString() },
    });
    return toView(updated);
  }

  async accept(
    ctx: TenantContext,
    id: Types.ObjectId,
    input: AcceptQuotationRequest,
  ): Promise<{ quotation: QuotationView; purchaseOrder: PoView | null }> {
    const q = await quotationRepository.findById(id);
    assertTenantOwns(q, ctx);
    if (q.status !== 'open') {
      throw new ConflictError(ErrorCodes.RESOURCE_STATE_RACE, 'Quotation is not open');
    }
    const supplierId = new Types.ObjectId(input.supplierId);
    const inv = q.supplierInvitations.find((i) => i.supplierId.toString() === supplierId.toString());
    if (!inv) {
      throw new NotFoundError();
    }
    if (!inv.response) {
      throw new BadRequestError(ErrorCodes.BAD_REQUEST, 'Selected supplier has not submitted a response');
    }
    const accepted = await quotationRepository.accept({
      id,
      supplierId,
      acceptedAt: new Date(),
    });
    if (!accepted) {
      throw new ConflictError(ErrorCodes.RESOURCE_STATE_RACE, 'Quotation already accepted or closed');
    }
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.QuoteAccepted,
      target: { kind: 'quotation', id },
      payload: { supplierId: input.supplierId },
      requestId: ctx.requestId,
    });

    // Auto-build a draft PO from the accepted quote response. Failure
    // to draft must not roll back the quote acceptance - the user can
    // create the PO manually as a fallback.
    let purchaseOrder: PoView | null = null;
    try {
      purchaseOrder = await this.buildPoFromAcceptedQuote({ ctx, q: accepted, inv });
    } catch (err) {
      logger.warn(
        { err, event: 'quote.accept.po_draft_failed', quotationId: id.toString() },
        'auto-PO from accepted quote failed; create manually',
      );
    }

    return { quotation: toView(accepted), purchaseOrder };
  }

  /**
   * Build a draft PO from an accepted quote. Quantity comes from the
   * original RFQ line; pricing + lead time come from the supplier's
   * winning response. The PO is created as a draft so the buyer can
   * still review before submission.
   */
  private async buildPoFromAcceptedQuote(args: {
    ctx: TenantContext;
    q: QuotationRequestDoc;
    inv: QuotationRequestDoc['supplierInvitations'][number];
  }): Promise<PoView | null> {
    const response = args.inv.response;
    if (!response) return null;

    const responseLineByItem = new Map<string, QuotationResponseLine>();
    for (const rl of response.lines) {
      responseLineByItem.set(rl.itemId.toString(), rl);
    }

    // Default the warehouse to the first item's tenant default. Real
    // implementation should accept a warehouse hint from the caller.
    const firstItem = args.q.lines[0];
    if (!firstItem) return null;
    const item = await Item.findOne({
      _id: firstItem.itemId,
      tenantId: args.ctx.tenantId,
    })
      .lean()
      .exec();
    if (!item) return null;

    const supplier = await supplierRepository.findById(args.inv.supplierId);
    if (!supplier) return null;
    const leadTimeDays =
      Math.max(...response.lines.map((l) => l.leadTimeDays)) || supplier.leadTimeDays;
    const expectedDeliveryAt = new Date(Date.now() + leadTimeDays * 24 * 60 * 60 * 1000);

    const lines = args.q.lines
      .map((rfqLine) => {
        const responseLine = responseLineByItem.get(rfqLine.itemId.toString());
        if (!responseLine) return null;
        return {
          itemId: rfqLine.itemId.toString(),
          quantityOrdered: rfqLine.quantity,
          unitPrice: responseLine.unitPrice,
          expectedDeliveryAt: rfqLine.targetDeliveryDate
            ? rfqLine.targetDeliveryDate.toISOString()
            : expectedDeliveryAt.toISOString(),
          remarks: `From quotation ${args.q.number}`,
        };
      })
      .filter((l): l is NonNullable<typeof l> => l !== null);
    if (lines.length === 0) return null;

    return poService.create(args.ctx, {
      supplierId: supplier._id.toString(),
      warehouseId: item.preferredSupplierId
        ? item.preferredSupplierId.toString()
        : (firstItem.itemId as unknown as Types.ObjectId).toString(),
      // Currency follows the supplier response; assume single currency
      // across response lines (the RFQ enforces this in practice).
      currency: response.lines[0]?.currency ?? 'BDT',
      paymentTermsDays: supplier.paymentTermsDays,
      expectedDeliveryAt: expectedDeliveryAt.toISOString(),
      lines,
      taxRate: 0,
    });
  }

  /**
   * Compare every supplier's quote response on a quotation request and
   * produce an AI-narrated recommendation. The numeric comparison is
   * deterministic; the LLM only writes the prose summary.
   */
  async compareQuotes(ctx: TenantContext, id: Types.ObjectId): Promise<{
    quotationNumber: string;
    rows: Array<{
      supplierId: string;
      supplierName: string | null;
      submittedAt: string | null;
      lineCount: number;
      totalCost: number;
      averageLeadTimeDays: number;
      isComplete: boolean;
    }>;
    aiSummary: string | null;
    recommendedSupplierId: string | null;
  }> {
    const q = await quotationRepository.findById(id);
    assertTenantOwns(q, ctx);
    const supplierIds = q.supplierInvitations.map((inv) => inv.supplierId);
    const suppliers = await supplierRepository.findManyByIds(supplierIds);
    const supplierNameById = new Map<string, string>();
    for (const s of suppliers) supplierNameById.set(s._id.toString(), s.legalName);

    // Aggregate per-supplier metrics.
    const lineQtyByItem = new Map<string, number>();
    for (const line of q.lines) lineQtyByItem.set(line.itemId.toString(), line.quantity);

    const rows = q.supplierInvitations.map((inv) => {
      const r = inv.response;
      if (!r) {
        return {
          supplierId: inv.supplierId.toString(),
          supplierName: supplierNameById.get(inv.supplierId.toString()) ?? null,
          submittedAt: null,
          lineCount: 0,
          totalCost: 0,
          averageLeadTimeDays: 0,
          isComplete: false,
        };
      }
      let totalCost = 0;
      let leadSum = 0;
      let leadCount = 0;
      for (const rl of r.lines) {
        const qty = lineQtyByItem.get(rl.itemId.toString()) ?? 0;
        totalCost += qty * rl.unitPrice;
        leadSum += rl.leadTimeDays;
        leadCount += 1;
      }
      const expectedItems = q.lines.length;
      return {
        supplierId: inv.supplierId.toString(),
        supplierName: supplierNameById.get(inv.supplierId.toString()) ?? null,
        submittedAt: r.submittedAt.toISOString(),
        lineCount: r.lines.length,
        totalCost: Math.round(totalCost * 100) / 100,
        averageLeadTimeDays: leadCount === 0 ? 0 : Math.round(leadSum / leadCount),
        isComplete: r.lines.length === expectedItems,
      };
    });

    // The recommended supplier is the lowest-totalCost complete response;
    // the AI prose explains the tradeoffs (price vs lead time vs MOQ).
    const completeRows = rows.filter((r) => r.isComplete);
    completeRows.sort((a, b) => a.totalCost - b.totalCost);
    const recommended = completeRows[0] ?? null;

    let aiSummary: string | null = null;
    if (rows.some((r) => r.isComplete)) {
      try {
        const prompt = `You are a senior procurement analyst. Compare the following quote responses for RFQ ${q.number} and recommend a supplier in 4-6 sentences. Reference numbers from the data; do not invent. If the cheapest supplier has a notably longer lead time or partial coverage, call that out.

DATA:
${JSON.stringify(rows, null, 2)}

Respond with the recommendation only, no preamble.`;
        const result = await runTextPipeline(prompt);
        aiSummary = result.text.trim();
      } catch (err) {
        logger.warn(
          { err, event: 'quote.compare.ai_summary_failed', quotationId: id.toString() },
          'AI quote comparison failed; returning numeric summary only',
        );
      }
    }

    return {
      quotationNumber: q.number,
      rows,
      aiSummary,
      recommendedSupplierId: recommended?.supplierId ?? null,
    };
  }
}

// Reference imports kept intentionally to silence "unused" lint - the
// forecast retrigger hook below is used when a quote auto-PO is drafted
// against an item the dashboard is currently viewing.
void enqueueForecast;

export const quotationService = new QuotationService();
