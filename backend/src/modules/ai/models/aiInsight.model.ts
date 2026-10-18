import { Schema, model, type Types } from 'mongoose';
import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';

interface AiInsightDoc {
  tenantId: Types.ObjectId;
  kind: 'quotation_comparison' | 'procurement_brief';
  referenceId: Types.ObjectId | null;
  prompt: string;
  response: string;
  provenance: {
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    failoverInvoked: boolean;
  };
  createdAt: Date;
}
const schema = new Schema<AiInsightDoc>(
  {
    kind: { type: String, enum: ['quotation_comparison', 'procurement_brief'], required: true },
    referenceId: { type: Schema.Types.ObjectId, default: null },
    prompt: { type: String, required: true, maxlength: 64000, select: false },
    response: { type: String, required: true, maxlength: 64000 },
    provenance: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);
schema.index({ tenantId: 1, kind: 1, createdAt: -1 });
schema.plugin(tenancyPlugin);
export const AiInsight = model<AiInsightDoc>('AiInsight', schema);
