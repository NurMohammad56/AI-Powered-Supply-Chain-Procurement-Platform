import { Types, type FilterQuery } from 'mongoose';

import { decodeCursor, paginate, type Page } from '../../shared/utils/pagination.js';
import { Forecast, type ForecastDoc } from './models/forecast.model.js';

export class AiRepository {
  async findById(id: Types.ObjectId | string): Promise<ForecastDoc | null> {
    return Forecast.findById(id).lean<ForecastDoc>().exec();
  }

  async findLatestForItem(args: {
    tenantId: Types.ObjectId;
    itemId: Types.ObjectId;
    horizonDays: number;
  }): Promise<ForecastDoc | null> {
    return Forecast.findOne({
      tenantId: args.tenantId,
      itemId: args.itemId,
      horizonDays: args.horizonDays,
    })
      .sort({ generatedAt: -1 })
      .lean<ForecastDoc>()
      .exec();
  }

  async create(input: Partial<ForecastDoc>): Promise<ForecastDoc> {
    const doc = await Forecast.create(input);
    return doc.toObject();
  }

  async list(args: {
    cursor?: string;
    limit: number;
    itemId?: string;
    horizonDays?: number;
  }): Promise<Page<ForecastDoc>> {
    const filter: FilterQuery<ForecastDoc> = {};
    if (args.itemId) filter.itemId = new Types.ObjectId(args.itemId);
    if (args.horizonDays) filter.horizonDays = args.horizonDays;
    const after = decodeCursor(args.cursor);
    if (after) filter._id = { $gt: after };
    const rows = await Forecast.find(filter)
      .sort({ _id: 1 })
      .limit(args.limit + 1)
      .lean<ForecastDoc[]>()
      .exec();
    return paginate(rows, args.limit);
  }

  async setOverride(args: {
    id: Types.ObjectId;
    by: Types.ObjectId;
    quantity: number;
    justification: string;
  }): Promise<ForecastDoc | null> {
    return Forecast.findByIdAndUpdate(
      args.id,
      {
        $set: {
          override: {
            by: args.by,
            at: new Date(),
            quantity: args.quantity,
            justification: args.justification,
          },
        },
      },
      { new: true, runValidators: true },
    )
      .lean<ForecastDoc>()
      .exec();
  }
}

export const aiRepository = new AiRepository();
