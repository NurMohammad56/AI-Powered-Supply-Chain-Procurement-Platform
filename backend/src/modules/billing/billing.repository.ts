import type { FilterQuery, Types } from 'mongoose';

import { decodeCursor, paginate, type Page } from '../../shared/utils/pagination.js';
import { Subscription, type SubscriptionDoc } from './models/subscription.model.js';
import { Invoice, type InvoiceDoc } from './models/invoice.model.js';

export class BillingRepository {
  async findSubscriptionForTenant(tenantId: Types.ObjectId): Promise<SubscriptionDoc | null> {
    return Subscription.findOne({ tenantId }).lean<SubscriptionDoc>().exec();
  }

  async findSubscriptionByGatewayId(id: string): Promise<SubscriptionDoc | null> {
    return Subscription.findOne({ gatewaySubscriptionId: id }).lean<SubscriptionDoc>().exec();
  }

  async upsertSubscription(
    tenantId: Types.ObjectId,
    patch: Partial<SubscriptionDoc>,
  ): Promise<SubscriptionDoc | null> {
    return Subscription.findOneAndUpdate(
      { tenantId },
      { $set: patch },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    )
      .lean<SubscriptionDoc>()
      .exec();
  }

  async listInvoices(args: {
    cursor?: string;
    limit: number;
    status?: string;
  }): Promise<Page<InvoiceDoc>> {
    const filter: FilterQuery<InvoiceDoc> = {};
    if (args.status) filter.status = args.status;
    const after = decodeCursor(args.cursor);
    if (after) filter._id = { $gt: after };
    const rows = await Invoice.find(filter)
      .sort({ _id: 1 })
      .limit(args.limit + 1)
      .lean<InvoiceDoc[]>()
      .exec();
    return paginate(rows, args.limit);
  }

  async findInvoiceByGatewayId(id: string): Promise<InvoiceDoc | null> {
    return Invoice.findOne({ gatewayInvoiceId: id }).lean<InvoiceDoc>().exec();
  }

  async upsertInvoiceByGatewayId(
    gatewayInvoiceId: string,
    patch: Partial<InvoiceDoc>,
  ): Promise<InvoiceDoc | null> {
    return Invoice.findOneAndUpdate(
      { gatewayInvoiceId },
      { $set: patch },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    )
      .lean<InvoiceDoc>()
      .exec();
  }
}

export const billingRepository = new BillingRepository();
