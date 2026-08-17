import type { FilterQuery, Types } from 'mongoose';

import { tenantStorage } from '../../shared/db/tenancyPlugin.js';
import { decodeCursor, paginate, type Page } from '../../shared/utils/pagination.js';
import { PaymentAttempt, type PaymentAttemptDoc } from './models/paymentAttempt.model.js';
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

  async findInvoiceByGatewayIdGlobal(
    id: string,
  ): Promise<Pick<InvoiceDoc, '_id' | 'tenantId' | 'subscriptionId' | 'amountTotal' | 'currency' | 'status' | 'gatewayInvoiceId' | 'gatewayPaymentIntentId'> | null> {
    const raw = await Invoice.collection.findOne(
      { gatewayInvoiceId: id },
      {
        projection: {
          _id: 1,
          tenantId: 1,
          subscriptionId: 1,
          amountTotal: 1,
          currency: 1,
          status: 1,
          gatewayInvoiceId: 1,
          gatewayPaymentIntentId: 1,
        },
      },
    );
    if (!raw) return null;
    return {
      _id: raw._id as InvoiceDoc['_id'],
      tenantId: raw.tenantId as InvoiceDoc['tenantId'],
      subscriptionId: raw.subscriptionId as InvoiceDoc['subscriptionId'],
      amountTotal: raw.amountTotal as InvoiceDoc['amountTotal'],
      currency: raw.currency as InvoiceDoc['currency'],
      status: raw.status as InvoiceDoc['status'],
      gatewayInvoiceId: raw.gatewayInvoiceId as InvoiceDoc['gatewayInvoiceId'],
      gatewayPaymentIntentId: raw.gatewayPaymentIntentId as InvoiceDoc['gatewayPaymentIntentId'],
    };
  }

  async upsertInvoiceByGatewayId(
    gatewayInvoiceId: string,
    patch: Partial<InvoiceDoc>,
  ): Promise<InvoiceDoc | null> {
    return Invoice.findOneAndUpdate(
      { gatewayInvoiceId },
      { $set: patch, $setOnInsert: { gatewayInvoiceId } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    )
      .lean<InvoiceDoc>()
      .exec();
  }

  async upsertPaymentAttemptByGatewayId(
    gatewayPaymentIntentId: string,
    patch: Partial<PaymentAttemptDoc>,
  ): Promise<PaymentAttemptDoc | null> {
    return PaymentAttempt.findOneAndUpdate(
      { gatewayPaymentIntentId },
      { $set: patch, $setOnInsert: { gatewayPaymentIntentId } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    )
      .lean<PaymentAttemptDoc>()
      .exec();
  }

  async findPaymentAttemptByGatewayId(
    gatewayPaymentIntentId: string,
  ): Promise<PaymentAttemptDoc | null> {
    return PaymentAttempt.findOne({ gatewayPaymentIntentId }).lean<PaymentAttemptDoc>().exec();
  }

  withScope<T>(tenantId: Types.ObjectId, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      tenantStorage.run({ tenantId }, () => {
        fn().then(resolve, reject);
      });
    });
  }
}

export const billingRepository = new BillingRepository();
