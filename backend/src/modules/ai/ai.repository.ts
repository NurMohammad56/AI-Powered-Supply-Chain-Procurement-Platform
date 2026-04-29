import type { FilterQuery, Types } from 'mongoose';

import { decodeCursor, paginate, type Page } from '../../shared/utils/pagination.js';
import { Forecast, type ForecastDoc } from './models/forecast.model.js';

export class AiRepository {
  async findById(id: Types.ObjectId | string): Promise<ForecastDoc | null> {
    return Forecast.findById(id).lean<ForecastDoc>().exec();
  }

  async list(args: {
    cursor?: string;
    limit: number;
    itemId?: string;
    horizonDays?: number;
  }): Promise<Page<ForecastDoc>> {
    const filter: FilterQuery<ForecastDoc> = {};
    if (args.itemId) filter.itemId = args.itemId;
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
