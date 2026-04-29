import { Router } from 'express';

import { validate } from '../../shared/middleware/validate.js';
import { rbacFor } from '../../shared/middleware/rbac.js';
import { idempotencyKey } from '../../shared/middleware/idempotency.js';
import {
  AddContactRequestSchema,
  AddDocumentRequestSchema,
  CompareSuppliersQuerySchema,
  ContactIndexParamSchema,
  CreateSupplierRequestSchema,
  DocumentIndexParamSchema,
  ListSuppliersQuerySchema,
  SupplierIdParamSchema,
  UpdateContactRequestSchema,
  UpdateSupplierRequestSchema,
} from './supplier.dto.js';
import { supplierController } from './supplier.controller.js';

export const supplierRouter = Router();

supplierRouter.get(
  '/compare',
  rbacFor('supplier.read'),
  validate(CompareSuppliersQuerySchema, 'query'),
  supplierController.compare,
);

supplierRouter.get(
  '/',
  rbacFor('supplier.read'),
  validate(ListSuppliersQuerySchema, 'query'),
  supplierController.list,
);
supplierRouter.post(
  '/',
  rbacFor('supplier.create'),
  idempotencyKey,
  validate(CreateSupplierRequestSchema),
  supplierController.create,
);
supplierRouter.get(
  '/:id',
  rbacFor('supplier.read'),
  validate(SupplierIdParamSchema, 'params'),
  supplierController.get,
);
supplierRouter.patch(
  '/:id',
  rbacFor('supplier.update'),
  validate(SupplierIdParamSchema, 'params'),
  validate(UpdateSupplierRequestSchema),
  supplierController.update,
);
supplierRouter.delete(
  '/:id',
  rbacFor('supplier.archive'),
  validate(SupplierIdParamSchema, 'params'),
  supplierController.archive,
);

supplierRouter.get(
  '/:id/performance',
  rbacFor('supplier.read'),
  validate(SupplierIdParamSchema, 'params'),
  supplierController.getPerformance,
);

supplierRouter.post(
  '/:id/contacts',
  rbacFor('supplier.update'),
  validate(SupplierIdParamSchema, 'params'),
  validate(AddContactRequestSchema),
  supplierController.addContact,
);
supplierRouter.patch(
  '/:id/contacts/:contactIndex',
  rbacFor('supplier.update'),
  validate(ContactIndexParamSchema, 'params'),
  validate(UpdateContactRequestSchema),
  supplierController.updateContact,
);
supplierRouter.delete(
  '/:id/contacts/:contactIndex',
  rbacFor('supplier.update'),
  validate(ContactIndexParamSchema, 'params'),
  supplierController.removeContact,
);

supplierRouter.post(
  '/:id/documents',
  rbacFor('supplier.update'),
  validate(SupplierIdParamSchema, 'params'),
  validate(AddDocumentRequestSchema),
  supplierController.addDocument,
);
supplierRouter.delete(
  '/:id/documents/:documentIndex',
  rbacFor('supplier.update'),
  validate(DocumentIndexParamSchema, 'params'),
  supplierController.removeDocument,
);
