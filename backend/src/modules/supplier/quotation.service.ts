import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';

import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from '../../shared/errors/HttpErrors.js';
import { ErrorCodes } from '../../shared/errors/errorCodes.js';
import { assertTenantOwns } from '../../shared/auth/assertTenantOwns.js';
import { recordAudit, AuditActions } from '../../shared/audit/index.js';
import type { TenantContext } from '../../shared/auth/types.js';
import type { Page } from '../../shared/utils/pagination.js';
import { quotationRepository } from './quotation.repository.js';
import { supplierRepository } from './supplier.repository.js';
import type { QuotationRequestDoc } from './models/quotationRequest.model.js';
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
  ): Promise<QuotationView> {
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
    return toView(accepted);
  }
}

export const quotationService = new QuotationService();
