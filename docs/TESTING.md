How to test the backend — complete, every-route guide

This is the hands-on testing manual. It is written so that **even if you have never
seen this backend before, you can test every single API in the right order** and
understand _why_ you are hitting each one and _what_ it does.

It has two parts:

- **Part A — Setup** (§1–§7): get Redis, Mongo, `.env`, and the two processes running,
  then import Postman.
- **Part B — The complete route reference** (§8): **every one of the ~92 endpoints**,
  grouped by module, in the order you should test them, each with: what it does, why you
  hit it, the exact request body, what success looks like, the role required, and what it
  depends on.

Plus: §9 AI behaviour, §10 verifying the worker, §11 real-time events, §12 troubleshooting.

> **Base URL:** every `/api/v1/...` path below is relative to
> `http://localhost:4000/api/v1` (the Postman `{{baseUrl}}`). Health checks
> (`/healthz`, `/readyz`) and webhooks live outside `/api/v1` — noted where relevant.

---

# PART A — SETUP

## 1. What you need installed

| Tool                       | Version                   | Why                                                                                    |
| -------------------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| **Node.js**                | 20 LTS (≥20)              | ESM + native `--env-file`. Older Node fails to boot.                                   |
| **npm**                    | 10+                       | Ships with Node 20.                                                                    |
| **MongoDB**                | 7+ (replica set or Atlas) | Persistent state for every collection.                                                 |
| **Redis**                  | 7+                        | Rate limits, BullMQ queues, idempotency + AI cache, token denylist, Socket.io adapter. |
| **Postman**                | latest                    | Hitting the APIs.                                                                      |
| **mongosh** _(optional)_   | 2+                        | Reading the quote response token from Mongo.                                           |
| **Docker** _(recommended)_ | latest                    | Easiest local Mongo + Redis.                                                           |

```bash
node --version    # must be v20.x+
```

## 2. Redis (mandatory — the app will not boot without it)

The code opens **four connections to one Redis server** (cache, queue, sock-pub,
sock-sub) — see [REDIS.md](./REDIS.md). You need one server, not four.

**Docker (recommended):**

```bash
docker run -d --name scp-redis -p 6379:6379 --restart unless-stopped redis:7-alpine
docker exec scp-redis redis-cli PING    # expect PONG
```

`.env`: `REDIS_URL=redis://localhost:6379` and `REDIS_TLS=false`.

**Cloud (Upstash, free):** copy the `rediss://...` URL → set `REDIS_URL=rediss://...`
and `REDIS_TLS=true` (note the double `s` = TLS).

## 3. MongoDB

**Docker (single-node replica set — needed for transactions):**

```bash
docker run -d --name scp-mongo -p 27017:27017 --restart unless-stopped mongo:7 --replSet rs0 --bind_ip_all
docker exec scp-mongo mongosh --eval "rs.initiate()"
```

`.env`: `MONGO_URI=mongodb://localhost:27017/scp_dev?replicaSet=rs0`

**Atlas (free M0):** create cluster → DB user → allow your IP → copy the
`mongodb+srv://...` string into `MONGO_URI`.

## 4. The `.env` (minimum working file)

Create `backend/.env`. Required vars or the app refuses to boot: `MONGO_URI`,
`REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`.

```bash
# Core
NODE_ENV=development
PORT=4000
LOG_LEVEL=debug
GIT_SHA=local

# Database + Redis
MONGO_URI=mongodb://localhost:27017/scp_dev?replicaSet=rs0
MONGO_MAX_POOL_SIZE=20
MONGO_MIN_POOL_SIZE=5
REDIS_URL=redis://localhost:6379
REDIS_TLS=false

# JWT (generate fresh — see below)
JWT_ACCESS_SECRET=PASTE_48_BYTE_SECRET
JWT_REFRESH_SECRET=PASTE_DIFFERENT_48_BYTE_SECRET
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
JWT_ISSUER=scp-platform
JWT_AUDIENCE=scp-platform-clients
BCRYPT_COST=12

# Cookies + CORS (CORS must include your frontend + Socket.io origin)
COOKIE_DOMAIN=localhost
COOKIE_SECURE=false
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
FRONTEND_BASE_URL=http://localhost:3000

# Rate limits (defaults fine)
RATE_LIMIT_UNAUTH_PER_MIN=60
RATE_LIMIT_AUTH_PER_MIN=600
RATE_LIMIT_TENANT_PER_MIN=6000

# Optional services — leave blank to run with safe stubs
RESEND_API_KEY=
GROQ_API_KEY=
GEMINI_API_KEY=
R2_ACCOUNT_ID=
STRIPE_SECRET_KEY=
```

Generate the JWT secrets:

```bash
echo "JWT_ACCESS_SECRET=$(openssl rand -base64 48)"
echo "JWT_REFRESH_SECRET=$(openssl rand -base64 48)"
```

**What happens with blank optional keys:** no `RESEND_API_KEY` → emails are logged, not
sent. No `GROQ_API_KEY`/`GEMINI_API_KEY` → forecasts fall back to a deterministic math
baseline (see §9). No `R2_*` → PDF URLs are `stub://...` but the PDF is still generated.
No `STRIPE_*` → checkout returns 501. **Every endpoint still responds** — nothing 500s.

## 5. Install + start (two terminals, both required)

```bash
cd backend
npm install

# Terminal 1 — API server (HTTP + WebSocket)
npm run dev
#   look for: redis.ready ×4, socket.server_ready, server.listening (port 4000)

# Terminal 2 — background worker (email, forecast, report, scheduled queues)
npm run dev:worker
#   look for: worker.ready  queues=[email,report,forecast,scheduled]
```

Why two? Slow work (AI, PDF, email) runs in the worker so it never blocks API requests.
If the worker is off, endpoints still return instantly but their **side effects**
(a forecast actually computing, an email sending) won't happen. See [BULL.md](./BULL.md).

## 6. Health checks (before Postman)

```bash
curl http://localhost:4000/healthz   # {"status":"ok",...}  liveness only
curl http://localhost:4000/readyz    # {"ok":true,"deps":{"mongo":true,"redis":true}}
```

If `readyz` shows `mongo:false`/`redis:false`, fix that first (§12).

## 7. Import Postman

Files: [`postman/api.collection.json`](../postman/api.collection.json),
[`postman/api.environment.json`](../postman/api.environment.json). See the
[Postman README](../postman/README.md) for the auto-save variable map.

1. **File → Import** both files.
2. Select environment **SCP Platform - Local Dev**.
3. Confirm `{{baseUrl}}` = `http://localhost:4000/api/v1`.

The collection sets `Authorization: Bearer {{accessToken}}` automatically and auto-saves
IDs (`tenantId`, `itemId`, `poId`, …) via test scripts, so you rarely copy-paste.

---

# PART B — THE COMPLETE ROUTE REFERENCE (every endpoint)

## 8.0 How to read this section

Every route below shows:

- **`METHOD /path`** — the endpoint (relative to `{{baseUrl}}`).
- **Role** — the capability required. You register as **Owner**, who can do _everything_,
  so as the default test user all routes pass. The role note tells you which routes a
  _lower_ role (Manager / Warehouse Staff / Viewer) would get **403** on.
- **What & why** — what it does and why you hit it.
- **Body** — exact JSON to send (from the real Zod schemas). GET routes show query params.
- **Works when** — its prerequisites / state requirements.

### The master sequence (run top to bottom)

Most routes depend on data created earlier. This is the dependency order:

```
AUTH (register/login)                         → gets your token
  └─ INVENTORY: warehouse → category → item   → the nouns
       └─ stock adjust (seed balance)         → so forecasts have history
  └─ SUPPLIERS: supplier ×2                    → who you buy from
       └─ QUOTATION (RFQ) → response → compare → accept  → auto-creates a PO
            └─ PURCHASE ORDER: submit→approve→dispatch→receive→close
                 └─ updates inventory, re-triggers forecast
  └─ AI: forecast → get → override → batch → usage
  └─ REPORTS / NOTIFICATIONS / BILLING        → analytics & account (any time after auth)
```

> **Golden rule:** create _nouns_ (warehouse, item, supplier) first, then _workflows_
> (quotation, PO), then _analytics_. Calling a workflow step out of order returns a clear
> state error **by design** — that's the system protecting your data, not a bug.

---

## 8.1 Auth — `/auth`

### Public (no token). Test these first.

**1. `POST /auth/register` — create factory + owner** 🔑 _start here_

- Role: public.
- What & why: creates your tenant (Factory) + an Owner user + a trial subscription, and
  returns tokens. This is the very first call; it auto-saves `accessToken`, `refreshToken`,
  `tenantId`, `userId`.
- Body:

```json
{
  "factory": {
    "name": "Dhaka Denim Ltd",
    "businessType": "rmg",
    "country": "BD",
    "timeZone": "Asia/Dhaka"
  },
  "owner": {
    "fullName": "Owner One",
    "email": "owner@dhakadenim.test",
    "password": "Password123!"
  }
}
```

- Works when: always (email + factory slug must be unique). `businessType` ∈
  `rmg|textile|leather|light_manufacturing|other`. Password ≥10 chars.

**2. `POST /auth/login` — get tokens for an existing user**

- Role: public. Body: `{ "email": "owner@dhakadenim.test", "password": "Password123!" }`
- What & why: re-issues access + refresh tokens. Use it after register, or any time your
  token expires. **Rate-limited**: 5/15min per IP + 10/15min per email.

**3. `POST /auth/refresh` — rotate the access token**

- Role: public, but **requires the `X-CSRF` header** (env `csrfToken`, defaults
  `dev-csrf-token`) and the refresh cookie/token. Body: `{}` (empty).
- What & why: get a fresh access token without logging in. Each refresh **rotates** the
  refresh token; presenting an old (already-rotated) one trips reuse-detection and
  **kills the whole token family** → you must log in again. (Great to test security.)

**4. `POST /auth/logout` — clear the refresh cookie**

- Role: public. Body: `{}`. Invalidates the current refresh session.

**5. `POST /auth/forgot-password` — start reset**

- Role: public. Body: `{ "email": "owner@dhakadenim.test" }`. Always returns 200 (never
  reveals if the email exists). Emails a reset token (worker must run to actually send).

**6. `POST /auth/reset-password` — finish reset**

- Role: public. Body: `{ "token": "<from email>", "newPassword": "NewPassword123!" }`.
  Works only with a valid, unexpired token.

**7. `POST /auth/verify-email` — confirm address**

- Role: public. Body: `{ "token": "<from registration email>" }`.

### Private (token required).

**8. `GET /auth/me` — current user + factory**

- Role: any authenticated. Why: confirms your token works and shows your context. Good
  smoke test right after register.

**9. `PATCH /auth/me` — update your own profile / notification prefs**

- Role: any. Body (all optional):

```json
{
  "fullName": "Owner Renamed",
  "notificationPrefs": { "lowStock": { "email": true, "inApp": true } }
}
```

**10. `POST /auth/change-password` — change your own password**

- Role: any. Body: `{ "currentPassword": "Password123!", "newPassword": "Password456!" }`
  (current password is verified).

**11. `GET /auth/users` — list team members**

- Role: **`user.invite`** (Owner, Manager). Query: `?limit=20&role=manager&status=active`.

**12. `POST /auth/invite` — invite a user by email**

- Role: **`user.invite`** (Owner, Manager). Body:

```json
{
  "email": "manager@dhakadenim.test",
  "fullName": "Manager One",
  "role": "manager"
}
```

- Roles: `owner|manager|warehouse_staff|viewer`. A Manager can only invite manager-or-lower.

**13. `PATCH /auth/users/:userId/role` — change someone's role**

- Role: **`user.role.assign`** (**Owner only**). Body: `{ "role": "warehouse_staff" }`.
  Guards: can't demote the last Owner, can't change your own role.

**14. `DELETE /auth/users/:userId` — disable a user**

- Role: **`user.role.assign`** (Owner only). Disables (not hard-deletes) the user.

**15. `POST /auth/logout-everywhere` — revoke all your sessions**

- Role: any. Body: `{}`. Denylists your access tokens (Redis watermark) + kills all
  refresh sessions. After this, `GET /auth/me` with the old token returns 401 — proving
  the denylist works. Then `POST /auth/login` to get fresh tokens.

---

## 8.2 Inventory — `/inventory`

> Create order: **warehouse → category → item → seed stock**.

### Warehouses

**16. `GET /inventory/warehouses` — list** · Role `inventory.item.read` (all) ·
Query `?limit=20&isActive=true&q=main`.

**17. `POST /inventory/warehouses` — create** 🔑 · Role **`inventory.warehouse.manage`
(Owner only — Manager gets 403 here)** · auto-saves `warehouseId`. Body:

```json
{
  "name": "Main Warehouse",
  "code": "WH1",
  "address": { "street": "Plot 1", "city": "Dhaka", "country": "BD" },
  "isActive": true
}
```

Why: stock must live in a warehouse, so this comes before items/stock.

**18. `GET /inventory/warehouses/:id` — get one** · Role `inventory.item.read`.

**19. `PATCH /inventory/warehouses/:id` — update** · Role `inventory.warehouse.manage`
(Owner). Body: any subset, e.g. `{ "name": "Main WH (renamed)" }`.

**20. `DELETE /inventory/warehouses/:id` — archive** · Role `inventory.warehouse.manage`
(Owner). Soft-delete (sets `archivedAt`).

### Categories

**21. `GET /inventory/categories` — list** · `inventory.item.read` · `?limit=20&q=fabric`.

**22. `POST /inventory/categories` — create** · Role **`inventory.item.create`** (Owner,
Manager) · auto-saves `categoryId`. Body:

```json
{ "name": "Raw Fabric", "description": "Cotton & blends" }
```

**23. `GET /inventory/categories/:id`** · read. ·
**24. `PATCH /inventory/categories/:id`** · `inventory.item.update` · Body `{ "name": "..." }`. ·
**25. `DELETE /inventory/categories/:id`** · `inventory.item.archive`.

### Low-stock & bulk (declared before `/items/:id` so the paths don't clash)

**26. `GET /inventory/low-stock` — items below reorder level** · `inventory.item.read` ·
`?limit=20&warehouseId={{warehouseId}}`. Returns rows only once something is actually low.

**27. `POST /inventory/bulk-import` — create many items at once** · Role
`inventory.item.create`. Body:

```json
{
  "atomic": true,
  "items": [
    {
      "sku": "COTTON-001",
      "name": "Raw Cotton",
      "unit": "kg",
      "type": "raw_material",
      "reorderLevel": 100,
      "openingBalance": {
        "warehouseCode": "WH1",
        "quantity": 500,
        "unitCost": 2.5
      }
    }
  ]
}
```

`atomic:true` = abort on first bad row; `false` = skip bad rows, import the rest.

### Items

**28. `GET /inventory/items` — list/filter** · read · `?limit=20&type=raw_material&q=cotton`.

**29. `POST /inventory/items` — create** 🔑 · Role `inventory.item.create` · auto-saves
`itemId`. Body:

```json
{
  "sku": "COTTON-001",
  "name": "Raw Cotton",
  "unit": "kg",
  "type": "raw_material",
  "categoryId": "{{categoryId}}",
  "reorderLevel": 100,
  "currency": "BDT"
}
```

`unit` and `type` are enums (e.g. type ∈ `raw_material|finished_good|packaging|consumable`).
SKU is auto-uppercased and unique **per tenant** (two factories may share a SKU).

**30. `GET /inventory/items/:id`** · read. ·
**31. `PATCH /inventory/items/:id`** · `inventory.item.update` · Body any subset, e.g.
`{ "reorderLevel": 150 }`. ·
**32. `DELETE /inventory/items/:id`** · `inventory.item.archive` (item stays in history).

### Item-scoped stock operations

**33. `POST /inventory/items/:id/adjust` — change stock (+/−)** 🔑 · Role
**`inventory.movement.create`** (Owner, Manager, **Warehouse Staff**). Body (seed opening
balance):

```json
{
  "warehouseId": "{{warehouseId}}",
  "quantityDelta": 500,
  "reasonCode": "opening",
  "notes": "Opening stock"
}
```

Why this matters: it writes the first **StockMovement** (append-only ledger) and upserts
the **StockBalance**. **Forecasts read movement history**, so seed stock here before §8.6.
`quantityDelta` is signed (negative = decrease, e.g. `count_correction`); must be non-zero.

**34. `POST /inventory/items/:id/transfer` — move stock between warehouses** · Role
`inventory.movement.create`. Body:

```json
{
  "fromWarehouseId": "{{warehouseId}}",
  "toWarehouseId": "{{warehouseId2}}",
  "quantity": 50
}
```

Needs a **second** warehouse (create one, set `warehouseId2` manually) and enough source
balance.

**35. `GET /inventory/items/:id/history` — movement ledger** · read · `?limit=50&type=adjustment`.
Append-only; shows every in/out.

**36. `GET /inventory/items/:id/balances` — current qty per warehouse** · read.

---

## 8.3 Suppliers — `/suppliers`

**37. `GET /suppliers/compare` — compare 2–5 suppliers** · Role `supplier.read` ·
`?ids={{supplierId}},{{secondSupplierId}}`. (Declared first so it doesn't clash with `/:id`.)

**38. `GET /suppliers` — list** · read · `?limit=20&status=active&tier=preferred`.

**39. `POST /suppliers` — create** 🔑 · Role **`supplier.create`** (Owner, Manager) ·
auto-saves `supplierId`. Body:

```json
{
  "legalName": "Cotton Source Co",
  "tradingName": "CottonSrc",
  "status": "active",
  "paymentTermsDays": 30,
  "leadTimeDays": 14,
  "tier": "preferred",
  "contacts": [
    { "name": "Sales Rep", "email": "sales@cottonsrc.test", "isPrimary": true }
  ]
}
```

**39b. Create a _second_ supplier** (run #39 again with a different `legalName`/email) →
auto-saves `secondSupplierId`. Needed so quote comparison has ≥2 offers.

**40. `GET /suppliers/:id`** · read. ·
**41. `PATCH /suppliers/:id`** · `supplier.update` · Body any subset, e.g. `{ "leadTimeDays": 10 }`. ·
**42. `DELETE /suppliers/:id`** · `supplier.archive` · soft-delete.

**43. `GET /suppliers/:id/performance` — on-time rate, scoring** · read. Meaningful only
after POs exist; early on returns mostly nulls + `sampleSize: 0`.

**44. `POST /suppliers/:id/contacts` — add a contact** · `supplier.update`. Body:

```json
{
  "name": "Logistics Lead",
  "email": "logi@cottonsrc.test",
  "phone": "+8801...",
  "isPrimary": false
}
```

**45. `PATCH /suppliers/:id/contacts/:contactIndex` — edit contact by array index** ·
`supplier.update` · e.g. `/contacts/0`. Body: any subset of the contact fields. Contacts
are an embedded array edited **by position (0,1,2…)**, not by id.

**46. `DELETE /suppliers/:id/contacts/:contactIndex` — remove contact by index** · `supplier.update`.

**47. `POST /suppliers/:id/documents` — attach a document** · `supplier.update`. Body:

```json
{ "kind": "contract", "url": "https://example.com/contract.pdf" }
```

`kind` ∈ `contract|cert|nda|invoice|other`.

**48. `DELETE /suppliers/:id/documents/:documentIndex` — remove document by index** · `supplier.update`.

---

## 8.4 Quotations (RFQ) — `/quotations` + public response

> Flow/state: `open → (accepted | cancelled/closed)`.

**49. `GET /quotations` — list** · Role `supplier.read` · `?limit=20&status=open`.

**50. `POST /quotations` — create an RFQ** 🔑 · Role **`supplier.quote.send`** (Owner,
Manager) · auto-saves `quotationId`. Body:

```json
{
  "validUntil": "2026-12-31T23:59:59Z",
  "lines": [{ "itemId": "{{itemId}}", "quantity": 1000 }],
  "invitedSuppliers": [
    { "supplierId": "{{supplierId}}", "contactEmail": "sales@cottonsrc.test" },
    { "supplierId": "{{secondSupplierId}}", "contactEmail": "sales@other.test" }
  ]
}
```

What happens: an RFQ opens, each invited supplier gets a one-time response **token**
(emailed), and a **scheduled expiry job** is enqueued for `validUntil`.

**51. `GET /quotations/:id` — read RFQ** · read. Note: the response **token is PII and is
NOT returned** here. The Postman test script extracts it for you; otherwise harvest from
Mongo (see below).

**52. `POST /quotations/:id/cancel` — cancel an open RFQ** · Role `supplier.quote.send` ·
Body `{}`. Works only while `open`.

**53. `POST /quotations/:id/accept` — pick a supplier → auto-create a draft PO** 🔑 · Role
`supplier.quote.send` · auto-saves `poId`. Body: `{ "supplierId": "{{supplierId}}" }`.
Works only while `open`. **This is where quotation → PO connects.**

**54. `GET /quotations/:id/compare` — ranking + AI prose** · Role `supplier.read`.
Returns suppliers ranked by real numbers (total cost, lead time) + an AI text summary.
Most useful **after** suppliers respond. With no AI key → `aiSummary: null`, ranking still
works. The AI never picks the supplier — it only explains.

**55. `POST /public/quotations/responses/:token` — supplier submits their quote (NO JWT)** ·
public, token-gated. Path uses `{{quoteToken}}`. Body:

```json
{
  "lines": [
    {
      "itemId": "{{itemId}}",
      "unitPrice": 2.6,
      "currency": "BDT",
      "moq": 100,
      "leadTimeDays": 12,
      "validityDays": 30
    }
  ],
  "comments": "Best price for bulk"
}
```

Works only while the RFQ is `open` and before `validUntil`. **Harvest the token** if not
auto-saved:

```bash
mongosh "$MONGO_URI" --eval 'db.quotationrequests.findOne({}, { supplierInvitations: 1 })'
```

Copy a `responseToken` → env `quoteToken`. (Run once per supplier to make `compare` meaningful.)

---

## 8.5 Purchase Orders — `/purchase-orders`

> State machine (each step works **only** from the listed state):
> `draft → pending_approval → approved → sent → partially_received → fully_received → closed`
> with `reject` (→rejected→draft) and `cancel` (→cancelled) branches.

**56. `GET /purchase-orders` — list** · Role `po.read` · `?limit=20&state=draft&supplierId=...`.

**57. `POST /purchase-orders` — create a PO manually** · Role **`po.create`** (Owner,
Manager) · auto-saves `poId`, `poLineId`. Body:

```json
{
  "supplierId": "{{supplierId}}",
  "warehouseId": "{{warehouseId}}",
  "currency": "BDT",
  "paymentTermsDays": 30,
  "expectedDeliveryAt": "2026-09-01T00:00:00Z",
  "taxRate": 0.0,
  "lines": [
    { "itemId": "{{itemId}}", "quantityOrdered": 100, "unitPrice": 2.5 }
  ]
}
```

(Or skip this — `Accept Quotation` already made a draft PO.)

**58. `POST /purchase-orders/from-forecast` — AI-suggested PO** · Role `po.create`. Body:

```json
{
  "itemId": "{{itemId}}",
  "warehouseId": "{{warehouseId}}",
  "expectedDeliveryAt": "2026-09-01T00:00:00Z"
}
```

Builds a draft PO using the item's latest forecast for the quantity. Needs a forecast to exist.

**59. `GET /purchase-orders/:id` — get one** · `po.read`. Re-fetch after each transition to
see `state`, `pdfUrl`, etc.

**60. `PATCH /purchase-orders/:id` — edit** · Role `po.update` · **only when `draft` or
`rejected`**. Body: any subset of create fields (lines, dates, taxRate…).

**61. `POST /purchase-orders/:id/submit` — draft → pending_approval** · Role `po.submit` ·
Body `{}`. Emails approvers.

**62. `POST /purchase-orders/:id/approve` — pending_approval → approved** · Role
`po.approve` (Manager is **monetary-threshold-capped**; above the cap only Owner). Body:
`{ "thresholdRule": "auto" }` (optional). Background: PDF render + upload.

**63. `POST /purchase-orders/:id/reject` — pending_approval → rejected** · Role `po.reject` ·
Body `{ "reason": "Budget exceeded" }`. Rejected PO can be edited back to draft.

**64. `POST /purchase-orders/:id/dispatch` — approved → sent** · Role `po.dispatch` · Body
`{ "sentTo": "sales@cottonsrc.test" }`. Generates/sends the PDF to the supplier, schedules
a 7-day-overdue check. (`/:id/send` is the identical canonical alias — #69.)

**65. `POST /purchase-orders/:id/cancel` — any pre-closed state → cancelled** · Role
`po.cancel` · Body `{ "reason": "No longer needed" }`.

**66. `POST /purchase-orders/:id/close` — fully_received → closed** · Role `po.update` ·
Body `{}`. Terminal state.

**67. `POST /purchase-orders/:id/receipts` — record a delivery (partial/full)** 🔑 · Role
**`po.receive`** (incl. Warehouse Staff) · works from `sent`/`partially_received`. Body:

```json
{
  "warehouseId": "{{warehouseId}}",
  "lines": [
    { "poLineId": "{{poLineId}}", "itemId": "{{itemId}}", "quantity": 50 }
  ],
  "grnDocumentUrl": null,
  "notes": "First half"
}
```

Run **twice** (50 + 50 against a qty-100 line): first → `partially_received`, second →
`fully_received`. Each receipt **increases inventory, clears low-stock, and re-triggers a
forecast**. Over-receiving (more than remaining) is rejected.

**68. `GET /purchase-orders/:id/receipts` — list receipts for a PO** · `po.read`.

**69. `POST /purchase-orders/:id/send` — canonical dispatch (alias of #64)** · Role
`po.dispatch` · Body `{ "sentTo": "sales@cottonsrc.test" }`.

**70. `GET /purchase-orders/:id/pdf` — get a download URL for the PO PDF** · `po.read`.
Re-presigns the R2 URL (or generates on demand). Returns `stub://...` if R2 isn't configured.

> **Try the safety nets:** (a) Approve a still-`draft` PO → `PO_INVALID_STATE_TRANSITION`.
> (b) Open two tabs, Approve simultaneously after submit → one 200, one `PO_STATE_RACE`.

---

## 8.6 AI Forecasts — `/ai`

> Needs an item **with stock-movement history** (you seeded it in #33). Worker must run
> for the **batch** route to actually compute.

**71. `GET /ai/forecasts` — list** · Role `ai.forecast.generate` · `?limit=20&itemId=...&horizonDays=30`.

**72. `POST /ai/forecasts` — generate one forecast** 🔑 · Role `ai.forecast.generate` ·
auto-saves `forecastId`. Body:

```json
{ "itemId": "{{itemId}}", "horizonDays": 30 }
```

`horizonDays` ∈ `7|14|30|60|90`. **Rate-limited** 10/min per tenant; a 2nd call for the
same item within 6h returns the cached result (Redis). Runs synchronously (no worker
needed), but calls the real LLM if keys are set.

**73. `GET /ai/forecasts/:id` — get one** · read. Shows full `provenance` (provider, model,
latency, tokens, cacheHit, failoverInvoked).

**74. `POST /ai/forecasts/:id/override` — human corrects the number** · Role
**`ai.forecast.override`** (Owner, Manager) · audited. Body:

```json
{ "quantity": 1200, "justification": "Known seasonal spike for Eid orders" }
```

**75. `POST /ai/forecasts/batch` — forecast many items (async)** · Role
`ai.forecast.generate`. Body (omit `itemIds` to forecast all non-archived items):

```json
{ "itemIds": ["{{itemId}}"] }
```

Returns `{ batchJobId, itemCount, estimatedCostUsd }` immediately; the **worker** processes
it and streams Socket.io progress (see §11). Checks your monthly quota first.

**76. `GET /ai/usage` — quota snapshot** · read. Shows tokens/forecast-calls/report-calls
used vs your tier cap, plus estimated cost USD.

---

## 8.7 Reports (Analytics) — `/reports`

All read-only aggregations (no AI, no writes). Role **`rpt.read`** (Owner, Manager,
Viewer — not Warehouse Staff). Numbers are only interesting after you have movements + POs.

**77. `GET /reports/inventory-turnover`** · `?from=2026-01-01T00:00:00Z&to=2026-06-30T23:59:59Z`
(both required, ISO datetime).
**78. `GET /reports/spend-by-supplier`** · same `from`/`to`.
**79. `GET /reports/supplier-cost-comparison`** · same `from`/`to`.
**80. `GET /reports/cash-flow-projection`** · **no params** (projects forward from open POs).
**81. `GET /reports/dead-stock`** · same `from`/`to` (items with no movement in range).

---

## 8.8 Notifications — `/notifications`

No special role (any authenticated user; feed is per-user).

**82. `GET /notifications` — list** · `?limit=20&unreadOnly=true&category=...`. Populated as
the workflow fires events (PO submitted/approved, low stock, etc.).
**83. `GET /notifications/unread-count` — badge count** · returns `{ count }`.
**84. `POST /notifications/mark-read` — mark read** · Body is **either** specific ids **or**
all:

```json
{ "ids": ["{{notificationId}}"] }
```

or `{ "all": true }`. (Copy a `notificationId` from #82 into the env to test the ids form.)

---

## 8.9 Billing — `/billing`

**85. `GET /billing/plans` — plan catalogue** · **no role** (public-ish). Lists tiers +
prices + seat limits.
**86. `GET /billing/subscription` — current subscription** · Role **`billing.read`**
(**Owner only** — Manager gets 403). Shows tier, status, seats, trial end.
**87. `POST /billing/checkout-session` — start payment** · Role
`billing.subscription.change` (Owner). Body:

```json
{
  "tier": "starter",
  "gateway": "stripe",
  "successUrl": "https://app.test/ok",
  "cancelUrl": "https://app.test/cancel"
}
```

⚠️ **Returns 501 NotImplemented today** — the payment gateway isn't wired yet.
**88. `POST /billing/subscription/change` — schedule a tier change** · Owner · Body
`{ "tier": "growth" }`. Applies at period end.
**89. `POST /billing/subscription/cancel` — cancel** · Owner · Body
`{ "cancelImmediately": false }` (default = cancel at period end).
**90. `GET /billing/invoices` — list invoices** · Role `billing.read` (Owner) ·
`?limit=20&status=paid`.

---

## 8.10 Webhooks — `/webhooks` (public, no JWT)

Inbound payment-gateway callbacks. They verify a signature on the **raw** body, so a
hand-made request without a valid signature is rejected (expected).

**91. `POST /webhooks/stripe`** · **92. `POST /webhooks/sslcommerz`**.

> ⚠️ **Path note:** these mount at **`{{baseUrl}}/webhooks/...`** (i.e.
> `http://localhost:4000/api/v1/webhooks/...`). The Postman collection uses
> `{{baseUrl}}/../webhooks/...` which resolves to `/api/webhooks/...` and will 404 — fix
> the request URL to `{{baseUrl}}/webhooks/stripe`. These are currently **stubs** (they
> audit-log but don't verify signatures yet).

---

## 8.11 Health (outside `/api/v1`)

- `GET http://localhost:4000/healthz` — liveness (process up). No auth.
- `GET http://localhost:4000/readyz` — readiness (Mongo + Redis reachable). Returns 503 if
  a dependency is down. Use these in load-balancer/Kubernetes probes.

---

# §9–§12 — Behaviour, worker, real-time, troubleshooting

## 9. How AI behaves (with / without keys)

| Keys set               | Forecast (`POST /ai/forecasts`)                                                                     | Quote compare                           | Weekly report                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------- |
| **None**               | Groq→Gemini both skipped → **deterministic baseline**, `confidence: "low"`, `failoverInvoked: true` | numeric ranking only, `aiSummary: null` | text step fails → no email until a key is set |
| **Groq only**          | succeeds via Groq; breaker-trip → baseline                                                          | full AI prose                           | works                                         |
| **Both** (recommended) | Groq, falls back to Gemini on error                                                                 | full                                    | works                                         |
| **Gemini only**        | Groq skipped → Gemini handles all                                                                   | full                                    | works                                         |

Every forecast (AI or baseline) is persisted with `provenance` (provider, model, latency,
tokens, cacheHit) + truncated `rawPrompt`/`rawResponse` for audit. Before each call,
`checkQuota` enforces the tenant's monthly tier cap and **rejects with `AI_QUOTA_EXCEEDED`
before** spending money. After a PO receipt, a forecast re-trigger is enqueued unless a
forecast for that item is <6h old (avoids spamming a 200-line delivery).

## 10. Verify the worker is doing its job

Watch **Terminal 2** while testing PO receipt (#67) and batch forecast (#75):

```
{"event":"forecast.single.start","itemId":"..."}
{"event":"forecast.single.complete","forecastId":"..."}
{"event":"forecast.batch.complete","total":1,"succeeded":1,"failed":0}
{"event":"email.sent",...}
```

Silent worker → it isn't running (`npm run dev:worker`), or its `REDIS_URL` differs from
the API's. Inspect a stuck queue: `redis-cli LRANGE bull:forecast:wait 0 -1`. Dev reset:
`redis-cli FLUSHDB` (wipes queues, rate-limit counters, caches — never in prod).

## 11. Testing real-time events (WebSocket)

Postman can't do Socket.io. Use the browser console or a client (see [SOCKET.md](./SOCKET.md)
for the full event catalog). Quick check:

```js
const s = io("http://localhost:4000", {
  path: "/realtime",
  transports: ["websocket"],
  auth: { token: "<accessToken>" },
});
s.onAny((e, ...a) => console.log("EVENT", e, a));
```

Then run #67 or #75. Live events today: `system.connected`, `ai.forecast.completed`,
`ai.forecast.batch.progress`, `ai.forecast.batch.completed`. (Others like
`po.state.changed`, `notification.created` are defined but not emitted yet — see SOCKET.md.)

## 12. Troubleshooting

| Symptom                                         | Cause / fix                                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `MONGO_URI/REDIS_URL is required` at boot       | `.env` missing/typo. File at `backend/.env`, no spaces around `=`.                                                   |
| `readyz` → `mongo:false`                        | Mongo down, wrong URI, or replica set not initiated (`rs.initiate()`).                                               |
| `readyz` → `redis:false`                        | Redis down, wrong URL, or TLS mismatch (Upstash needs `rediss://` + `REDIS_TLS=true`).                               |
| `401 AUTH_TOKEN_MISSING` everywhere             | No/expired `accessToken` → run Login (#2). Postman env not selected.                                                 |
| `403 Forbidden`                                 | Your role lacks that capability — see the Role note on the route (e.g. warehouse create & all billing = Owner only). |
| `404` on an id you "know" exists                | Wrong/empty id variable, or it belongs to another tenant (cross-tenant → 404 by design).                             |
| `PO_INVALID_STATE_TRANSITION` / `PO_STATE_RACE` | You called a PO step from the wrong state, or two writers raced. Check current `state` via #59.                      |
| `429 RATE_LIMITED`                              | Hit a limit (login 5/15min; AI 10/min). Wait, or `redis-cli FLUSHDB` (dev).                                          |
| `AUTH_REFRESH_REUSE_DETECTED`                   | You reused an already-rotated refresh token → family revoked → Login again.                                          |
| Forecast always generic reasoning               | No AI keys → deterministic baseline. Add `GROQ_API_KEY` or `GEMINI_API_KEY` + restart.                               |
| Batch forecast / emails do nothing              | Worker (`npm run dev:worker`) isn't running.                                                                         |
| Webhook returns 404                             | Use `{{baseUrl}}/webhooks/...` (the collection's `/../webhooks` is wrong).                                           |
| `400 VALIDATION_FAILED`                         | Response `details` lists the exact Zod field that failed (missing field, wrong type, bad enum).                      |

---

## Appendix — route count by module

| Module          | Routes                    | Highlights                                                                   |
| --------------- | ------------------------- | ---------------------------------------------------------------------------- |
| Auth            | 15 (7 public + 8 private) | register, login, refresh, users, roles                                       |
| Inventory       | 21                        | warehouses (5), categories (5), low-stock+bulk (2), items (5), stock ops (4) |
| Suppliers       | 12                        | CRUD, compare, performance, contacts/docs by index                           |
| Quotations      | 7 (6 private + 1 public)  | RFQ, response (token), compare, accept→PO                                    |
| Purchase Orders | 15                        | full state machine + receipts + pdf + from-forecast                          |
| AI              | 6                         | forecast, override, batch, usage                                             |
| Reports         | 5                         | turnover, spend, cost-compare, cash-flow, dead-stock                         |
| Notifications   | 3                         | list, unread-count, mark-read                                                |
| Billing         | 6                         | plans, subscription, change/cancel, invoices                                 |
| Webhooks        | 2                         | stripe, sslcommerz (stubs)                                                   |
| Health          | 2                         | healthz, readyz                                                              |
| **Total**       | **~94**                   | every one documented above                                                   |

Follow §8 top-to-bottom and you will have exercised **every endpoint** in the backend,
plus tenant isolation, RBAC, the PO state machine, BullMQ workers, the AI pipeline with
fallback, idempotency, rate limiting, and Socket.io events.
</content>
