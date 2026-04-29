import { Types } from 'mongoose';

import { ConflictError, NotFoundError, BadRequestError } from '../../shared/errors/HttpErrors.js';
import { ErrorCodes } from '../../shared/errors/errorCodes.js';
import { assertTenantOwns } from '../../shared/auth/assertTenantOwns.js';
import { recordAudit, AuditActions } from '../../shared/audit/index.js';
import type { TenantContext } from '../../shared/auth/types.js';
import type { Page } from '../../shared/utils/pagination.js';
import { supplierRepository } from './supplier.repository.js';
import type { SupplierDoc } from './models/supplier.model.js';
import type {
  AddContactRequest,
  AddDocumentRequest,
  CreateSupplierRequest,
  ListSuppliersQuery,
  SupplierView,
  UpdateContactRequest,
  UpdateSupplierRequest,
} from './supplier.dto.js';

function toSupplierView(s: SupplierDoc): SupplierView {
  return {
    id: s._id.toString(),
    legalName: s.legalName,
    tradingName: s.tradingName,
    taxId: s.taxId,
    status: s.status,
    address: s.address
      ? {
          street: s.address.street,
          city: s.address.city,
          country: s.address.country,
          postalCode: s.address.postalCode ?? null,
        }
      : null,
    paymentTermsDays: s.paymentTermsDays,
    leadTimeDays: s.leadTimeDays,
    contacts: s.contacts.map((c) => ({
      name: c.name,
      designation: c.designation,
      email: c.email,
      phone: c.phone,
      isPrimary: c.isPrimary,
    })),
    categoryIds: s.categoryIds.map((id) => id.toString()),
    tier: s.tier,
    performanceScore: {
      overall: s.performanceScore.overall,
      onTimeDeliveryRate: s.performanceScore.onTimeDeliveryRate,
      qualityRejectRate: s.performanceScore.qualityRejectRate,
      priceCompetitiveness: s.performanceScore.priceCompetitiveness,
      sampleSize: s.performanceScore.sampleSize,
      computedAt: s.performanceScore.computedAt
        ? s.performanceScore.computedAt.toISOString()
        : null,
    },
    documents: s.documentUrls.map((d) => ({
      kind: d.kind,
      url: d.url,
      uploadedAt: d.uploadedAt.toISOString(),
    })),
    archivedAt: s.archivedAt ? s.archivedAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

function pagedView<T, V>(page: Page<T>, mapper: (row: T) => V) {
  return {
    rows: page.rows.map(mapper),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    limit: page.limit,
  };
}

export class SupplierService {
  async create(ctx: TenantContext, input: CreateSupplierRequest): Promise<SupplierView> {
    if (input.taxId) {
      const dup = await supplierRepository.findByTaxId(input.taxId);
      if (dup) throw new ConflictError(ErrorCodes.RESOURCE_DUPLICATE, 'Supplier with this taxId already exists');
    }
    const created = await supplierRepository.create({
      legalName: input.legalName,
      tradingName: input.tradingName ?? null,
      taxId: input.taxId ?? null,
      status: input.status,
      address: input.address
        ? {
            street: input.address.street,
            city: input.address.city,
            country: input.address.country,
            postalCode: input.address.postalCode ?? null,
          }
        : null,
      paymentTermsDays: input.paymentTermsDays,
      leadTimeDays: input.leadTimeDays,
      contacts: input.contacts.map((c) => ({
        name: c.name,
        designation: c.designation ?? null,
        email: c.email,
        phone: c.phone ?? null,
        isPrimary: c.isPrimary,
      })),
      categoryIds: input.categoryIds.map((id) => new Types.ObjectId(id)),
      tier: input.tier,
    });
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.SupplierCreated,
      target: { kind: 'supplier', id: created._id },
      payload: { legalName: created.legalName },
      requestId: ctx.requestId,
    });
    return toSupplierView(created);
  }

  async get(ctx: TenantContext, id: Types.ObjectId): Promise<SupplierView> {
    const s = await supplierRepository.findById(id);
    assertTenantOwns(s, ctx);
    return toSupplierView(s);
  }

  async update(
    ctx: TenantContext,
    id: Types.ObjectId,
    patch: UpdateSupplierRequest,
  ): Promise<SupplierView> {
    const s = await supplierRepository.findById(id);
    assertTenantOwns(s, ctx);
    if (patch.taxId && patch.taxId !== s.taxId) {
      const dup = await supplierRepository.findByTaxId(patch.taxId);
      if (dup) throw new ConflictError(ErrorCodes.RESOURCE_DUPLICATE, 'taxId already in use');
    }
    const update: Partial<SupplierDoc> = {};
    if (patch.legalName !== undefined) update.legalName = patch.legalName;
    if (patch.tradingName !== undefined) update.tradingName = patch.tradingName ?? null;
    if (patch.taxId !== undefined) update.taxId = patch.taxId ?? null;
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.address !== undefined) {
      update.address = patch.address
        ? {
            street: patch.address.street,
            city: patch.address.city,
            country: patch.address.country,
            postalCode: patch.address.postalCode ?? null,
          }
        : null;
    }
    if (patch.paymentTermsDays !== undefined) update.paymentTermsDays = patch.paymentTermsDays;
    if (patch.leadTimeDays !== undefined) update.leadTimeDays = patch.leadTimeDays;
    if (patch.tier !== undefined) update.tier = patch.tier;
    if (patch.contacts !== undefined) {
      update.contacts = patch.contacts.map((c) => ({
        name: c.name,
        designation: c.designation ?? null,
        email: c.email,
        phone: c.phone ?? null,
        isPrimary: c.isPrimary,
      }));
    }
    if (patch.categoryIds !== undefined) {
      update.categoryIds = patch.categoryIds.map((id2) => new Types.ObjectId(id2));
    }
    const updated = await supplierRepository.update(id, update);
    if (!updated) throw new NotFoundError();
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.SupplierUpdated,
      target: { kind: 'supplier', id },
      before: s,
      after: updated,
      requestId: ctx.requestId,
    });
    return toSupplierView(updated);
  }

  async archive(ctx: TenantContext, id: Types.ObjectId): Promise<void> {
    const s = await supplierRepository.findById(id);
    assertTenantOwns(s, ctx);
    await supplierRepository.archive(id);
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.SupplierArchived,
      target: { kind: 'supplier', id },
      requestId: ctx.requestId,
    });
  }

  async list(_ctx: TenantContext, query: ListSuppliersQuery) {
    const page = await supplierRepository.list(query);
    return pagedView(page, toSupplierView);
  }

  async addContact(
    ctx: TenantContext,
    id: Types.ObjectId,
    input: AddContactRequest,
  ): Promise<SupplierView> {
    const s = await supplierRepository.findById(id);
    assertTenantOwns(s, ctx);
    if (s.contacts.length >= 20) {
      throw new BadRequestError(ErrorCodes.BAD_REQUEST, 'Maximum 20 contacts per supplier');
    }
    const updated = await supplierRepository.pushContact(id, {
      name: input.name,
      designation: input.designation ?? null,
      email: input.email,
      phone: input.phone ?? null,
      isPrimary: input.isPrimary,
    });
    if (!updated) throw new NotFoundError();
    return toSupplierView(updated);
  }

  async updateContact(
    ctx: TenantContext,
    id: Types.ObjectId,
    index: number,
    input: UpdateContactRequest,
  ): Promise<SupplierView> {
    const s = await supplierRepository.findById(id);
    assertTenantOwns(s, ctx);
    const existing = s.contacts[index];
    if (!existing) throw new NotFoundError();
    const merged = {
      name: input.name ?? existing.name,
      designation: input.designation !== undefined ? (input.designation ?? null) : existing.designation,
      email: input.email ?? existing.email,
      phone: input.phone !== undefined ? (input.phone ?? null) : existing.phone,
      isPrimary: input.isPrimary ?? existing.isPrimary,
    };
    const updated = await supplierRepository.setContactAt(id, index, merged);
    if (!updated) throw new NotFoundError();
    return toSupplierView(updated);
  }

  async removeContact(
    ctx: TenantContext,
    id: Types.ObjectId,
    index: number,
  ): Promise<SupplierView> {
    const s = await supplierRepository.findById(id);
    assertTenantOwns(s, ctx);
    if (!s.contacts[index]) throw new NotFoundError();
    const updated = await supplierRepository.unsetContactAt(id, index);
    if (!updated) throw new NotFoundError();
    return toSupplierView(updated);
  }

  async addDocument(
    ctx: TenantContext,
    id: Types.ObjectId,
    input: AddDocumentRequest,
  ): Promise<SupplierView> {
    const s = await supplierRepository.findById(id);
    assertTenantOwns(s, ctx);
    const updated = await supplierRepository.pushDocument(id, {
      kind: input.kind,
      url: input.url,
      uploadedAt: new Date(),
    });
    if (!updated) throw new NotFoundError();
    return toSupplierView(updated);
  }

  async removeDocument(
    ctx: TenantContext,
    id: Types.ObjectId,
    index: number,
  ): Promise<SupplierView> {
    const s = await supplierRepository.findById(id);
    assertTenantOwns(s, ctx);
    if (!s.documentUrls[index]) throw new NotFoundError();
    const updated = await supplierRepository.unsetDocumentAt(id, index);
    if (!updated) throw new NotFoundError();
    return toSupplierView(updated);
  }

  async getPerformance(ctx: TenantContext, id: Types.ObjectId) {
    const s = await supplierRepository.findById(id);
    assertTenantOwns(s, ctx);
    return {
      supplierId: s._id.toString(),
      ...s.performanceScore,
      computedAt: s.performanceScore.computedAt
        ? s.performanceScore.computedAt.toISOString()
        : null,
    };
  }

  async compare(ctx: TenantContext, ids: string[]): Promise<SupplierView[]> {
    const objectIds = ids.map((id) => new Types.ObjectId(id));
    const rows = await supplierRepository.findManyByIds(objectIds);
    for (const row of rows) {
      assertTenantOwns(row, ctx);
    }
    if (rows.length !== ids.length) {
      throw new NotFoundError();
    }
    return rows.map(toSupplierView);
  }
}

export const supplierService = new SupplierService();
