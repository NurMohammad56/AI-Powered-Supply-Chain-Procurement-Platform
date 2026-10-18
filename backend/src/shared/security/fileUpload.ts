import path from 'node:path';
import { z } from 'zod';

import { logger } from '../../config/logger.js';

/**
 * File upload validation utilities. Used at every entry point that
 * accepts user-controlled bytes (supplier docs, GRN attachments, CSV
 * import). Order of checks (cheapest first):
 *
 *   1. Filename sanitisation + path-traversal guard
 *   2. Size limit (cheap, in-memory)
 *   3. Declared MIME against an allowlist
 *   4. Content-sniff signature against the declared MIME
 *   5. Optional virus-scan hook (no-op in dev; real scanner in prod)
 *
 * Each step throws a typed error so the request handler can map it to a
 * 4xx with a stable code. The validator never silently strips data.
 */

export type FileKind = 'pdf' | 'image' | 'csv' | 'spreadsheet' | 'document';

interface AllowEntry {
  kind: FileKind;
  /** Declared MIME values that are acceptable for this kind. */
  mimes: ReadonlyArray<string>;
  /** Magic-byte signatures (any match passes). */
  magic: ReadonlyArray<{ offset: number; bytes: Buffer }>;
  /** Hard upper bound for this kind. Tighter than the global cap. */
  maxBytes: number;
  /** Allowed lower-cased extensions. */
  extensions: ReadonlyArray<string>;
}

const ALLOW_LIST: ReadonlyArray<AllowEntry> = [
  {
    kind: 'pdf',
    mimes: ['application/pdf'],
    magic: [{ offset: 0, bytes: Buffer.from('%PDF-', 'utf8') }],
    maxBytes: 20 * 1024 * 1024,
    extensions: ['.pdf'],
  },
  {
    kind: 'image',
    mimes: ['image/png', 'image/jpeg', 'image/webp'],
    magic: [
      { offset: 0, bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }, // PNG
      { offset: 0, bytes: Buffer.from([0xff, 0xd8, 0xff]) }, // JPEG
      { offset: 0, bytes: Buffer.from('RIFF', 'utf8') }, // WebP (RIFF...WEBP)
    ],
    maxBytes: 10 * 1024 * 1024,
    extensions: ['.png', '.jpg', '.jpeg', '.webp'],
  },
  {
    kind: 'csv',
    mimes: ['text/csv', 'application/csv', 'text/plain'],
    // CSV has no reliable magic; we rely on extension + size + downstream
    // parser. A separate `parseCsvSafe` guard rejects non-printable bytes.
    magic: [],
    maxBytes: 50 * 1024 * 1024,
    extensions: ['.csv'],
  },
  {
    kind: 'spreadsheet',
    mimes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ],
    magic: [
      { offset: 0, bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]) }, // ZIP-based xlsx
      { offset: 0, bytes: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) }, // OLE2 .xls
    ],
    maxBytes: 20 * 1024 * 1024,
    extensions: ['.xlsx', '.xls'],
  },
  {
    kind: 'document',
    mimes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    magic: [
      { offset: 0, bytes: Buffer.from('%PDF-', 'utf8') },
      { offset: 0, bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]) }, // docx
      { offset: 0, bytes: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) }, // doc
    ],
    maxBytes: 25 * 1024 * 1024,
    extensions: ['.pdf', '.doc', '.docx'],
  },
];

export class FileValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'PATH_TRAVERSAL'
      | 'FILENAME_INVALID'
      | 'FILE_TOO_LARGE'
      | 'MIME_NOT_ALLOWED'
      | 'EXTENSION_NOT_ALLOWED'
      | 'CONTENT_MISMATCH'
      | 'VIRUS_DETECTED',
  ) {
    super(message);
    this.name = 'FileValidationError';
  }
}

export interface UploadInput {
  filename: string;
  declaredMime: string;
  body: Buffer;
}

export interface UploadValidationResult {
  kind: FileKind;
  sanitisedFilename: string;
  size: number;
  mime: string;
}

/**
 * Run full validation against the requested file kind. Throws
 * `FileValidationError` on the first failure.
 */
export async function validateUpload(
  input: UploadInput,
  kind: FileKind,
): Promise<UploadValidationResult> {
  const allow = ALLOW_LIST.find((entry) => entry.kind === kind);
  if (!allow) throw new FileValidationError(`Unknown file kind: ${kind}`, 'MIME_NOT_ALLOWED');

  const sanitisedFilename = sanitiseFilename(input.filename);
  if (sanitisedFilename !== path.basename(sanitisedFilename)) {
    throw new FileValidationError('Filename failed path-traversal guard', 'PATH_TRAVERSAL');
  }
  const ext = path.extname(sanitisedFilename).toLowerCase();
  if (!allow.extensions.includes(ext)) {
    throw new FileValidationError(
      `Extension not allowed for ${kind}: ${ext}`,
      'EXTENSION_NOT_ALLOWED',
    );
  }
  if (input.body.length === 0) {
    throw new FileValidationError('Empty file body', 'FILE_TOO_LARGE');
  }
  if (input.body.length > allow.maxBytes) {
    throw new FileValidationError(
      `File exceeds ${allow.maxBytes} bytes for kind ${kind}`,
      'FILE_TOO_LARGE',
    );
  }
  if (!allow.mimes.includes(input.declaredMime)) {
    throw new FileValidationError(
      `Declared MIME not allowed for ${kind}: ${input.declaredMime}`,
      'MIME_NOT_ALLOWED',
    );
  }
  if (allow.magic.length > 0 && !matchesAnyMagic(input.body, allow.magic)) {
    throw new FileValidationError('File content did not match declared MIME', 'CONTENT_MISMATCH');
  }
  await scanForViruses(input.body, sanitisedFilename);
  return {
    kind,
    sanitisedFilename,
    size: input.body.length,
    mime: input.declaredMime,
  };
}

/**
 * Strip directory components, normalise unicode, and remove characters
 * that have caused trouble in S3 / R2 keys or email attachments.
 */
export function sanitiseFilename(raw: string): string {
  if (!raw) throw new FileValidationError('Empty filename', 'FILENAME_INVALID');
  const trimmed = raw.normalize('NFKC').trim();
  // Take only the basename - strips Windows backslashes and POSIX paths.
  const base = path
    .basename(trimmed.replace(/\\/g, '/'))
    .replace(/^\.+/, '') // no leading dots (hidden files / null prefix)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '') // strip control bytes (NUL through US, plus DEL)
    .replace(/[<>:"|?*]/g, '_') // forbidden in Windows / R2 keys
    .replace(/\s+/g, '_');
  if (!base || base === '.' || base === '..') {
    throw new FileValidationError('Filename invalid after sanitisation', 'FILENAME_INVALID');
  }
  if (base.length > 255) {
    throw new FileValidationError('Filename too long (>255 bytes)', 'FILENAME_INVALID');
  }
  return base;
}

function matchesAnyMagic(
  body: Buffer,
  magic: ReadonlyArray<{ offset: number; bytes: Buffer }>,
): boolean {
  return magic.some((sig) => {
    if (body.length < sig.offset + sig.bytes.length) return false;
    return (
      body.compare(sig.bytes, 0, sig.bytes.length, sig.offset, sig.offset + sig.bytes.length) === 0
    );
  });
}

/**
 * Pluggable virus-scan hook. The real implementation calls into an
 * external scanner (e.g. ClamAV daemon, Cloudmersive). Default in dev
 * is a literal EICAR-test-only scan so the integration code path runs
 * end-to-end without an external dependency.
 */
const EICAR_SIGNATURE = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export type VirusScanner = (
  body: Buffer,
  filename: string,
) => Promise<{ clean: boolean; reason?: string }>;

let activeScanner: VirusScanner = async (body) => {
  // The dev/test scanner ONLY catches the EICAR signature. Real
  // production deployments must call `setVirusScanner(...)` at boot to
  // wire ClamAV / Cloudmersive / equivalent.
  const bodyText = body.toString('latin1', 0, Math.min(body.length, 512));
  if (bodyText.includes(EICAR_SIGNATURE)) {
    return { clean: false, reason: 'EICAR test signature detected' };
  }
  return { clean: true };
};

export function setVirusScanner(scanner: VirusScanner): void {
  activeScanner = scanner;
  logger.info({ event: 'security.virus_scanner.installed' }, 'virus scanner replaced');
}

async function scanForViruses(body: Buffer, filename: string): Promise<void> {
  const result = await activeScanner(body, filename);
  if (!result.clean) {
    throw new FileValidationError(
      `Virus scan rejected upload: ${result.reason ?? 'unknown'}`,
      'VIRUS_DETECTED',
    );
  }
}

/**
 * Zod schema for multipart/form-data file metadata, used by routes that
 * accept uploads via the multipart parser. The `body` itself is checked
 * by `validateUpload`.
 */
export const FileMetadataSchema = z.object({
  filename: z.string().min(1).max(255),
  declaredMime: z.string().min(3).max(127),
});
export type FileMetadata = z.infer<typeof FileMetadataSchema>;
