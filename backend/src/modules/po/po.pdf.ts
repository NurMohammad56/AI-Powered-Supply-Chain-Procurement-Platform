import PDFDocument from 'pdfkit';

import type { PurchaseOrderDoc } from './models/purchaseOrder.model.js';

export interface FactoryHeader {
  name: string;
  addressLine: string;
  baseCurrency: 'BDT' | 'USD';
  primaryColor: string;
}

export interface PoPdfOptions {
  factory: FactoryHeader;
  po: PurchaseOrderDoc;
  isDraftWatermark?: boolean;
  termsAndConditions?: string;
}

const A4_PORTRAIT = { size: 'A4' as const, margin: 50 };

const DEFAULT_TERMS = `1. Goods will be inspected on receipt; any defects must be raised within 7 working days.
2. Payment terms apply from the goods-received-note (GRN) date.
3. Late delivery beyond the expected date may attract a 2% per-week penalty.
4. Substitution of items requires written approval from the buyer prior to dispatch.
5. This purchase order is governed by the laws of the People's Republic of Bangladesh.`;

/**
 * Render a Purchase Order PDF to a Buffer using PDFKit. Pure function:
 * does not touch the database or filesystem - the caller (the PO
 * service) handles persistence + R2 upload.
 */
export async function renderPoPdf(opts: PoPdfOptions): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ ...A4_PORTRAIT, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err: Error) => reject(err));

    try {
      drawHeader(doc, opts);
      drawMeta(doc, opts);
      drawSupplierBlock(doc, opts);
      drawLineItemsTable(doc, opts);
      drawTotals(doc, opts);
      drawTerms(doc, opts);
      drawSignatureBlock(doc, opts);
      drawFooter(doc, opts);
      if (opts.isDraftWatermark || opts.po.state === 'draft') {
        drawWatermark(doc, 'DRAFT');
      } else if (opts.po.state === 'cancelled' || opts.po.state === 'rejected') {
        drawWatermark(doc, opts.po.state.toUpperCase());
      }
      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ---- Section painters ---------------------------------------------------

function drawHeader(doc: PDFKit.PDFDocument, opts: PoPdfOptions): void {
  const { factory, po } = opts;
  doc.fillColor(factory.primaryColor || '#1E40AF').fontSize(20).font('Helvetica-Bold');
  doc.text(factory.name, { align: 'left' });
  doc.moveDown(0.2);
  doc.fontSize(9).fillColor('#4b5563').font('Helvetica');
  doc.text(factory.addressLine);
  doc.moveDown(0.5);

  // Title block on the right side of the header.
  const startY = doc.y;
  doc.fontSize(18).fillColor(factory.primaryColor || '#1E40AF').font('Helvetica-Bold');
  doc.text('PURCHASE ORDER', 350, startY - 50, { width: 200, align: 'right' });
  doc.moveDown(0.2);
  doc.fontSize(10).fillColor('#1f2937').font('Helvetica');
  doc.text(`PO #: ${po.number}`, 350, doc.y, { width: 200, align: 'right' });
  doc.text(`Date: ${formatDate(po.createdAt)}`, 350, doc.y, { width: 200, align: 'right' });
  doc.text(`Expected: ${formatDate(po.expectedDeliveryAt)}`, 350, doc.y, { width: 200, align: 'right' });

  // Reset cursor to left under the header rule.
  doc.moveDown(1).x = 50;
  drawHorizontalRule(doc);
}

function drawMeta(doc: PDFKit.PDFDocument, opts: PoPdfOptions): void {
  const { po } = opts;
  doc.moveDown(0.5);
  doc.fillColor('#1f2937').fontSize(9).font('Helvetica-Bold');
  doc.text('Status: ', { continued: true });
  doc.font('Helvetica').text(po.state.replace(/_/g, ' ').toUpperCase());
  doc.text('Currency: ', { continued: true }).font('Helvetica');
  doc.text(po.currency);
  doc.text('Payment Terms: ', { continued: true }).font('Helvetica-Bold');
  doc.text(`${po.paymentTermsDays} days`);
}

function drawSupplierBlock(doc: PDFKit.PDFDocument, opts: PoPdfOptions): void {
  const { po } = opts;
  doc.moveDown(0.8);
  doc.fontSize(11).fillColor(opts.factory.primaryColor || '#1E40AF').font('Helvetica-Bold');
  doc.text('Supplier');
  doc.fillColor('#1f2937').fontSize(10).font('Helvetica');
  doc.text(po.supplierSnapshot.legalName);
  if (po.supplierSnapshot.address) {
    doc.text(po.supplierSnapshot.address);
  }
  if (po.supplierSnapshot.primaryContactEmail) {
    doc.text(po.supplierSnapshot.primaryContactEmail);
  }
  doc.moveDown(0.5);
}

function drawLineItemsTable(doc: PDFKit.PDFDocument, opts: PoPdfOptions): void {
  const { po } = opts;
  const tableTop = doc.y + 10;
  const colWidths = [40, 90, 200, 60, 70, 70];
  const headers = ['#', 'SKU', 'Description', 'Qty', 'Unit price', 'Line total'];
  const x0 = 50;

  // Header row
  doc.fillColor(opts.factory.primaryColor || '#1E40AF').rect(x0, tableTop, sum(colWidths), 22).fill();
  doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold');
  let cx = x0 + 6;
  headers.forEach((h, idx) => {
    doc.text(h, cx, tableTop + 6, { width: (colWidths[idx] ?? 0) - 6 });
    cx += colWidths[idx] ?? 0;
  });

  // Data rows
  doc.fillColor('#1f2937').font('Helvetica').fontSize(9);
  let rowY = tableTop + 24;
  po.lines.forEach((line, idx) => {
    if (rowY > 720) {
      doc.addPage();
      rowY = 60;
    }
    const cells = [
      String(idx + 1),
      line.itemSnapshot.sku,
      line.itemSnapshot.name,
      `${line.quantityOrdered} ${line.itemSnapshot.unit}`,
      formatMoney(line.unitPrice, po.currency),
      formatMoney(line.lineTotal, po.currency),
    ];
    let bx = x0 + 6;
    cells.forEach((cell, i) => {
      doc.text(cell, bx, rowY, { width: (colWidths[i] ?? 0) - 6 });
      bx += colWidths[i] ?? 0;
    });
    // Row separator.
    doc
      .strokeColor('#e5e7eb')
      .lineWidth(0.5)
      .moveTo(x0, rowY + 18)
      .lineTo(x0 + sum(colWidths), rowY + 18)
      .stroke();
    rowY += 22;
  });
  doc.y = rowY + 10;
}

function drawTotals(doc: PDFKit.PDFDocument, opts: PoPdfOptions): void {
  const { po } = opts;
  doc.moveDown(0.5);
  const labelX = 380;
  const valueX = 480;
  doc.fontSize(10).fillColor('#4b5563').font('Helvetica');
  doc.text('Subtotal', labelX, doc.y, { width: 90, align: 'right' });
  doc.text(formatMoney(po.totals.subtotal, po.currency), valueX, doc.y, { width: 80, align: 'right' });
  doc.moveDown(0.2);
  doc.text('Tax', labelX, doc.y, { width: 90, align: 'right' });
  doc.text(formatMoney(po.totals.tax, po.currency), valueX, doc.y, { width: 80, align: 'right' });
  doc.moveDown(0.3);
  doc.fontSize(12).fillColor('#1f2937').font('Helvetica-Bold');
  doc.text('Grand total', labelX, doc.y, { width: 90, align: 'right' });
  doc.text(formatMoney(po.totals.total, po.currency), valueX, doc.y, { width: 80, align: 'right' });
  doc.x = 50;
  doc.moveDown(1.2);
}

function drawTerms(doc: PDFKit.PDFDocument, opts: PoPdfOptions): void {
  const terms = (opts.termsAndConditions ?? DEFAULT_TERMS).trim();
  doc.fillColor(opts.factory.primaryColor || '#1E40AF').fontSize(10).font('Helvetica-Bold');
  doc.text('Terms and conditions');
  doc.fillColor('#374151').font('Helvetica').fontSize(8);
  doc.text(terms, { lineGap: 1 });
  doc.moveDown(0.8);
}

function drawSignatureBlock(doc: PDFKit.PDFDocument, opts: PoPdfOptions): void {
  const startY = Math.max(doc.y, 700);
  const x0 = 50;
  doc
    .strokeColor('#1f2937')
    .lineWidth(0.5)
    .moveTo(x0, startY)
    .lineTo(x0 + 180, startY)
    .stroke();
  doc.fontSize(8).fillColor('#4b5563').font('Helvetica');
  doc.text('Authorized signature', x0, startY + 4);
  doc.text(opts.factory.name, x0, startY + 16);
}

function drawFooter(doc: PDFKit.PDFDocument, opts: PoPdfOptions): void {
  doc.fontSize(7).fillColor('#9ca3af').font('Helvetica');
  doc.text(
    `Generated on ${new Date().toISOString()} - ${opts.factory.name} - this document was system-generated.`,
    50,
    790,
    { align: 'center', width: 500 },
  );
}

function drawWatermark(doc: PDFKit.PDFDocument, label: string): void {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    doc.save();
    doc.fillColor('#dc2626', 0.12).fontSize(110).font('Helvetica-Bold');
    doc.rotate(-30, { origin: [300, 400] });
    doc.text(label, 50, 360, { width: 500, align: 'center' });
    doc.restore();
  }
}

// ---- helpers ------------------------------------------------------------

function drawHorizontalRule(doc: PDFKit.PDFDocument): void {
  const y = doc.y + 4;
  doc.strokeColor('#e5e7eb').lineWidth(0.8).moveTo(50, y).lineTo(545, y).stroke();
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function formatDate(d: Date | null | undefined): string {
  if (!d) return '-';
  return d.toISOString().slice(0, 10);
}

function formatMoney(n: number, currency: string): string {
  if (!Number.isFinite(n)) return '-';
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'decimal',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency} ${formatter.format(n)}`;
}
