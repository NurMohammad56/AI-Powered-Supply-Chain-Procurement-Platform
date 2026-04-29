import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';

import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors/HttpErrors.js';
import { ErrorCodes } from '../../shared/errors/errorCodes.js';
import { assertTenantOwns } from '../../shared/auth/assertTenantOwns.js';
import { recordAudit, AuditActions } from '../../shared/audit/index.js';
import { logger } from '../../config/logger.js';
import { enqueueForecast, enqueueScheduled } from '../../shared/queue/queues.js';
import { tenantKey, uploadObject, presignGet } from '../../shared/storage/r2.client.js';
import { Factory } from '../auth/models/factory.model.js';
import type { TenantContext } from '../../shared/auth/types.js';
import type { Page } from '../../shared/utils/pagination.js';
import { inventoryRepository } from '../inventory/inventory.repository.js';
import { supplierRepository } from '../supplier/supplier.repository.js';
import { aiRepository } from '../ai/ai.repository.js';
import { poRepository } from './po.repository.js';
import {
  PURCHASE_ORDER_TRANSITIONS,
  type PurchaseOrderDoc,
  type PurchaseOrderState,
  type PoLine,
} from './models/purchaseOrder.model.js';
import type { PoReceiptDoc } from './models/poReceipt.model.js';
import { renderPoPdf } from './po.pdf.js';
import {
  notifyPoApproved,
  notifyPoFullyReceived,
  notifyPoRejected,
  notifyPoSentToSupplier,
  notifyPoSubmitted,
} from './po.notifications.js';
import type {
  ApprovePoRequest,
  CancelPoRequest,
  CreatePoRequest,
  DispatchPoRequest,
  ListPosQuery,
  PoReceiptView,
  PoView,
  ReceivePoRequest,
  RejectPoRequest,
  UpdatePoRequest,
} from './po.dto.js';

function genNumber(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = randomBytes(3).toString('hex').toUpperCase();
  return `PO-${ts}-${rand}`;
}

function canTransition(from: PurchaseOrderState, to: PurchaseOrderState): boolean {
  return PURCHASE_ORDER_TRANSITIONS[from].includes(to);
}

function toView(po: PurchaseOrderDoc): PoView {
  return {
    id: po._id.toString(),
    number: po.number,
    state: po.state,
    supplierId: po.supplierId.toString(),
    supplierSnapshot: {
      legalName: po.supplierSnapshot.legalName,
      address: po.supplierSnapshot.address,
      primaryContactEmail: po.supplierSnapshot.primaryContactEmail,
    },
    warehouseId: po.warehouseId.toString(),
    currency: po.currency,
    paymentTermsDays: po.paymentTermsDays,
    expectedDeliveryAt: po.expectedDeliveryAt.toISOString(),
    lines: po.lines.map((l) => ({
      id: ((l as unknown as { _id?: Types.ObjectId })._id ?? new Types.ObjectId()).toString(),
      itemId: l.itemId.toString(),
      itemSnapshot: l.itemSnapshot,
      quantityOrdered: l.quantityOrdered,
      quantityReceived: l.quantityReceived,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
      expectedDeliveryAt: l.expectedDeliveryAt ? l.expectedDeliveryAt.toISOString() : null,
      remarks: l.remarks,
    })),
    totals: po.totals,
    pdfUrl: po.pdfUrl,
    pdfGeneratedAt: po.pdfGeneratedAt ? po.pdfGeneratedAt.toISOString() : null,
    approval: po.approval
      ? {
          submittedAt: po.approval.submittedAt ? po.approval.submittedAt.toISOString() : null,
          submittedBy: po.approval.submittedBy ? po.approval.submittedBy.toString() : null,
          decidedAt: po.approval.decidedAt ? po.approval.decidedAt.toISOString() : null,
          decidedBy: po.approval.decidedBy ? po.approval.decidedBy.toString() : null,
          decision: po.approval.decision,
          rejectReason: po.approval.rejectReason,
          thresholdRule: po.approval.thresholdRule,
        }
      : null,
    dispatch: po.dispatch
      ? { sentAt: po.dispatch.sentAt.toISOString(), sentTo: po.dispatch.sentTo }
      : null,
    cancellation: po.cancellation
      ? {
          cancelledAt: po.cancellation.cancelledAt.toISOString(),
          cancelledBy: po.cancellation.cancelledBy.toString(),
          reason: po.cancellation.reason,
        }
      : null,
    createdBy: po.createdBy.toString(),
    approvedAt: po.approvedAt ? po.approvedAt.toISOString() : null,
    closedAt: po.closedAt ? po.closedAt.toISOString() : null,
    createdAt: po.createdAt.toISOString(),
    updatedAt: po.updatedAt.toISOString(),
  };
}

function toReceiptView(r: PoReceiptDoc): PoReceiptView {
  return {
    id: r._id.toString(),
    poId: r.poId.toString(),
    poNumber: r.poNumber,
    receivedAt: r.receivedAt.toISOString(),
    receivedBy: r.receivedBy.toString(),
    warehouseId: r.warehouseId.toString(),
    lines: r.lines.map((l) => ({
      poLineId: l.poLineId.toString(),
      itemId: l.itemId.toString(),
      quantity: l.quantity,
      unitCost: l.unitCost,
      qualityNotes: l.qualityNotes,
    })),
    grnDocumentUrl: r.grnDocumentUrl,
    resultingState: r.resultingState,
    notes: r.notes,
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

export class PoService {
  async create(ctx: TenantContext, input: CreatePoRequest): Promise<PoView> {
    const supplier = await supplierRepository.findById(input.supplierId);
    assertTenantOwns(supplier, ctx);
    const warehouse = await inventoryRepository.findWarehouseById(input.warehouseId);
    assertTenantOwns(warehouse, ctx);

    const lines: PoLine[] = [];
    let subtotal = 0;
    for (const line of input.lines) {
      const item = await inventoryRepository.findItemById(line.itemId);
      assertTenantOwns(item, ctx);
      const lineTotal = Math.round(line.quantityOrdered * line.unitPrice * 100) / 100;
      subtotal += lineTotal;
      lines.push({
        itemId: item._id,
        itemSnapshot: { sku: item.sku, name: item.name, unit: item.unit },
        quantityOrdered: line.quantityOrdered,
        quantityReceived: 0,
        unitPrice: line.unitPrice,
        lineTotal,
        expectedDeliveryAt: line.expectedDeliveryAt ? new Date(line.expectedDeliveryAt) : null,
        remarks: line.remarks ?? null,
      });
    }
    const tax = Math.round(subtotal * input.taxRate * 100) / 100;
    const total = Math.round((subtotal + tax) * 100) / 100;

    const primaryContact = supplier.contacts.find((c) => c.isPrimary) ?? supplier.contacts[0] ?? null;

    const created = await poRepository.create({
      number: genNumber(),
      state: 'draft',
      supplierId: supplier._id,
      supplierSnapshot: {
        legalName: supplier.legalName,
        address: supplier.address ? `${supplier.address.street}, ${supplier.address.city}` : null,
        primaryContactEmail: primaryContact?.email ?? null,
      },
      warehouseId: warehouse._id,
      currency: input.currency,
      paymentTermsDays: input.paymentTermsDays,
      expectedDeliveryAt: new Date(input.expectedDeliveryAt),
      lines,
      totals: { subtotal: Math.round(subtotal * 100) / 100, tax, total },
      createdBy: ctx.userId,
      approval: null,
      dispatch: null,
      cancellation: null,
      revisions: [],
      pdfUrl: null,
      pdfGeneratedAt: null,
      approvedAt: null,
      closedAt: null,
    });

    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.PoCreated,
      target: { kind: 'po', id: created._id },
      payload: { number: created.number, total },
      requestId: ctx.requestId,
    });
    return toView(created);
  }

  async update(ctx: TenantContext, id: Types.ObjectId, patch: UpdatePoRequest): Promise<PoView> {
    const po = await poRepository.findById(id);
    assertTenantOwns(po, ctx);
    if (po.state !== 'draft' && po.state !== 'rejected') {
      throw new ConflictError(
        ErrorCodes.PO_INVALID_STATE_TRANSITION,
        'Only draft or rejected POs can be edited',
      );
    }
    const update: Partial<PurchaseOrderDoc> = {};
    if (patch.warehouseId !== undefined) update.warehouseId = new Types.ObjectId(patch.warehouseId);
    if (patch.currency !== undefined) update.currency = patch.currency;
    if (patch.paymentTermsDays !== undefined) update.paymentTermsDays = patch.paymentTermsDays;
    if (patch.expectedDeliveryAt !== undefined) update.expectedDeliveryAt = new Date(patch.expectedDeliveryAt);
    if (patch.lines !== undefined) {
      const lines: PoLine[] = [];
      let subtotal = 0;
      for (const line of patch.lines) {
        const item = await inventoryRepository.findItemById(line.itemId);
        assertTenantOwns(item, ctx);
        const lineTotal = Math.round(line.quantityOrdered * line.unitPrice * 100) / 100;
        subtotal += lineTotal;
        lines.push({
          itemId: item._id,
          itemSnapshot: { sku: item.sku, name: item.name, unit: item.unit },
          quantityOrdered: line.quantityOrdered,
          quantityReceived: 0,
          unitPrice: line.unitPrice,
          lineTotal,
          expectedDeliveryAt: line.expectedDeliveryAt ? new Date(line.expectedDeliveryAt) : null,
          remarks: line.remarks ?? null,
        });
      }
      update.lines = lines;
      const taxRate = patch.taxRate ?? po.totals.subtotal > 0 ? po.totals.tax / po.totals.subtotal : 0;
      const tax = Math.round(subtotal * taxRate * 100) / 100;
      update.totals = {
        subtotal: Math.round(subtotal * 100) / 100,
        tax,
        total: Math.round((subtotal + tax) * 100) / 100,
      };
    }

    const updated = await poRepository.update(id, update);
    if (!updated) throw new NotFoundError();
    if (updated.state === 'rejected') {
      // After edit, allow user to re-submit by moving back to draft.
      const reset = await poRepository.transitionState({
        id,
        fromState: 'rejected',
        toState: 'draft',
      });
      if (reset) return toView(reset);
    }
    return toView(updated);
  }

  async get(ctx: TenantContext, id: Types.ObjectId): Promise<PoView> {
    const po = await poRepository.findById(id);
    assertTenantOwns(po, ctx);
    return toView(po);
  }

  async list(_ctx: TenantContext, query: ListPosQuery) {
    const page = await poRepository.list({
      ...query,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
    return pagedView(page, toView);
  }

  async submit(ctx: TenantContext, id: Types.ObjectId): Promise<PoView> {
    const po = await poRepository.findById(id);
    assertTenantOwns(po, ctx);
    if (po.lines.length === 0) {
      throw new BadRequestError(ErrorCodes.PO_NO_LINES, 'PO must have at least one line');
    }
    if (!canTransition(po.state, 'pending_approval')) {
      throw new ConflictError(
        ErrorCodes.PO_INVALID_STATE_TRANSITION,
        `Cannot submit PO in state ${po.state}`,
      );
    }
    const updated = await poRepository.transitionState({
      id,
      fromState: po.state,
      toState: 'pending_approval',
      extraSet: {
        approval: {
          submittedAt: new Date(),
          submittedBy: ctx.userId,
          decidedAt: null,
          decidedBy: null,
          decision: null,
          rejectReason: null,
          thresholdRule: null,
        },
      },
    });
    if (!updated) {
      throw new ConflictError(ErrorCodes.PO_STATE_RACE, 'PO state changed concurrently');
    }
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.PoSubmitted,
      target: { kind: 'po', id },
      requestId: ctx.requestId,
    });
    void notifyPoSubmitted({ po: updated, submitterId: ctx.userId });
    return toView(updated);
  }

  async approve(ctx: TenantContext, id: Types.ObjectId, input: ApprovePoRequest): Promise<PoView> {
    const po = await poRepository.findById(id);
    assertTenantOwns(po, ctx);
    if (!canTransition(po.state, 'approved')) {
      throw new ConflictError(
        ErrorCodes.PO_INVALID_STATE_TRANSITION,
        `Cannot approve PO in state ${po.state}`,
      );
    }
    const at = new Date();
    const updated = await poRepository.transitionState({
      id,
      fromState: po.state,
      toState: 'approved',
      extraSet: {
        approvedAt: at,
        approval: {
          submittedAt: po.approval?.submittedAt ?? at,
          submittedBy: po.approval?.submittedBy ?? null,
          decidedAt: at,
          decidedBy: ctx.userId,
          decision: 'approved',
          rejectReason: null,
          thresholdRule: input.thresholdRule ?? null,
        },
      },
    });
    if (!updated) {
      throw new ConflictError(ErrorCodes.PO_STATE_RACE, 'PO state changed concurrently');
    }
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.PoApproved,
      target: { kind: 'po', id },
      requestId: ctx.requestId,
    });
    // Render+upload the approved PO PDF in the background, then email
    // the requester with the link. Do not block the API response.
    void this.generateAndStorePdf(updated).then((pdfUrl) => {
      void notifyPoApproved({ po: updated, approverId: ctx.userId, pdfUrl });
    });
    return toView(updated);
  }

  async reject(ctx: TenantContext, id: Types.ObjectId, input: RejectPoRequest): Promise<PoView> {
    const po = await poRepository.findById(id);
    assertTenantOwns(po, ctx);
    if (!canTransition(po.state, 'rejected')) {
      throw new ConflictError(
        ErrorCodes.PO_INVALID_STATE_TRANSITION,
        `Cannot reject PO in state ${po.state}`,
      );
    }
    const at = new Date();
    const updated = await poRepository.transitionState({
      id,
      fromState: po.state,
      toState: 'rejected',
      extraSet: {
        approval: {
          submittedAt: po.approval?.submittedAt ?? at,
          submittedBy: po.approval?.submittedBy ?? null,
          decidedAt: at,
          decidedBy: ctx.userId,
          decision: 'rejected',
          rejectReason: input.reason,
          thresholdRule: po.approval?.thresholdRule ?? null,
        },
      },
    });
    if (!updated) {
      throw new ConflictError(ErrorCodes.PO_STATE_RACE, 'PO state changed concurrently');
    }
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.PoRejected,
      target: { kind: 'po', id },
      payload: { reason: input.reason },
      requestId: ctx.requestId,
    });
    void notifyPoRejected({ po: updated, approverId: ctx.userId, reason: input.reason });
    return toView(updated);
  }

  /**
   * `dispatch` is the legacy verb retained for the existing route; the
   * canonical entry point per Prompt 05 is `sendToSupplier`, which
   * additionally renders the PDF, uploads to R2, and emails the
   * supplier contact with the presigned link.
   */
  async sendToSupplier(ctx: TenantContext, id: Types.ObjectId, input: DispatchPoRequest): Promise<PoView> {
    const po = await poRepository.findById(id);
    assertTenantOwns(po, ctx);
    if (!canTransition(po.state, 'sent')) {
      throw new ConflictError(
        ErrorCodes.PO_INVALID_STATE_TRANSITION,
        `Cannot dispatch PO in state ${po.state}`,
      );
    }
    const pdfUrl = await this.generateAndStorePdf(po);
    const at = new Date();
    const updated = await poRepository.transitionState({
      id,
      fromState: po.state,
      toState: 'sent',
      extraSet: {
        dispatch: { sentAt: at, sentTo: input.sentTo, emailDeliveryId: null },
        pdfUrl: pdfUrl ?? po.pdfUrl,
        pdfGeneratedAt: pdfUrl ? at : po.pdfGeneratedAt,
      },
    });
    if (!updated) {
      throw new ConflictError(ErrorCodes.PO_STATE_RACE, 'PO state changed concurrently');
    }
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.PoDispatched,
      target: { kind: 'po', id },
      payload: { sentTo: input.sentTo, pdfUrl: pdfUrl ?? null },
      requestId: ctx.requestId,
    });
    if (pdfUrl) {
      void notifyPoSentToSupplier({
        po: updated,
        supplierContactName: po.supplierSnapshot.legalName,
        supplierContactEmail: input.sentTo,
        pdfUrl,
      });
    }

    // Schedule delivery-overdue alert: 7 days past expectedDeliveryAt.
    const overdueDelayMs =
      updated.expectedDeliveryAt.getTime() + 7 * 24 * 60 * 60 * 1000 - Date.now();
    if (overdueDelayMs > 0) {
      void enqueueScheduled(
        'scheduled.po.delivery_overdue_check',
        {
          tenantId: updated.tenantId.toString(),
          poId: updated._id.toString(),
        },
        { delay: overdueDelayMs },
      ).catch((err: unknown) => {
        logger.warn(
          { err, event: 'po.dispatch.overdue_schedule_failed', poId: updated._id.toString() },
          'failed to schedule overdue check',
        );
      });
    }
    return toView(updated);
  }

  /**
   * Legacy alias retained so callers using the old `/:id/dispatch` route
   * keep working. New callers should use `sendToSupplier`.
   */
  async dispatch(ctx: TenantContext, id: Types.ObjectId, input: DispatchPoRequest): Promise<PoView> {
    return this.sendToSupplier(ctx, id, input);
  }

  async cancel(ctx: TenantContext, id: Types.ObjectId, input: CancelPoRequest): Promise<PoView> {
    const po = await poRepository.findById(id);
    assertTenantOwns(po, ctx);
    if (!canTransition(po.state, 'cancelled')) {
      throw new ConflictError(
        ErrorCodes.PO_INVALID_STATE_TRANSITION,
        `Cannot cancel PO in state ${po.state}`,
      );
    }
    const at = new Date();
    const updated = await poRepository.transitionState({
      id,
      fromState: po.state,
      toState: 'cancelled',
      extraSet: {
        cancellation: { cancelledAt: at, cancelledBy: ctx.userId, reason: input.reason },
      },
    });
    if (!updated) {
      throw new ConflictError(ErrorCodes.PO_STATE_RACE, 'PO state changed concurrently');
    }
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.PoCancelled,
      target: { kind: 'po', id },
      payload: { reason: input.reason },
      requestId: ctx.requestId,
    });
    return toView(updated);
  }

  async receive(
    ctx: TenantContext,
    id: Types.ObjectId,
    input: ReceivePoRequest,
  ): Promise<{ po: PoView; receipt: PoReceiptView }> {
    const po = await poRepository.findById(id);
    assertTenantOwns(po, ctx);
    if (po.state !== 'sent' && po.state !== 'partially_received') {
      throw new ConflictError(
        ErrorCodes.PO_INVALID_STATE_TRANSITION,
        `Cannot receive against PO in state ${po.state}`,
      );
    }
    const warehouseId = new Types.ObjectId(input.warehouseId);
    const warehouse = await inventoryRepository.findWarehouseById(warehouseId);
    assertTenantOwns(warehouse, ctx);

    // Validate each receipt line corresponds to a real PO line and does
    // not exceed the remaining quantity.
    const perLine: Array<{ poLineId: Types.ObjectId; addQuantity: number }> = [];
    for (const rl of input.lines) {
      const poLine = po.lines.find(
        (l) => (l as unknown as { _id: Types.ObjectId })._id.toString() === rl.poLineId,
      );
      if (!poLine) {
        throw new BadRequestError(ErrorCodes.BAD_REQUEST, `Unknown PO line: ${rl.poLineId}`);
      }
      const remaining = poLine.quantityOrdered - poLine.quantityReceived;
      if (rl.quantity > remaining) {
        throw new BadRequestError(ErrorCodes.BAD_REQUEST, 'Receipt quantity exceeds remaining', {
          poLineId: rl.poLineId,
          remaining,
        });
      }
      perLine.push({
        poLineId: new Types.ObjectId(rl.poLineId),
        addQuantity: rl.quantity,
      });
    }

    const updatedPo = await poRepository.setLineReceived({ id, perLine });
    if (!updatedPo) throw new NotFoundError();

    const fullyReceived = updatedPo.lines.every((l) => l.quantityReceived >= l.quantityOrdered);
    const resultingState: 'partially_received' | 'fully_received' = fullyReceived
      ? 'fully_received'
      : 'partially_received';

    const receipt = await poRepository.createReceipt({
      poId: updatedPo._id,
      poNumber: updatedPo.number,
      receivedAt: new Date(),
      receivedBy: ctx.userId,
      warehouseId,
      lines: input.lines.map((l) => ({
        poLineId: new Types.ObjectId(l.poLineId),
        itemId: new Types.ObjectId(l.itemId),
        quantity: l.quantity,
        unitCost: l.unitCost ?? null,
        qualityNotes: l.qualityNotes ?? null,
      })),
      grnDocumentUrl: input.grnDocumentUrl ?? null,
      resultingState,
      notes: input.notes ?? null,
    });

    // Post stock movements + balance increments. The stockMovements
    // collection is an append-only ledger (SDD §4.2.2); stockBalances is
    // a materialised view reconciled weekly by the balance-audit cron.
    // Per-line movement+balance is therefore not strictly transactional,
    // but every write here is atomic in isolation and audit-reconcilable.
    const affectedItemIds = new Set<string>();
    for (const l of input.lines) {
      const at = new Date();
      const itemId = new Types.ObjectId(l.itemId);
      affectedItemIds.add(itemId.toString());
      await inventoryRepository.createMovement({
        itemId,
        warehouseId,
        type: 'in',
        quantity: l.quantity,
        unitCost: l.unitCost ?? null,
        reasonCode: 'po_receipt',
        reference: {
          kind: resultingState === 'fully_received' ? 'po_receipt' : 'po_receipt_partial',
          id: receipt._id,
        },
        attachmentUrl: input.grnDocumentUrl ?? null,
        performedBy: ctx.userId,
        performedAt: at,
      });
      await inventoryRepository.incrementBalance({
        itemId,
        warehouseId,
        delta: l.quantity,
        movementAt: at,
      });
    }
    // Track which items were touched - applyPostReceiptSideEffects fans
    // out low-stock resolution + forecast re-trigger over this set.
    void affectedItemIds;

    const transitioned = await poRepository.transitionState({
      id,
      fromState: po.state,
      toState: resultingState,
    });
    if (!transitioned) {
      throw new ConflictError(ErrorCodes.PO_STATE_RACE, 'PO state changed concurrently');
    }

    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.PoReceived,
      target: { kind: 'po', id },
      payload: { receiptId: receipt._id.toString(), resultingState },
      requestId: ctx.requestId,
    });

    // Post-receipt fan-out: low-stock alert resolution, forecast
    // re-trigger, and full-receipt confirmation email. All side-effects
    // are best-effort; failures must not roll back the receipt.
    void this.applyPostReceiptSideEffects({
      ctx,
      po: transitioned,
      warehouseId,
      receivedQuantity: input.lines.reduce((sum, l) => sum + l.quantity, 0),
      isFullyReceived: resultingState === 'fully_received',
      receivedItemIds: input.lines.map((l) => new Types.ObjectId(l.itemId)),
    });

    return { po: toView(transitioned), receipt: toReceiptView(receipt) };
  }

  /**
   * Best-effort post-receipt side-effects. Each block is independently
   * try/catched - a failure in one (e.g. forecast queue down) must not
   * stop the others (e.g. low-stock alert clear).
   */
  private async applyPostReceiptSideEffects(args: {
    ctx: TenantContext;
    po: PurchaseOrderDoc;
    warehouseId: Types.ObjectId;
    receivedQuantity: number;
    isFullyReceived: boolean;
    receivedItemIds: Types.ObjectId[];
  }): Promise<void> {
    // (a) Resolve any active low-stock alerts on the items just received.
    for (const itemId of args.receivedItemIds) {
      try {
        const item = await inventoryRepository.findItemById(itemId);
        if (!item) continue;
        await inventoryRepository.clearLowStockIfResolved({
          itemId,
          warehouseId: args.warehouseId,
          reorderLevel: item.reorderLevel,
        });
      } catch (err) {
        logger.warn(
          { err, event: 'po.receipt.low_stock_clear_failed', itemId: itemId.toString() },
          'low-stock alert clear failed',
        );
      }
    }

    // (b) Re-trigger demand forecasts for the affected items so that
    // the next dashboard view reflects the fresh stock baseline.
    for (const itemId of args.receivedItemIds) {
      try {
        // Skip if a recent forecast exists - the AI service has its own
        // 6h rate-limit; this is just a coarse pre-flight to avoid
        // queue spam during a 200-line GRN.
        const recent = await aiRepository.findLatestForItem({
          tenantId: args.ctx.tenantId,
          itemId,
          horizonDays: 30,
        });
        const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
        if (recent && recent.generatedAt.getTime() > sixHoursAgo) continue;

        await enqueueForecast('forecast.single_item', {
          tenantId: args.ctx.tenantId.toString(),
          itemId: itemId.toString(),
          requestedBy: args.ctx.userId.toString(),
        });
      } catch (err) {
        logger.warn(
          { err, event: 'po.receipt.forecast_retrigger_failed', itemId: itemId.toString() },
          'forecast re-trigger failed',
        );
      }
    }

    // (c) Send the full-receipt confirmation email when this receipt
    // closed out the PO.
    if (args.isFullyReceived) {
      void notifyPoFullyReceived({ po: args.po, receivedQuantity: args.receivedQuantity });
    }
  }

  async listReceipts(ctx: TenantContext, id: Types.ObjectId): Promise<PoReceiptView[]> {
    const po = await poRepository.findById(id);
    assertTenantOwns(po, ctx);
    const receipts = await poRepository.listReceipts(id);
    return receipts.map(toReceiptView);
  }

  async close(ctx: TenantContext, id: Types.ObjectId): Promise<PoView> {
    const po = await poRepository.findById(id);
    assertTenantOwns(po, ctx);
    if (!canTransition(po.state, 'closed')) {
      throw new ConflictError(
        ErrorCodes.PO_INVALID_STATE_TRANSITION,
        `Cannot close PO in state ${po.state}`,
      );
    }
    const updated = await poRepository.transitionState({
      id,
      fromState: po.state,
      toState: 'closed',
      extraSet: { closedAt: new Date() },
    });
    if (!updated) {
      throw new ConflictError(ErrorCodes.PO_STATE_RACE, 'PO state changed concurrently');
    }
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.PoClosed,
      target: { kind: 'po', id },
      requestId: ctx.requestId,
    });
    return toView(updated);
  }

  /**
   * Build a draft PO from an AI forecast suggestion. Pulls the latest
   * forecast for the item, sizes the order at the 30-day predicted
   * quantity (preferring the override when present), and stages it in
   * the user's preferred warehouse.
   */
  async createFromForecast(args: {
    ctx: TenantContext;
    itemId: Types.ObjectId;
    warehouseId: Types.ObjectId;
    expectedDeliveryAt?: string;
  }): Promise<PoView> {
    const item = await inventoryRepository.findItemById(args.itemId);
    assertTenantOwns(item, args.ctx);
    if (!item.preferredSupplierId) {
      throw new BadRequestError(
        ErrorCodes.BAD_REQUEST,
        'Item has no preferred supplier; pick a supplier manually',
      );
    }
    const forecast = await aiRepository.findLatestForItem({
      tenantId: args.ctx.tenantId,
      itemId: args.itemId,
      horizonDays: 30,
    });
    if (!forecast) {
      throw new NotFoundError();
    }
    const suggested = forecast.override?.quantity ?? forecast.predictedQuantity;
    if (suggested <= 0) {
      throw new BadRequestError(
        ErrorCodes.BAD_REQUEST,
        'Forecast predicts zero demand; no PO needed',
      );
    }
    // Order quantity = forecasted demand minus current on-hand stock,
    // bounded at the suggested quantity. The user can edit before
    // submitting.
    const balance = await inventoryRepository.findBalance(args.itemId, args.warehouseId);
    const onHand = balance?.quantity ?? 0;
    const quantity = Math.max(1, Math.round(suggested - onHand));
    const supplier = await supplierRepository.findById(item.preferredSupplierId);
    assertTenantOwns(supplier, args.ctx);
    const leadTimeDays = supplier.leadTimeDays ?? 14;
    const expected = args.expectedDeliveryAt
      ? new Date(args.expectedDeliveryAt)
      : new Date(Date.now() + leadTimeDays * 24 * 60 * 60 * 1000);
    return this.create(args.ctx, {
      supplierId: supplier._id.toString(),
      warehouseId: args.warehouseId.toString(),
      currency: item.currency,
      paymentTermsDays: supplier.paymentTermsDays,
      expectedDeliveryAt: expected.toISOString(),
      lines: [
        {
          itemId: args.itemId.toString(),
          quantityOrdered: quantity,
          unitPrice: item.movingAverageCost,
          expectedDeliveryAt: expected.toISOString(),
          remarks: `Auto-generated from forecast ${forecast._id.toString()} (predicted ${suggested}, on-hand ${onHand})`,
        },
      ],
      taxRate: 0,
    });
  }

  /**
   * Render the PO PDF and upload it to R2. Returns the presigned URL
   * (or null if rendering/upload failed). Best-effort: never throws.
   */
  private async generateAndStorePdf(po: PurchaseOrderDoc): Promise<string | null> {
    try {
      const factory = await Factory.findById(po.tenantId).lean().exec();
      if (!factory) return null;
      const pdfBuffer = await renderPoPdf({
        factory: {
          name: factory.name,
          addressLine: 'Bangladesh', // SDD §2.6 - factories are BD-based
          baseCurrency: factory.baseCurrency,
          primaryColor: factory.branding?.primaryColor ?? '#1E40AF',
        },
        po,
        isDraftWatermark: po.state === 'draft',
      });
      const key = tenantKey(po.tenantId.toString(), 'po-pdf', `${po.number}.pdf`);
      const upload = await uploadObject({
        key,
        body: pdfBuffer,
        contentType: 'application/pdf',
        metadata: { poId: po._id.toString(), poNumber: po.number },
      });
      // Persist the storage key so subsequent reads can re-presign cheaply.
      await poRepository.update(po._id, {
        pdfUrl: upload.url,
        pdfGeneratedAt: new Date(),
      });
      return upload.url;
    } catch (err) {
      logger.warn(
        { err, event: 'po.pdf.generation_failed', poId: po._id.toString() },
        'PO PDF generation/upload failed',
      );
      return null;
    }
  }

  /**
   * Re-presign an existing PDF storage key for download. Useful when
   * the original 5-minute URL has expired - the persisted URL on the
   * PO row is the storage key, and this presigns a fresh download.
   */
  async getPdfDownloadUrl(ctx: TenantContext, id: Types.ObjectId): Promise<{ url: string | null }> {
    const po = await poRepository.findById(id);
    assertTenantOwns(po, ctx);
    if (!po.pdfUrl) {
      // No PDF yet - render now.
      const url = await this.generateAndStorePdf(po);
      return { url };
    }
    // The persisted URL is presigned and may be stale; re-derive the
    // storage key and presign again. We accept a stub URL passthrough
    // for dev environments.
    if (po.pdfUrl.startsWith('stub://')) {
      return { url: po.pdfUrl };
    }
    const key = tenantKey(po.tenantId.toString(), 'po-pdf', `${po.number}.pdf`);
    return { url: await presignGet(key) };
  }
}

export const poService = new PoService();
