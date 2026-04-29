import { z } from 'zod';

export const ReportRangeQuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});
export type ReportRangeQuery = z.infer<typeof ReportRangeQuerySchema>;
