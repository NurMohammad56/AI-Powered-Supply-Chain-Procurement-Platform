# Postman Collection — Quick start

Two files in this folder:

- `api.collection.json` — every endpoint grouped by module
- `api.environment.json` — environment variables (baseUrl, tokens, IDs)

## Import

In Postman:

1. **File → Import** — drop both files into the dialog.
2. Top-right environment selector → choose **SCP Platform - Local Dev**.
3. Confirm `{{baseUrl}}` is `http://localhost:4000/api/v1`. Change if your API runs elsewhere.

## How tokens get populated

The **`Login`** request (folder *01 - Auth (Public)*) has a test script that auto-saves `accessToken`, `refreshToken`, `tenantId`, `userId` to the environment. Every subsequent request inherits the bearer auth via the collection-level `Authorization: Bearer {{accessToken}}`.

If you're starting from scratch, run **`Register Factory + Owner`** first — same auto-save behaviour.

## How IDs get populated

Other requests with auto-save behaviour:

| Request | Saves |
|---|---|
| `03 - Inventory - Warehouses → Create Warehouse` | `warehouseId` |
| `04 - Inventory - Categories → Create Category` | `categoryId` |
| `05 - Inventory - Items → Create Item` | `itemId` |
| `07 - Suppliers → Create Supplier` | `supplierId` |
| `07 - Suppliers → Create Second Supplier` | `secondSupplierId` |
| `08 - Quotations → Create Quotation Request` | `quotationId` |
| `08 - Quotations → Accept Quotation` | `poId` (the auto-generated PO) |
| `10 - Purchase Orders → Create PO (manual)` | `poId`, `poLineId` |
| `11 - AI - Forecasts → Generate Single Forecast` | `forecastId` |

Other IDs (`notificationId`, second `warehouseId` for transfers, etc.) you set manually after a list call.

## A clean walk-through

This is the order to run the requests for an end-to-end smoke test:

1. **Register Factory + Owner** (or Login if you already have an account)
2. **Create Warehouse** → **Create Category** → **Create Item**
3. **Adjust Stock (positive opening balance)** to seed inventory
4. **Create Supplier** → **Create Second Supplier**
5. **Create Quotation Request** with both suppliers invited
6. (Optional) submit a public quote response — copy the token from the database into `quoteToken`
7. **Compare Quotes** to see deterministic ranking + AI prose
8. **Accept Quotation** → auto-creates a draft PO; saves `poId`
9. **Submit PO for Approval** → **Approve PO** → **Dispatch PO**
10. **Record Receipt** → run twice (50 + 50) to walk `partially_received` → `fully_received`
11. **Close PO**
12. **Generate Single Forecast** → **Get Forecast**
13. **Inventory Turnover / Spend by Supplier / Cash Flow Projection** reports
14. **AI Usage Snapshot** to see token + call counts
15. **List Notifications** to confirm the workflow generated activity feed entries

## Notes

- `Idempotency-Key` is auto-generated per POST via a collection-level pre-request script.
- The webhook URLs use `{{baseUrl}}/../webhooks/...` because the webhook router mounts at `/api/webhooks` (NOT `/api/v1/webhooks`). Edit each webhook request URL if you want absolute paths.
- Public quotation responses require setting `quoteToken` manually — the `responseToken` is treated as PII and not exposed by the GET endpoint.
- The `Refresh Token` endpoint requires the `X-CSRF` header; the env var `csrfToken` defaults to `dev-csrf-token` for local testing.
