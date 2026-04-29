import type { PurchaseOrderDoc } from './models/purchaseOrder.model.js';

/**
 * HTML email templates for every PO state transition. Pure functions:
 * accept the PO doc (and any extras) and return `{ subject, html, text }`.
 * The PO service builds the email and enqueues it onto the email queue;
 * the email worker handles delivery + retries + dead-letter.
 *
 * Style is intentionally inline-minimal so the messages render on legacy
 * mail clients without external CSS.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const BRAND_COLOR = '#1E40AF';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shell(title: string, body: string, footer?: string): string {
  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#111827;">
  <div style="max-width:560px;margin:24px auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <div style="background:${BRAND_COLOR};color:#ffffff;padding:18px 24px;font-size:16px;font-weight:600;">
      ${escapeHtml(title)}
    </div>
    <div style="padding:24px;line-height:1.5;font-size:14px;">
      ${body}
    </div>
    ${footer ? `<div style="border-top:1px solid #e5e7eb;padding:14px 24px;color:#6b7280;font-size:12px;">${footer}</div>` : ''}
  </div>
</body>
</html>`;
}

function summaryBlock(po: PurchaseOrderDoc): string {
  return `
    <table style="border-collapse:collapse;width:100%;margin:12px 0;">
      <tr><td style="padding:4px 0;color:#6b7280;width:140px;">PO number</td><td style="padding:4px 0;"><strong>${escapeHtml(po.number)}</strong></td></tr>
      <tr><td style="padding:4px 0;color:#6b7280;">Supplier</td><td style="padding:4px 0;">${escapeHtml(po.supplierSnapshot.legalName)}</td></tr>
      <tr><td style="padding:4px 0;color:#6b7280;">Expected delivery</td><td style="padding:4px 0;">${po.expectedDeliveryAt.toISOString().slice(0, 10)}</td></tr>
      <tr><td style="padding:4px 0;color:#6b7280;">Total</td><td style="padding:4px 0;"><strong>${escapeHtml(po.currency)} ${po.totals.total.toFixed(2)}</strong></td></tr>
    </table>`;
}

export function renderPoSubmittedEmail(args: {
  po: PurchaseOrderDoc;
  approverName: string;
  submitterName: string;
  approveLink: string;
}): RenderedEmail {
  const subject = `[Action required] PO ${args.po.number} awaiting your approval`;
  const body = `
    <p>Hi ${escapeHtml(args.approverName)},</p>
    <p><strong>${escapeHtml(args.submitterName)}</strong> has submitted a purchase order for your review.</p>
    ${summaryBlock(args.po)}
    <p>
      <a href="${args.approveLink}" style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">Open PO</a>
    </p>
    <p style="color:#6b7280;">If you weren't expecting this email, please contact your finance team.</p>
  `;
  const text = `Hi ${args.approverName}, ${args.submitterName} has submitted PO ${args.po.number} for approval. Total ${args.po.currency} ${args.po.totals.total.toFixed(2)}. Approve at: ${args.approveLink}`;
  return { subject, html: shell('Purchase order awaiting approval', body), text };
}

export function renderPoApprovedEmail(args: {
  po: PurchaseOrderDoc;
  requesterName: string;
  approverName: string;
  pdfUrl: string | null;
}): RenderedEmail {
  const subject = `PO ${args.po.number} approved`;
  const pdfBlock = args.pdfUrl
    ? `<p><a href="${args.pdfUrl}" style="color:${BRAND_COLOR};">Download PO PDF</a></p>`
    : '';
  const body = `
    <p>Hi ${escapeHtml(args.requesterName)},</p>
    <p>${escapeHtml(args.approverName)} has approved your purchase order.</p>
    ${summaryBlock(args.po)}
    ${pdfBlock}
    <p>You can now dispatch this PO to the supplier from the dashboard.</p>
  `;
  const text = `PO ${args.po.number} has been approved by ${args.approverName}. Total ${args.po.currency} ${args.po.totals.total.toFixed(2)}.`;
  return { subject, html: shell('Purchase order approved', body), text };
}

export function renderPoRejectedEmail(args: {
  po: PurchaseOrderDoc;
  requesterName: string;
  approverName: string;
  reason: string;
}): RenderedEmail {
  const subject = `PO ${args.po.number} rejected`;
  const body = `
    <p>Hi ${escapeHtml(args.requesterName)},</p>
    <p>${escapeHtml(args.approverName)} has rejected your purchase order with the following reason:</p>
    <blockquote style="border-left:3px solid #dc2626;padding:8px 12px;background:#fef2f2;color:#991b1b;">${escapeHtml(args.reason)}</blockquote>
    ${summaryBlock(args.po)}
    <p>You can revise and resubmit the PO from the dashboard.</p>
  `;
  const text = `PO ${args.po.number} rejected by ${args.approverName}. Reason: ${args.reason}`;
  return { subject, html: shell('Purchase order rejected', body), text };
}

export function renderPoSentToSupplierEmail(args: {
  po: PurchaseOrderDoc;
  supplierContactName: string;
  factoryName: string;
  pdfUrl: string;
}): RenderedEmail {
  const subject = `Purchase order ${args.po.number} from ${args.factoryName}`;
  const body = `
    <p>Hi ${escapeHtml(args.supplierContactName)},</p>
    <p>${escapeHtml(args.factoryName)} has issued you a new purchase order. Please confirm receipt and target delivery date.</p>
    ${summaryBlock(args.po)}
    <p><a href="${args.pdfUrl}" style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">Download PO PDF</a></p>
    <p>If any line item is unavailable or pricing has changed, reply to this email before scheduling production.</p>
  `;
  const text = `${args.factoryName} has sent PO ${args.po.number}. Total ${args.po.currency} ${args.po.totals.total.toFixed(2)}. PDF: ${args.pdfUrl}`;
  return { subject, html: shell(`PO ${args.po.number} from ${args.factoryName}`, body), text };
}

export function renderDeliveryOverdueEmail(args: {
  po: PurchaseOrderDoc;
  recipientName: string;
  daysOverdue: number;
}): RenderedEmail {
  const subject = `[Action required] Delivery overdue: PO ${args.po.number} (${args.daysOverdue} days late)`;
  const body = `
    <p>Hi ${escapeHtml(args.recipientName)},</p>
    <p>The delivery for PO <strong>${escapeHtml(args.po.number)}</strong> is <strong>${args.daysOverdue} days overdue</strong>. The expected date was ${args.po.expectedDeliveryAt.toISOString().slice(0, 10)}.</p>
    ${summaryBlock(args.po)}
    <p>Please follow up with the supplier or update the expected delivery date if a new ETA has been agreed.</p>
  `;
  const text = `PO ${args.po.number} delivery is ${args.daysOverdue} days overdue. Expected: ${args.po.expectedDeliveryAt.toISOString().slice(0, 10)}.`;
  return { subject, html: shell('Delivery overdue', body), text };
}

export function renderPoFullyReceivedEmail(args: {
  po: PurchaseOrderDoc;
  recipientName: string;
  receivedQuantity: number;
}): RenderedEmail {
  const subject = `PO ${args.po.number} fully received`;
  const body = `
    <p>Hi ${escapeHtml(args.recipientName)},</p>
    <p>All line items on PO <strong>${escapeHtml(args.po.number)}</strong> have been received. Total quantity: <strong>${args.receivedQuantity}</strong> units across ${args.po.lines.length} line(s).</p>
    ${summaryBlock(args.po)}
    <p>Stock balances have been updated automatically. Please reconcile any quality issues within 7 working days.</p>
  `;
  const text = `PO ${args.po.number} fully received. ${args.receivedQuantity} units across ${args.po.lines.length} lines.`;
  return { subject, html: shell('Purchase order fully received', body), text };
}
