import { Schema, Types, model, type HydratedDocument } from 'mongoose';

export type FactoryStatus = 'trial' | 'active' | 'past_due' | 'suspended' | 'cancelled';
export type BusinessType = 'rmg' | 'textile' | 'leather' | 'light_manufacturing' | 'other';

export interface FactoryDoc {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  businessType: BusinessType;
  country: 'BD';
  timeZone: string;
  baseCurrency: 'BDT' | 'USD';
  branding: {
    logoUrl: string | null;
    primaryColor: string;
  };
  ownerUserId: Types.ObjectId | null;
  status: FactoryStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type FactoryHydrated = HydratedDocument<FactoryDoc>;

const factorySchema = new Schema<FactoryDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    slug: { type: String, required: true, lowercase: true, trim: true, unique: true },
    businessType: {
      type: String,
      enum: ['rmg', 'textile', 'leather', 'light_manufacturing', 'other'],
      required: true,
    },
    country: { type: String, enum: ['BD'], default: 'BD' },
    timeZone: { type: String, default: 'Asia/Dhaka' },
    baseCurrency: { type: String, enum: ['BDT', 'USD'], default: 'BDT' },
    branding: {
      logoUrl: { type: String, default: null },
      primaryColor: { type: String, default: '#1E40AF' },
    },
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    status: {
      type: String,
      enum: ['trial', 'active', 'past_due', 'suspended', 'cancelled'],
      default: 'trial',
      index: true,
    },
  },
  { timestamps: true },
);

factorySchema.index({ slug: 1 }, { unique: true });

// `factories` is the tenant ROOT - it is intentionally NOT tenant-scoped.
// We do not register the tenancy plugin on this collection (SDD §2.6).

export const Factory = model<FactoryDoc>('Factory', factorySchema);
