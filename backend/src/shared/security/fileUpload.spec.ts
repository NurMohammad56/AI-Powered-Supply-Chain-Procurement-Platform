process.env.MONGO_URI ??= 'mongodb://localhost:27017/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= '12345678901234567890123456789012';
process.env.JWT_REFRESH_SECRET ??= '22345678901234567890123456789012';
import { sanitiseFilename, validateUpload } from './fileUpload.js';
describe('Actual upload bytes and filename security', () => {
  it.each(['', '..', '.'.repeat(5), 'x'.repeat(256)])('rejects unusable filenames', (name) =>
    expect(() => sanitiseFilename(name)).toThrow(),
  );
  it('strips both Windows and POSIX traversal and control bytes', () => {
    expect(sanitiseFilename('../../invoice.pdf')).toBe('invoice.pdf');
    expect(sanitiseFilename('C:\\secret\\invoice.pdf')).toBe('invoice.pdf');
    expect(sanitiseFilename(' invoice\u0000 copy.pdf ')).toBe('invoice_copy.pdf');
  });
  it.each([
    { filename: 'file.exe', declaredMime: 'application/pdf', body: Buffer.from('%PDF-1.7') },
    { filename: 'file.pdf', declaredMime: 'application/pdf', body: Buffer.alloc(0) },
    { filename: 'file.pdf', declaredMime: 'text/html', body: Buffer.from('%PDF-1.7') },
    {
      filename: 'file.pdf',
      declaredMime: 'application/pdf',
      body: Buffer.from('<html>not PDF</html>'),
    },
    { filename: 'file.pdf', declaredMime: 'application/pdf', body: Buffer.alloc(21 * 1024 * 1024) },
  ])('rejects extension, MIME, body or size mismatch', async (input) => {
    await expect(validateUpload(input, 'pdf')).rejects.toThrow();
  });
  it('rejects the EICAR antivirus test signature', async () => {
    const body = Buffer.from(
      '%PDF-1.7\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    await expect(
      validateUpload({ filename: 'test.pdf', declaredMime: 'application/pdf', body }, 'pdf'),
    ).rejects.toThrow('Virus scan rejected');
  });
  it('accepts a small well-typed PDF and printable CSV', async () => {
    expect(
      (
        await validateUpload(
          {
            filename: 'invoice.pdf',
            declaredMime: 'application/pdf',
            body: Buffer.from('%PDF-1.7\n'),
          },
          'pdf',
        )
      ).kind,
    ).toBe('pdf');
    expect(
      (
        await validateUpload(
          {
            filename: 'items.csv',
            declaredMime: 'text/csv',
            body: Buffer.from('sku,quantity\nCOTTON,20'),
          },
          'csv',
        )
      ).kind,
    ).toBe('csv');
  });
});
