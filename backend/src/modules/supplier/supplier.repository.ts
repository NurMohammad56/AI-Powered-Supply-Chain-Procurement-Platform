import { Types, type FilterQuery } from 'mongoose';

import { decodeCursor, paginate, type Page } from '../../shared/utils/pagination.js';
import { Supplier, type SupplierDoc } from './models/supplier.model.js';

export class SupplierRepository {
  async findById(id: Types.ObjectId | string): Promise<SupplierDoc | null> {
    return Supplier.findById(id).lean<SupplierDoc>().exec();
  }

  async findByTaxId(taxId: string): Promise<SupplierDoc | null> {
    return Supplier.findOne({ taxId }).lean<SupplierDoc>().exec();
  }

  async findManyByIds(ids: Types.ObjectId[]): Promise<SupplierDoc[]> {
    return Supplier.find({ _id: { $in: ids } }).lean<SupplierDoc[]>().exec();
  }

  async create(input: Partial<SupplierDoc>): Promise<SupplierDoc> {
    const doc = await Supplier.create(input);
    return doc.toObject();
  }

  async update(id: Types.ObjectId, patch: Partial<SupplierDoc>): Promise<SupplierDoc | null> {
    return Supplier.findByIdAndUpdate(id, patch, { new: true, runValidators: true })
      .lean<SupplierDoc>()
      .exec();
  }

  async archive(id: Types.ObjectId): Promise<boolean> {
    const result = await Supplier.updateOne({ _id: id }, { $set: { archivedAt: new Date() } }).exec();
    return (result.modifiedCount ?? 0) > 0;
  }

  async list(args: {
    cursor?: string;
    limit: number;
    q?: string;
    status?: string;
    tier?: string;
    categoryId?: string;
  }): Promise<Page<SupplierDoc>> {
    const filter: FilterQuery<SupplierDoc> = {};
    if (args.status) filter.status = args.status;
    if (args.tier) filter.tier = args.tier;
    if (args.categoryId) filter.categoryIds = new Types.ObjectId(args.categoryId);
    if (args.q) {
      const escaped = args.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { legalName: new RegExp(escaped, 'i') },
        { tradingName: new RegExp(escaped, 'i') },
      ];
    }
    const after = decodeCursor(args.cursor);
    if (after) filter._id = { $gt: after };
    const rows = await Supplier.find(filter)
      .sort({ _id: 1 })
      .limit(args.limit + 1)
      .lean<SupplierDoc[]>()
      .exec();
    return paginate(rows, args.limit);
  }

  async pushContact(id: Types.ObjectId, contact: SupplierDoc['contacts'][number]): Promise<SupplierDoc | null> {
    return Supplier.findByIdAndUpdate(
      id,
      { $push: { contacts: contact } },
      { new: true, runValidators: true },
    )
      .lean<SupplierDoc>()
      .exec();
  }

  async setContactAt(
    id: Types.ObjectId,
    index: number,
    contact: SupplierDoc['contacts'][number],
  ): Promise<SupplierDoc | null> {
    return Supplier.findByIdAndUpdate(
      id,
      { $set: { [`contacts.${index}`]: contact } },
      { new: true, runValidators: true },
    )
      .lean<SupplierDoc>()
      .exec();
  }

  async unsetContactAt(id: Types.ObjectId, index: number): Promise<SupplierDoc | null> {
    await Supplier.findByIdAndUpdate(id, { $unset: { [`contacts.${index}`]: 1 } }).exec();
    return Supplier.findByIdAndUpdate(id, { $pull: { contacts: null } }, { new: true })
      .lean<SupplierDoc>()
      .exec();
  }

  async pushDocument(
    id: Types.ObjectId,
    doc: SupplierDoc['documentUrls'][number],
  ): Promise<SupplierDoc | null> {
    return Supplier.findByIdAndUpdate(
      id,
      { $push: { documentUrls: doc } },
      { new: true, runValidators: true },
    )
      .lean<SupplierDoc>()
      .exec();
  }

  async unsetDocumentAt(id: Types.ObjectId, index: number): Promise<SupplierDoc | null> {
    await Supplier.findByIdAndUpdate(id, { $unset: { [`documentUrls.${index}`]: 1 } }).exec();
    return Supplier.findByIdAndUpdate(id, { $pull: { documentUrls: null } }, { new: true })
      .lean<SupplierDoc>()
      .exec();
  }
}

export const supplierRepository = new SupplierRepository();
