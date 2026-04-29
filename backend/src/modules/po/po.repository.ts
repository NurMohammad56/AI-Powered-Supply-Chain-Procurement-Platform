import { Types, type FilterQuery } from 'mongoose';

import { decodeCursor, paginate, type Page } from '../../shared/utils/pagination.js';
import { PurchaseOrder, type PurchaseOrderDoc } from './models/purchaseOrder.model.js';
import { PoReceipt, type PoReceiptDoc } from './models/poReceipt.model.js';

export class PoRepository {
  async findById(id: Types.ObjectId | string): Promise<PurchaseOrderDoc | null> {
    return PurchaseOrder.findById(id).lean<PurchaseOrderDoc>().exec();
  }

  async create(input: Partial<PurchaseOrderDoc>): Promise<PurchaseOrderDoc> {
    const doc = await PurchaseOrder.create(input);
    return doc.toObject();
  }

  async update(id: Types.ObjectId, patch: Partial<PurchaseOrderDoc>): Promise<PurchaseOrderDoc | null> {
    return PurchaseOrder.findByIdAndUpdate(id, patch, { new: true, runValidators: true })
      .lean<PurchaseOrderDoc>()
      .exec();
  }

  /**
   * Compare-and-swap state transition: only succeeds when the document is
   * still in the expected `fromState`. Used to enforce the PO state
   * machine under concurrent writers.
   */
  async transitionState(args: {
    id: Types.ObjectId;
    fromState: string;
    toState: string;
    extraSet?: Record<string, unknown>;
  }): Promise<PurchaseOrderDoc | null> {
    const update: Record<string, unknown> = { state: args.toState, ...(args.extraSet ?? {}) };
    return PurchaseOrder.findOneAndUpdate(
      { _id: args.id, state: args.fromState },
      { $set: update },
      { new: true, runValidators: true },
    )
      .lean<PurchaseOrderDoc>()
      .exec();
  }

  async list(args: {
    cursor?: string;
    limit: number;
    state?: string;
    supplierId?: string;
    from?: Date;
    to?: Date;
    q?: string;
  }): Promise<Page<PurchaseOrderDoc>> {
    const filter: FilterQuery<PurchaseOrderDoc> = {};
    if (args.state) filter.state = args.state;
    if (args.supplierId) filter.supplierId = new Types.ObjectId(args.supplierId);
    if (args.from || args.to) {
      filter.createdAt = {};
      if (args.from) (filter.createdAt as Record<string, Date>).$gte = args.from;
      if (args.to) (filter.createdAt as Record<string, Date>).$lte = args.to;
    }
    if (args.q) {
      const escaped = args.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.number = new RegExp(escaped, 'i');
    }
    const after = decodeCursor(args.cursor);
    if (after) filter._id = { $gt: after };
    const rows = await PurchaseOrder.find(filter)
      .sort({ _id: 1 })
      .limit(args.limit + 1)
      .lean<PurchaseOrderDoc[]>()
      .exec();
    return paginate(rows, args.limit);
  }

  async setLineReceived(args: {
    id: Types.ObjectId;
    perLine: Array<{ poLineId: Types.ObjectId; addQuantity: number }>;
  }): Promise<PurchaseOrderDoc | null> {
    const doc = await PurchaseOrder.findById(args.id).exec();
    if (!doc) return null;
    for (const upd of args.perLine) {
      const line = doc.lines.find((l) => (l as unknown as { _id: Types.ObjectId })._id.toString() === upd.poLineId.toString());
      if (line) line.quantityReceived += upd.addQuantity;
    }
    await doc.save();
    return doc.toObject();
  }

  async createReceipt(input: Partial<PoReceiptDoc>): Promise<PoReceiptDoc> {
    const doc = await PoReceipt.create(input);
    return doc.toObject();
  }

  async listReceipts(poId: Types.ObjectId): Promise<PoReceiptDoc[]> {
    return PoReceipt.find({ poId }).sort({ receivedAt: -1 }).lean<PoReceiptDoc[]>().exec();
  }
}

export const poRepository = new PoRepository();
