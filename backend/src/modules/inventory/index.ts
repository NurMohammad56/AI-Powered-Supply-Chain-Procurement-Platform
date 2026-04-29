/**
 * Public surface of the inventory module. Cross-module imports must come
 * through this barrel only.
 */

export {
  Warehouse,
  type WarehouseDoc,
  type WarehouseHydrated,
  type WarehouseAddress,
} from './models/warehouse.model.js';

export {
  ItemCategory,
  type ItemCategoryDoc,
  type ItemCategoryHydrated,
} from './models/itemCategory.model.js';

export {
  Item,
  ITEM_UNITS,
  ITEM_TYPES,
  type ItemDoc,
  type ItemHydrated,
  type ItemUnit,
  type ItemType,
  type ItemCurrency,
} from './models/item.model.js';

export {
  StockBalance,
  type StockBalanceDoc,
  type StockBalanceHydrated,
} from './models/stockBalance.model.js';

export {
  StockMovement,
  STOCK_MOVEMENT_TYPES,
  type StockMovementDoc,
  type StockMovementHydrated,
  type StockMovementType,
  type StockMovementReference,
  type StockMovementReferenceKind,
} from './models/stockMovement.model.js';
