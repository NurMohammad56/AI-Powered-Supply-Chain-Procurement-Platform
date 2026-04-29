import type { FilterQuery, Types } from 'mongoose';

import { decodeCursor, paginate, type Page } from '../../shared/utils/pagination.js';
import { QuotationRequest, type QuotationRequestDoc } from './models/quotationRequest.model.js';

export class QuotationRepository {
  async findById(id: Types.ObjectId | string): Promise<QuotationRequestDoc | null> {
    return QuotationRequest.findById(id).lean<QuotationRequestDoc>().exec();
  }

  async findByToken(token: string): Promise<QuotationRequestDoc | null> {
    return QuotationRequest.findOne({ 'supplierInvitations.responseToken': token })
      .lean<QuotationRequestDoc>()
      .exec();
  }

  async create(input: Partial<QuotationRequestDoc>): Promise<QuotationRequestDoc> {
    const doc = await QuotationRequest.create(input);
    return doc.toObject();
  }

  async list(args: {
    cursor?: string;
    limit: number;
    status?: string;
  }): Promise<Page<QuotationRequestDoc>> {
    const filter: FilterQuery<QuotationRequestDoc> = {};
    if (args.status) filter.status = args.status;
    const after = decodeCursor(args.cursor);
    if (after) filter._id = { $gt: after };
    const rows = await QuotationRequest.find(filter)
      .sort({ _id: 1 })
      .limit(args.limit + 1)
      .lean<QuotationRequestDoc[]>()
      .exec();
    return paginate(rows, args.limit);
  }

  async setInvitationResponse(args: {
    id: Types.ObjectId;
    token: string;
    response: NonNullable<QuotationRequestDoc['supplierInvitations'][number]['response']>;
  }): Promise<QuotationRequestDoc | null> {
    return QuotationRequest.findOneAndUpdate(
      { _id: args.id, 'supplierInvitations.responseToken': args.token },
      {
        $set: {
          'supplierInvitations.$.response': args.response,
        },
      },
      { new: true, runValidators: true },
    )
      .lean<QuotationRequestDoc>()
      .exec();
  }

  async accept(args: {
    id: Types.ObjectId;
    supplierId: Types.ObjectId;
    acceptedAt: Date;
  }): Promise<QuotationRequestDoc | null> {
    return QuotationRequest.findOneAndUpdate(
      { _id: args.id, status: 'open', acceptedSupplierId: null },
      {
        $set: {
          acceptedSupplierId: args.supplierId,
          acceptedAt: args.acceptedAt,
          status: 'closed',
        },
      },
      { new: true, runValidators: true },
    )
      .lean<QuotationRequestDoc>()
      .exec();
  }

  async cancel(id: Types.ObjectId): Promise<QuotationRequestDoc | null> {
    return QuotationRequest.findOneAndUpdate(
      { _id: id, status: 'open' },
      { $set: { status: 'cancelled' } },
      { new: true, runValidators: true },
    )
      .lean<QuotationRequestDoc>()
      .exec();
  }

  async countForTenant(): Promise<number> {
    return QuotationRequest.countDocuments({}).exec();
  }
}

export const quotationRepository = new QuotationRepository();
