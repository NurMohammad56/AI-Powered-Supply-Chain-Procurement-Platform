import { Types } from 'mongoose';

import { logger } from '../../config/logger.js';
import { enqueueEmail } from '../../shared/queue/queues.js';
import { User } from '../auth/models/user.model.js';
import { Factory } from '../auth/models/factory.model.js';
import {
  renderDeliveryOverdueEmail,
  renderPoApprovedEmail,
  renderPoFullyReceivedEmail,
  renderPoRejectedEmail,
  renderPoSentToSupplierEmail,
  renderPoSubmittedEmail,
} from './po.emails.js';
import type { PurchaseOrderDoc } from './models/purchaseOrder.model.js';

/**
 * Cross-cutting helpers: PO state transitions trigger one or more
 * emails. Each helper takes a PO doc + the bare minimum context, fans
 * the email job out to BullMQ, and never throws (notification failures
 * must not break a state transition).
 */

async function findManagersForApproval(tenantId: Types.ObjectId): Promise<Array<{ email: string; fullName: string }>> {
  return User.find({ tenantId, role: { $in: ['owner', 'manager'] }, status: 'active' })
    .select({ email: 1, fullName: 1 })
    .lean<Array<{ email: string; fullName: string }>>()
    .exec();
}

async function findUserById(tenantId: Types.ObjectId, userId: Types.ObjectId): Promise<{ email: string; fullName: string } | null> {
  return User.findOne({ _id: userId, tenantId })
    .select({ email: 1, fullName: 1 })
    .lean<{ email: string; fullName: string }>()
    .exec();
}

function dashboardLink(po: PurchaseOrderDoc): string {
  // FRONTEND_BASE_URL ships the dashboard; deep-link to the PO detail page.
  return `${process.env.FRONTEND_BASE_URL ?? 'http://localhost:3000'}/purchase-orders/${po._id.toString()}`;
}

export async function notifyPoSubmitted(args: {
  po: PurchaseOrderDoc;
  submitterId: Types.ObjectId;
}): Promise<void> {
  try {
    const submitter = await findUserById(args.po.tenantId, args.submitterId);
    const approvers = await findManagersForApproval(args.po.tenantId);
    const submitterName = submitter?.fullName ?? 'A team member';
    for (const approver of approvers) {
      // Don't email the submitter their own request.
      if (submitter && approver.email === submitter.email) continue;
      const rendered = renderPoSubmittedEmail({
        po: args.po,
        approverName: approver.fullName,
        submitterName,
        approveLink: dashboardLink(args.po),
      });
      await enqueueEmail('email.send', {
        tenantId: args.po.tenantId.toString(),
        to: approver.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        tags: { kind: 'po_submitted', poId: args.po._id.toString() },
      });
    }
  } catch (err) {
    logger.warn({ err, event: 'po.notify_submitted_failed', poId: args.po._id.toString() }, 'failed to notify approvers');
  }
}

export async function notifyPoApproved(args: {
  po: PurchaseOrderDoc;
  approverId: Types.ObjectId;
  pdfUrl: string | null;
}): Promise<void> {
  try {
    const requesterId = args.po.approval?.submittedBy ?? args.po.createdBy;
    const requester = await findUserById(args.po.tenantId, requesterId);
    const approver = await findUserById(args.po.tenantId, args.approverId);
    if (!requester) return;
    const rendered = renderPoApprovedEmail({
      po: args.po,
      requesterName: requester.fullName,
      approverName: approver?.fullName ?? 'A manager',
      pdfUrl: args.pdfUrl,
    });
    await enqueueEmail('email.send', {
      tenantId: args.po.tenantId.toString(),
      to: requester.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: { kind: 'po_approved', poId: args.po._id.toString() },
    });
  } catch (err) {
    logger.warn({ err, event: 'po.notify_approved_failed', poId: args.po._id.toString() }, 'failed to notify requester');
  }
}

export async function notifyPoRejected(args: {
  po: PurchaseOrderDoc;
  approverId: Types.ObjectId;
  reason: string;
}): Promise<void> {
  try {
    const requesterId = args.po.approval?.submittedBy ?? args.po.createdBy;
    const requester = await findUserById(args.po.tenantId, requesterId);
    const approver = await findUserById(args.po.tenantId, args.approverId);
    if (!requester) return;
    const rendered = renderPoRejectedEmail({
      po: args.po,
      requesterName: requester.fullName,
      approverName: approver?.fullName ?? 'A manager',
      reason: args.reason,
    });
    await enqueueEmail('email.send', {
      tenantId: args.po.tenantId.toString(),
      to: requester.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: { kind: 'po_rejected', poId: args.po._id.toString() },
    });
  } catch (err) {
    logger.warn({ err, event: 'po.notify_rejected_failed', poId: args.po._id.toString() }, 'failed to notify requester');
  }
}

export async function notifyPoSentToSupplier(args: {
  po: PurchaseOrderDoc;
  supplierContactName: string;
  supplierContactEmail: string;
  pdfUrl: string;
}): Promise<void> {
  try {
    const factory = await Factory.findById(args.po.tenantId).lean().exec();
    if (!factory) return;
    const rendered = renderPoSentToSupplierEmail({
      po: args.po,
      supplierContactName: args.supplierContactName,
      factoryName: factory.name,
      pdfUrl: args.pdfUrl,
    });
    await enqueueEmail('email.send', {
      tenantId: args.po.tenantId.toString(),
      to: args.supplierContactEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: { kind: 'po_sent_to_supplier', poId: args.po._id.toString() },
    });
  } catch (err) {
    logger.warn({ err, event: 'po.notify_supplier_failed', poId: args.po._id.toString() }, 'failed to email supplier');
  }
}

export async function notifyPoFullyReceived(args: {
  po: PurchaseOrderDoc;
  receivedQuantity: number;
}): Promise<void> {
  try {
    const recipientId = args.po.createdBy;
    const recipient = await findUserById(args.po.tenantId, recipientId);
    if (!recipient) return;
    const rendered = renderPoFullyReceivedEmail({
      po: args.po,
      recipientName: recipient.fullName,
      receivedQuantity: args.receivedQuantity,
    });
    await enqueueEmail('email.send', {
      tenantId: args.po.tenantId.toString(),
      to: recipient.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: { kind: 'po_fully_received', poId: args.po._id.toString() },
    });
  } catch (err) {
    logger.warn({ err, event: 'po.notify_received_failed', poId: args.po._id.toString() }, 'failed to notify on receipt');
  }
}

export async function notifyDeliveryOverdue(args: {
  po: PurchaseOrderDoc;
  daysOverdue: number;
}): Promise<void> {
  try {
    const managers = await findManagersForApproval(args.po.tenantId);
    for (const m of managers) {
      const rendered = renderDeliveryOverdueEmail({
        po: args.po,
        recipientName: m.fullName,
        daysOverdue: args.daysOverdue,
      });
      await enqueueEmail('email.send', {
        tenantId: args.po.tenantId.toString(),
        to: m.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        tags: { kind: 'po_delivery_overdue', poId: args.po._id.toString() },
      });
    }
  } catch (err) {
    logger.warn(
      { err, event: 'po.notify_overdue_failed', poId: args.po._id.toString() },
      'failed to send overdue alerts',
    );
  }
}
