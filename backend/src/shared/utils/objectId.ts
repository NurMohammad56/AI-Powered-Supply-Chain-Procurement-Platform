import { Types } from 'mongoose';
import { z } from 'zod';

export const objectIdSchema = z
  .string()
  .refine((v) => Types.ObjectId.isValid(v), { message: 'Invalid ObjectId' })
  .transform((v) => new Types.ObjectId(v));

export const objectIdStringSchema = z
  .string()
  .refine((v) => Types.ObjectId.isValid(v), { message: 'Invalid ObjectId' });

export function toObjectId(id: string | Types.ObjectId): Types.ObjectId {
  return typeof id === 'string' ? new Types.ObjectId(id) : id;
}

export function isObjectId(value: unknown): value is Types.ObjectId {
  return value instanceof Types.ObjectId;
}
