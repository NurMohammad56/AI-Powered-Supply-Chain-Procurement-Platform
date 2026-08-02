import { z } from 'zod';

export const UploadFileRequestSchema = z.object({
  kind: z.enum(['pdf', 'image', 'csv', 'spreadsheet', 'document']),
  folder: z.string().min(1).max(80).optional(),
});

export type UploadFileRequest = z.infer<typeof UploadFileRequestSchema>;

export interface UploadFileView {
  key: string;
  url: string;
  uploaded: boolean;
  filename: string;
  size: number;
  contentType: string;
  kind: string;
}
