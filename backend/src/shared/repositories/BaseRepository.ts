import {
  Types,
  type FilterQuery,
  type Model,
  type ProjectionType,
  type QueryOptions,
  type RootFilterQuery,
  type UpdateQuery,
} from 'mongoose';

import { paginate, type Cursor, type Page } from '../utils/pagination.js';

/**
 * Generic Mongoose repository. Modules subclass this for the standard CRUD
 * surface, then add domain-specific reads/writes alongside.
 *
 * The tenancy plugin transparently scopes every operation to the active
 * AsyncLocalStorage tenant - this class never adds factoryId itself.
 *
 * Conventions (SDD §3.4):
 *   - .lean() on every read path (no Mongoose hydration)
 *   - cursor pagination only (sort by `_id` ascending)
 *   - returns plain objects, never Mongoose documents
 */
export abstract class BaseRepository<TDoc extends { _id: Types.ObjectId }> {
  constructor(protected readonly model: Model<TDoc>) {}

  async findById(id: Types.ObjectId | string, projection?: ProjectionType<TDoc>): Promise<TDoc | null> {
    return this.model
      .findById(id, projection)
      .lean<TDoc>()
      .exec();
  }

  async findOne(
    filter: FilterQuery<TDoc>,
    projection?: ProjectionType<TDoc>,
  ): Promise<TDoc | null> {
    return this.model.findOne(filter, projection).lean<TDoc>().exec();
  }

  async exists(filter: FilterQuery<TDoc>): Promise<boolean> {
    const result = await this.model.exists(filter).exec();
    return result !== null;
  }

  async count(filter: FilterQuery<TDoc> = {}): Promise<number> {
    return this.model.countDocuments(filter).exec();
  }

  async list(
    filter: FilterQuery<TDoc>,
    cursor: Cursor,
    sort: Record<string, 1 | -1> = { _id: 1 },
  ): Promise<Page<TDoc>> {
    const fullFilter: FilterQuery<TDoc> = cursor.after
      ? ({ ...filter, _id: { $gt: cursor.after } } as FilterQuery<TDoc>)
      : filter;
    const rows = await this.model
      .find(fullFilter)
      .sort(sort)
      .limit(cursor.limit + 1)
      .lean<TDoc[]>()
      .exec();
    return paginate(rows, cursor.limit);
  }

  async create<TInput extends Partial<TDoc>>(input: TInput): Promise<TDoc> {
    const doc = await this.model.create(input);
    return doc.toObject() as TDoc;
  }

  async updateById(
    id: Types.ObjectId | string,
    patch: UpdateQuery<TDoc>,
    options: QueryOptions = {},
  ): Promise<TDoc | null> {
    return this.model
      .findByIdAndUpdate(id, patch, { new: true, runValidators: true, ...options })
      .lean<TDoc>()
      .exec();
  }

  async updateOne(
    filter: FilterQuery<TDoc>,
    patch: UpdateQuery<TDoc>,
    options: QueryOptions = {},
  ): Promise<TDoc | null> {
    return this.model
      .findOneAndUpdate(filter, patch, { new: true, runValidators: true, ...options })
      .lean<TDoc>()
      .exec();
  }

  async deleteById(id: Types.ObjectId | string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id } as RootFilterQuery<TDoc>).exec();
    return (result.deletedCount ?? 0) > 0;
  }

  async softDeleteById(id: Types.ObjectId | string): Promise<boolean> {
    const result = await this.model
      .updateOne({ _id: id } as RootFilterQuery<TDoc>, {
        $set: { archivedAt: new Date() },
      } as unknown as UpdateQuery<TDoc>)
      .exec();
    return (result.modifiedCount ?? 0) > 0;
  }
}
