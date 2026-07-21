# How the backend is built — architecture deep dive

This is the explanatory companion to [BACKEND.md](BACKEND.md). Where the reference doc tells you *what* exists, this one tells you *how* it works, *why* it's shaped that way, and *how every piece connects to every other piece* — including the AI layer that sits at the centre of the product.

Read this once and you can explain the entire system to a recruiter, a customer, or a new engineer without reading any code.

## Table of contents

1. [The mental model in one paragraph](#1-the-mental-model)
2. [How the codebase is organised](#2-how-the-codebase-is-organised)
3. [Anatomy of one module (vertical slice)](#3-anatomy-of-one-module)
4. [The four-layer pattern inside every module](#4-the-four-layer-pattern)
5. [The multi-tenant boundary, demonstrated](#5-the-multi-tenant-boundary)
6. [The journey of one HTTP request](#6-the-journey-of-one-http-request)
7. [The journey of one inventory item](#7-the-journey-of-one-inventory-item)
8. [The journey of one purchase order](#8-the-journey-of-one-purchase-order)
9. [Where AI plugs in (the five integration points)](#9-where-ai-plugs-in)
10. [Background processing: what happens off the request thread](#10-background-processing)
11. [Real-time updates: how the dashboard stays live](#11-real-time-updates)
12. [The audit log: the only durable cross-module trail](#12-the-audit-log)
13. [The wiring diagram: everything in one picture](#13-the-wiring-diagram)
14. [Three end-to-end scenarios traced through the system](#14-three-end-to-end-scenarios)

---

## 1. The mental model

> The backend is a **multi-tenant Node.js system that turns a factory's day-to-day procurement and inventory data into AI-powered decisions**. It runs as **two processes**: an Express API + WebSocket server that serves real-time dashboards, and a worker process that drains background queues for emails, AI forecasts, and weekly reports. Everything a tenant sees, everything they do, and every AI inference they consume is gated by **three layers of tenant isolation**, **a capability-based permission matrix**, and **a cost-aware AI quota system** — all woven through a vertical-slice modular monolith where each domain (auth, inventory, suppliers, POs, AI, billing) owns its own DTOs, business logic, persistence, and HTTP surface.

Everything in this document is an elaboration of that paragraph.

---

## 2. How the codebase is organised

There are **two top-level entry points**:

```
src/
├── server.ts          ← HTTP API + Socket.io (the "online" process)
├── worker.ts          ← BullMQ workers (the "offline" process)
├── app.ts             ← Express app FACTORY (no port binding — testable)
├── routes.ts          ← top-level router; mounts every module's router
├── config/            ← env, logger, redis, database — boot-time wiring
├── modules/           ← one folder per business domain (vertical slice)
└── shared/            ← cross-cutting infrastructure (auth, audit, queues, ...)
```

### Why two processes, not one?

Because PDF rendering, AI inference, and email delivery are all **slow** (seconds to minutes). If they shared CPU with the request thread, a single batch forecast could starve the entire dashboard. The split is enforced by the SDD §5.6:

- `server.ts` does HTTP and WebSocket only — no BullMQ workers attached.
- `worker.ts` connects to Mongo + Redis and spins up **four workers** (`email`, `report`, `forecast`, `scheduled`) that pull from queues. No HTTP listener.

Both processes import from the same `src/modules/...` code, so business logic is written once. The separation is purely about **runtime resource isolation**.

### Why a modular monolith, not microservices?

For a 500-tenant SaaS this is the right choice (SDD §2). Cross-module calls are direct function calls (zero RPC latency), database joins work, transactions are possible, deploys are atomic. The tradeoff is that scaling one hot module requires scaling the whole API — but at this size and with the worker offload, that's not yet a constraint.

The "modular" part is enforced by **`eslint-plugin-boundaries`**: each module has an `index.ts` barrel that defines its public surface. ESLint will literally fail the build if `modules/po/po.service.ts` imports from `modules/inventory/inventory.repository.ts` instead of `modules/inventory/index.ts`. This keeps coupling explicit and refactor-safe.

### Why Express + Mongoose, not Fastify + Prisma?

- **Express** is the most boring choice and that's the point — every Stack Overflow answer applies. Performance is adequate for the workload (each tenant generates dozens of requests/minute, not thousands).
- **Mongoose** lets us attach **plugins** that run on every query (`tenancyPlugin` is the workhorse — see §5). Prisma can do this too but is less ergonomic for the "auto-inject tenantId on every save" pattern.

---

## 3. Anatomy of one module

Every module under `src/modules/<name>/` follows the **same five-file vertical slice**:

```
modules/inventory/
├── index.ts              ← public surface (only exports what other modules can import)
├── inventory.dto.ts      ← Zod schemas + view interfaces (request + response shapes)
├── inventory.repository.ts ← Mongoose queries; the only file that touches the DB
├── inventory.service.ts  ← business logic; calls the repo + emits side effects
├── inventory.controller.ts ← HTTP handlers (asyncHandler-wrapped)
├── inventory.routes.ts   ← Express router; wires capability + validation middleware
└── models/               ← Mongoose schemas (the only files allowed to declare a Schema)
    ├── item.model.ts
    ├── itemCategory.model.ts
    ├── stockBalance.model.ts
    ├── stockMovement.model.ts
    └── warehouse.model.ts
```

Why this shape?

- **One responsibility per file.** When something breaks you know which file to open. "Validation failed?" → `dto.ts`. "Wrong query?" → `repository.ts`. "Wrong status code?" → `controller.ts`. "Missing audit?" → `service.ts`.
- **Reads and writes go through the same repository layer.** Aggregation pipelines that span modules live in dedicated `*.aggregations.ts` files (e.g. `rpt.aggregations.ts`).
- **Models don't know about HTTP, services don't know about Mongoose internals, controllers don't know about validation.** Each layer can be tested in isolation.

Modules currently shipped: **auth, inventory, supplier, po, ai, rpt (reports), notification, billing**. That's the entire business surface area.

---

## 4. The four-layer pattern

Inside each module, every endpoint walks the same four layers:

```
HTTP request                  
   │
   │  validate(schema, 'body' | 'params' | 'query')   ← Zod runs FIRST; bad input
   │                                                    never reaches your code
   ▼
Controller (controller.ts)
   │
   │  thin wrapper around asyncHandler:
   │  - extract tenant context via requireContext(req)
   │  - parse path params / query params
   │  - call the service
   │  - return ok() / created() / paginated() / noContent()
   ▼
Service (service.ts)
   │
   │  ALL the business logic:
   │  - assertTenantOwns guards on every fetched doc (IDOR prevention)
   │  - state machine checks (canTransition for POs, etc.)
   │  - cross-module calls (inventory.service.adjustStock invoked from po.service)
   │  - side-effect orchestration: enqueue email, emit socket, recordAudit
   ▼
Repository (repository.ts)
   │
   │  Mongoose queries only. ALWAYS .lean() on reads.
   │  No business logic, no side effects.
   │  CAS state transitions live here (findOneAndUpdate with state guard).
   ▼
Model (models/*.model.ts)
   │
   │  Schema + indexes + plugins.
   │  tenancyPlugin auto-injects tenantId on every query and save.
   │  softDeletePlugin / auditPlugin compose on top.
```

This is not arbitrary layering — it gives you four distinct seams where you can test, swap, or mock. The unit-test target is the service layer (mock the repo). The integration-test target is the controller (real Mongo + Redis).

---

## 5. The multi-tenant boundary

This is the most important section in the document. Multi-tenancy is the feature that **could leak data between factories** if implemented carelessly. The system has **three control points** (SDD §2.4) and you must understand all three to trust any endpoint.

### Control point 1: tenant context comes only from the JWT

```ts
// shared/middleware/tenant.ts (paraphrased)
export const resolveTenant: RequestHandler = (req, _res, next) => {
  const token = req.header('authorization')?.slice('Bearer '.length);
  const claims = verifyAccessToken(token);

  // Fast-path revocation: O(1) Redis check.
  if (await isAccessTokenDenied({ jti, userId, issuedAtSec })) {
    return next(new UnauthorizedError(...));
  }

  req.context = {
    tenantId: new Types.ObjectId(claims.tenantId),  // ← from JWT, not body/header/query
    userId: new Types.ObjectId(claims.sub),
    role: claims.role,
    subscriptionTier: claims.tier,
    seats: claims.seats,
    features: new Set(claims.features ?? []),
    requestId: getRequestId(req) ?? '',
  };
  next();
};
```

**The rule, repeated until it sticks:** the only place `tenantId` is allowed to come from is the JWT. Never the request body, never a query param, never an HTTP header. Any endpoint that accepts a `tenantId` from the client is broken by definition.

### Control point 2: AsyncLocalStorage propagates the tenant to every layer

```ts
export const tenantScope: RequestHandler = (req, _res, next) => {
  tenantStorage.run({ tenantId: req.context!.tenantId }, () => next());
};
```

This binds the tenant id to the **async call chain** of the rest of the request. Anything in that chain — Mongoose queries, BullMQ enqueues, log lines — can read the tenant via `tenantStorage.getStore()` without explicit param-passing.

Why this matters: **a service can call a repository which calls another service which queries another model**, and every Mongoose call in that chain implicitly gets `tenantId` filtered without anyone passing it explicitly. The plugin uses this in control point 3.

### Control point 3: tenancyPlugin auto-filters every Mongoose call

```ts
// shared/db/tenancyPlugin.ts (paraphrased)
schema.pre(['find', 'findOne', 'findOneAndUpdate', 'updateOne', 'updateMany', 'count'], function () {
  const tenantId = tenantStorage.getStore()?.tenantId;
  if (tenantId) this.where({ tenantId });
});

schema.pre('save', function () {
  const tenantId = tenantStorage.getStore()?.tenantId;
  if (tenantId && !this.tenantId) this.tenantId = tenantId;
});
```

Every model that registers `tenancyPlugin` (i.e. every collection except the `Factory` root itself) gets these hooks. The result:

- A query like `Item.find({ sku: 'COTTON-RAW-001' })` becomes `Item.find({ sku: 'COTTON-RAW-001', tenantId: <currentTenant> })` automatically.
- A new document created via `Item.create({ sku: '...' })` automatically gets `tenantId` set on save.

**Defence in depth.** Even if the developer forgets to filter by tenant in a new service method, the plugin catches it. The plugin is the authoritative gate.

### Control point 3.5: assertTenantOwns is the IDOR guard

There's still one gap: an attacker could craft a URL like `GET /inventory/items/<another-tenants-item-id>`. The plugin would correctly return null (because the query filters by *current* tenantId), but a careless service might not check.

So every service does:

```ts
const item = await inventoryRepository.findItemById(id);
assertTenantOwns(item, ctx);  // throws NotFoundError (404, not 403) if tenantId mismatch
```

Returning 404 (not 403) is a deliberate choice from OWASP guidance: **don't let an attacker distinguish "doesn't exist" from "exists but you can't see it"**.

### What this gives us

You can read any service file and trust that:
- It cannot accidentally read another tenant's data (plugin filters automatically).
- It cannot accidentally write into another tenant's data (plugin injects tenantId on save).
- It rejects deliberately-crafted IDs from other tenants (assertTenantOwns).
- It can't be tricked by client-supplied tenantId (the JWT is the only source).

That's the boundary.

---

## 6. The journey of one HTTP request

Let's trace `POST /api/v1/inventory/items` end to end, step by step. This is the model for understanding any other endpoint.

```
                  ┌──────────────────────────┐
                  │  POST /api/v1/inventory/items   │
                  │  Authorization: Bearer <jwt>    │
                  │  Idempotency-Key: <uuid>        │
                  │  Content-Type: application/json │
                  │  body: { sku, name, ... }       │
                  └──────────────────────────┘
                                │
              ─────────────  app.ts global middleware  ─────────────
                                │
helmet (CSP, HSTS, frameguard)  │  ← attack-surface reduction
   │                            │
cors                            │  ← reject origins not on the allowlist
   │                            │
cookieParser                    │  ← parse refresh-token cookie if present
   │                            │
requestId                       │  ← attach req.id (UUID) for correlation
   │                            │
requestLogger                   │  ← Pino child logger with req.id + tenantId
   │                            │
express.json (1 MiB cap)        │  ← parse JSON body
   │                            │
rateLimitUnauthenticated        │  ← per-IP unauth bucket (60/min)
                                │
              ─────────────────  /api/v1/* router  ─────────────────
                                │
                                ▼ (routes.ts mounts authenticated sub-router)
rateLimitAuthenticated          │  ← per-IP auth bucket (600/min)
   │                            │
resolveTenant                   │  ← JWT verify + denylist check + req.context
   │                            │
tenantScope                     │  ← AsyncLocalStorage runs the rest
   │                            │
rateLimitTenant                 │  ← per-tenant bucket (6000/min)
                                │
              ─────────  /api/v1/inventory router (modules/inventory)  ─────────
                                │
rbacFor('inventory.item.create')│  ← capability check; 403 if role lacks it
   │                            │
idempotencyKey                  │  ← Redis SETNX on Idempotency-Key; replay-safe
   │                            │
validate(CreateItemRequestSchema)│ ← Zod parses + transforms req.body
                                │
              ─────────  inventoryController.createItem  ─────────
                                │
                                ▼
const ctx = requireContext(req); // throws 401 if context missing
const result = await inventoryService.createItem(ctx, req.body);
return created(req, res, result);
                                │
              ─────────  inventoryService.createItem  ─────────
                                │
                                ▼
1. inventoryRepository.findItemBySku(input.sku)   // duplicate check
2. inventoryRepository.createItem({ ... })        // Mongoose .create()
   │
   │  inside Mongoose:
   │   - tenancyPlugin pre('save'): inject tenantId from AsyncLocalStorage
   │   - softDeletePlugin: ensure archivedAt = null
   │   - auditPlugin: stamp createdAt / updatedAt
   ▼
3. void recordAudit({ ...InventoryItemCreated... })  // fire-and-forget audit
4. return toItemView(created)                        // strip Mongo internals
                                │
              ─────────  apiResponse helpers  ─────────
                                │
                                ▼
res.status(201).json({
  data: { id: '...', sku: '...', ... },
  requestId: req.id,
});
```

Every authenticated REST request follows this pattern. The middleware ordering is enforced in [`app.ts`](backend/src/app.ts) and [`routes.ts`](backend/src/routes.ts) and is intentional — change the order and you'll get subtle bugs (e.g. rate-limiting before auth means a malicious client can exhaust *another tenant's* per-tenant budget by guessing tenantIds).

---

## 7. The journey of one inventory item

Let's follow a single SKU — `COTTON-RAW-001` — across its entire lifetime in the system. This shows how multiple modules touch the same row over time.

### Day 0: creation
1. Owner calls `POST /inventory/items` → service creates `Item` row, `tenantId` auto-injected.
2. Owner calls `POST /inventory/items/:id/adjust` with `quantityDelta: 500, reasonCode: 'opening'`:
   - `inventory.service.adjustStock` validates the warehouse, creates a `StockMovement` row (type `adjustment`, append-only), and CAS-upserts a `StockBalance` row to 500 units.
   - Audit log: `inventory.movement.adjustment`.

### Day 1-30: routine consumption
- Production posts negative adjustments and `out` movements as the item is consumed.
- Each movement triggers `incrementBalance` which is an atomic `findOneAndUpdate` with `$inc`. The balance row's `lastMovementAt` is bumped. If the new quantity drops below `reorderLevel`, a separate cron flips `lowStockSince` and a notification fires.

### Day 31: an AI forecast lands
- A scheduled job (or a user click) hits `POST /ai/forecasts` with `itemId, horizonDays: 30`.
- `prepareForecastContext` reads **180 days of `StockMovement` rows for this item**, buckets them into a daily series, computes statistical features, and serialises a JSON context.
- The context is rendered into a versioned prompt (`forecast-v1.0.0`), sent to Groq → Gemini fallback, validated by Zod, and persisted as a `Forecast` row.
- The dashboard receives a `ai.forecast.completed` Socket.io event and updates the chart in place.

### Day 35: a quote, an accept, a PO
- A user creates a `QuotationRequest` with this item; suppliers respond.
- `quotationService.compareQuotes` ranks responses numerically and asks the AI for a prose summary.
- User accepts a supplier; `quotationService.accept` builds a draft `PurchaseOrder` automatically, pulling pricing from the supplier's response and lead time from the supplier record.

### Day 38-50: PO state machine
- PO submits → approves → dispatches (PDF rendered, R2 upload, supplier email).
- Supplier ships; user records receipt: `inventory.service.createMovement` adds a `StockMovement` row with type `in` and reference `po_receipt`. Balance increments. Low-stock alert clears. **A new forecast is automatically re-triggered** for this item to incorporate the fresh data.
- When the last unit is received, the PO transitions to `fully_received` → owner gets a confirmation email.

### Day 51+: analytics + reports
- `rpt.aggregations.runInventoryTurnover` reads this item's movements alongside thousands of others and computes COGS / avg-inventory ratio.
- The weekly AI report job aggregates 7 days of movements + PO totals + supplier spend and asks the AI to write an executive summary, rendered to PDF and emailed to the Owner.

That's the full life. Notice how **the same `Item` row is read by inventory, ai, supplier (via quote), po, and rpt modules** — and every read is implicitly tenant-filtered by the plugin, with no module needing to remember.

---

## 8. The journey of one purchase order

POs have the most state of any entity. Here's the full state machine with every transition's side effects.

```
   ┌─────────┐
   │  draft  │── update --► draft (still draft; CAS write to lines/totals/expectedDeliveryAt)
   └────┬────┘
        │ submit
        ▼
   ┌──────────────────┐
   │ pending_approval │── notifyPoSubmitted → email every Manager + Owner
   └────┬─────────────┘
        │ approve                    │ reject
        ▼                            ▼
   ┌──────────┐                ┌──────────┐
   │ approved │                │ rejected │── update → draft (allows resubmit)
   └────┬─────┘                └────┬─────┘
        │ background:               │ notifyPoRejected → email requester
        │  generateAndStorePdf      │
        │  notifyPoApproved         │
        │ dispatch                  │
        ▼                           │
   ┌────────┐                       │
   │  sent  │── notifyPoSentToSupplier → supplier email with PDF link
   └───┬────┘
       │           ┌── enqueueScheduled('po.delivery_overdue_check', delay = expectedDeliveryAt + 7d)
       │           │
       │ receive (partial)
       ▼
   ┌─────────────────────┐
   │ partially_received  │ ◄── receive (more) ── (loops until all lines fulfilled)
   └──────────┬──────────┘
              │
              │ post-receipt fan-out (best-effort, never rolls back the receipt):
              │   1. inventory.createMovement (type 'in', ref 'po_receipt_partial')
              │   2. inventory.incrementBalance
              │   3. inventory.clearLowStockIfResolved (alert clears if level rebuilt)
              │   4. enqueueForecast(itemId)  ← new stock changes the trend
              │   5. socket emit po.state.changed
              │   6. recordAudit po.received
              │
              │ receive (final lines)
              ▼
   ┌─────────────────┐
   │ fully_received  │── notifyPoFullyReceived → owner email
   └────────┬────────┘
            │ close
            ▼
   ┌────────┐
   │ closed │ (terminal)
   └────────┘

(any pre-closed state) ── cancel ──► cancelled (terminal; cancellation block stamped)
```

Two things make this robust:

1. **CAS state transitions.** Every transition is `findOneAndUpdate({ _id, state: <expected> }, { $set: { state: <new>, ... } })`. If two operators click "approve" simultaneously, exactly one wins; the loser gets `PO_STATE_RACE` and is told to refresh. No race condition is silently absorbed.

2. **Best-effort side effects.** When a receipt comes in, posting the inventory movement, clearing the low-stock alert, re-triggering the forecast, and sending the email are all **independent try/catch blocks** in `applyPostReceiptSideEffects`. If the AI quota is exhausted and the forecast re-trigger fails, the receipt **still persists**. The system degrades gracefully instead of cascading failures.

---

## 9. Where AI plugs in

This is the deepest section because the AI is the differentiating feature. There are **five distinct integration points** between the AI module and the rest of the system. They're often confused — knowing them separately is what lets you explain the product clearly.

### 9.1 Direct on-demand forecast (sync REST)

```
User clicks "Forecast this item" in the dashboard
   │
   ▼
POST /ai/forecasts { itemId, horizonDays }
   │
   ▼
ai.service.runForecastForItem
   │
   ├── 1. Acquire 6h per-item Redis lock (NX/EX)
   │      reason: prevent the user spam-clicking the button from
   │      thrashing the LLM and burning their quota.
   │
   ├── 2. Read 24h Redis result cache
   │      cache hit → return immediately (no LLM call)
   │
   ├── 3. Load Item + preferred-supplier lead time (for reorderPoint)
   │
   ├── 4. prepareForecastContext (data prep layer, src/modules/ai/dataPreparation.ts)
   │      - reads 180 days of StockMovement rows for this item
   │      - buckets daily, then monthly
   │      - computes features:
   │         * mean, median daily consumption
   │         * coefficient of variation (volatility)
   │         * trend slope (linear regression)
   │         * autocorrelation at lag 7 (weekly) and lag 30 (monthly)
   │         * recency bias (last-30 vs prior baseline ratio)
   │         * data sparsity classification: rich / moderate / sparse / empty
   │      - returns a clean JSON context for the prompt
   │
   ├── 5. Quota gate: aiUsageRepository.checkQuota
   │      - looks up tenant's tier from JWT
   │      - estimates token cost
   │      - rejects with AI_QUOTA_EXCEEDED if monthly cap would be exceeded
   │      - returns { allowed, softAlert (≥80%) }
   │
   ├── 6. runForecastPipeline (src/modules/ai/forecastPipeline.ts)
   │      ┌─────────────────────────────────────────────┐
   │      │ renderForecastPrompt (versioned template)   │
   │      └────────────────┬────────────────────────────┘
   │                       │
   │                       ▼
   │      ┌─────────────────────────────────────────────┐
   │      │ Groq (Llama 3.3 70B)                        │ ← primary
   │      │   - per-provider circuit breaker            │
   │      │   - 3 consecutive fails → 60s open          │
   │      └────────────────┬────────────────────────────┘
   │                       │ on error / parse fail
   │                       ▼
   │      ┌─────────────────────────────────────────────┐
   │      │ Gemini 1.5 Flash                            │ ← fallback
   │      │   - same circuit breaker pattern            │
   │      └────────────────┬────────────────────────────┘
   │                       │ on both fail
   │                       ▼
   │      ┌─────────────────────────────────────────────┐
   │      │ deterministic baseline                      │ ← floor
   │      │   - extrapolates historical mean            │
   │      │   - widens interval based on volatility     │
   │      │   - confidence = 'low'                      │
   │      └────────────────┬────────────────────────────┘
   │                       │
   │                       ▼
   │      coerceForecast (src/modules/ai/validators/forecastValidator.ts)
   │        - strict Zod parse
   │        - on failure, lenient repair pass
   │        - on failure, deterministic baseline
   │        - enforces horizon monotonicity (q90 ≥ q60 ≥ q30)
   │
   ├── 7. Persist Forecast row with full provenance:
   │      provider, model, promptVersion, latencyMs,
   │      promptTokens, completionTokens, cacheHit,
   │      rawPrompt (truncated 32k), rawResponse (truncated 32k)
   │
   ├── 8. aiUsageRepository.increment
   │      - per-tenant per-month roll-up: tokens, calls, cost USD micros
   │      - tier caps enforced here as a backstop (already gated upstream)
   │
   ├── 9. Redis 24h result cache write (so step 2 above hits next time)
   │
   ├── 10. Socket.io emit ai.forecast.completed to tenant:<tenantId> room
   │       (the dashboard subscribes; chart updates without refresh)
   │
   └── 11. recordAudit ai.forecast.generated with provider + cost
```

**Why every step exists:** the comment column above each step is the "why". Every line here was put there to handle a real failure mode — flaky LLMs, runaway costs, schema drift, dashboard jitter, accountability.

### 9.2 Batch forecast (async via BullMQ)

The dashboard "Forecast all items" button.

```
POST /ai/forecasts/batch
   │
   ▼
ai.service.runForecastForAll
   │
   ├── Pre-flight: check that the tenant's monthly cap would not be exceeded
   │   for the entire batch. estimateBatchForecastCost returns USD estimate.
   │
   ├── enqueueForecast('forecast.batch', { tenantId, itemIds, requestedBy })
   │   returns { batchJobId, itemCount, estimatedCostUsd }
   │
   └── HTTP 200 with batchJobId — user can subscribe to socket events
                                  to watch progress.

(now in the worker process, src/workers/forecast.worker.ts)

forecast.batch handler
   │
   ├── For each item (concurrency 3, intentionally low for Groq RPM cap):
   │   │
   │   ├── emit AiForecastBatchProgress { batchJobId, itemId, index, total, status: 'started' }
   │   ├── call aiService.runForecastForItem (skipRateLimit: true, skipReadCache: true)
   │   │   - bypasses 6h lock (batch mode is the "do it all" intent)
   │   │   - bypasses cache read (we want fresh outputs for the batch)
   │   ├── emit AiForecastBatchProgress { ..., status: 'completed' | 'failed' }
   │   └── job.updateProgress(percentage)  ← visible in queue UIs
   │
   ├── emit AiForecastBatchCompleted { total, succeeded, failed, durationMs }
   │
   └── enqueueEmail batch summary to the requester
```

**Same pipeline, different orchestrator.** The worker is just a fan-out + progress wrapper.

### 9.3 PO receipt → forecast retrigger

This is the most interesting integration: **inventory state changes drive AI re-inference**.

```
po.service.receive (user records goods receipt)
   │
   ▼
applyPostReceiptSideEffects
   │
   ├── for each affected item:
   │   ├── inventoryRepository.clearLowStockIfResolved
   │   │     (alert flag clears if quantity now ≥ reorderLevel)
   │   │
   │   └── enqueueForecast('forecast.single_item', { itemId, ... })
   │         ← BUT FIRST: 6h staleness check
   │           if the latest forecast is < 6h old, skip the enqueue.
   │           reason: a 200-line GRN would otherwise trigger 200
   │           forecast jobs in seconds and burn AI quota.
   │
   └── if fully received, notifyPoFullyReceived
```

The forecast retriggered here is `horizonDays: 30`. On the next dashboard refresh, the user sees a fresh prediction reflecting the new stock baseline. If they had been viewing a forecast from before the receipt, the Socket.io `ai.forecast.completed` event nudges them.

### 9.4 Quote comparison → AI prose

When a user compares supplier responses on an RFQ:

```
GET /quotations/:id/compare
   │
   ▼
quotation.service.compareQuotes
   │
   ├── DETERMINISTIC NUMERIC RANKING:
   │   - per supplier: total cost = Σ (line.qty × response.unitPrice)
   │   - per supplier: avg lead time, completeness flag
   │   - sort by totalCost ascending; complete responses only
   │   - cheapest complete response = recommendedSupplierId
   │
   ├── AI PROSE SUMMARY (best-effort):
   │   - prompt: "Compare these quote responses; recommend a supplier
   │     in 4-6 sentences. Reference numbers; no preamble."
   │   - runTextPipeline (same Groq → Gemini chain, no JSON contract)
   │   - if both LLMs fail, return numeric summary only (aiSummary: null)
   │
   └── return { rows[], recommendedSupplierId, aiSummary }
```

Notice: **the AI doesn't choose the supplier**. The number is deterministic. The AI explains the tradeoff (e.g. "Padma is cheaper but has a 3-day longer lead time"). This is a **deliberate trust pattern**: the human sees the numbers, the AI provides context.

### 9.5 Weekly AI report → 5-module aggregation → narration → PDF → email

The weekly executive briefing.

```
report.weekly_digest job (BullMQ scheduled cron, when wired)
   │
   ▼
reportGenerator.generateWeeklyReport
   │
   ├── aggregateWeeklyMetrics (reads from FIVE modules in parallel):
   │   ├── inventory.StockMovement.aggregate    → totalMovements, consumed, received
   │   ├── po.PurchaseOrder.aggregate           → poCount, poTotalValue, fully-received count
   │   ├── inventory.StockBalance.countDocuments → low-stock count, dead-stock count
   │   ├── inventory.StockMovement.aggregate    → top 5 consumed items
   │   ├── po.PurchaseOrder.aggregate           → top 5 supplier spend
   │   ├── ai.Forecast.countDocuments           → forecasts generated this week
   │   └── computeOnTimeDeliveryRate (po)       → on-time delivery rate
   │
   ├── Quota gate: checkQuota(tier, callKind: 'report')
   │
   ├── renderReportPrompt (versioned weekly-report-v1.0.0, Markdown out)
   │
   ├── runTextPipeline (same Groq→Gemini chain)
   │
   ├── aiUsageRepository.increment (callKind: 'report')
   │
   ├── markdownToHtml (in-house converter — no external CSS, sandboxed)
   │
   ├── renderHtmlToPdf (Puppeteer + headless Chromium)
   │   - graceful no-op if Chromium binary missing (dev environments)
   │   - in production runs in the worker process to avoid blocking the API
   │
   └── emailClient.send to factory owner with PDF attachment
       (or Markdown body if PDF render failed)
```

**Five modules feed the AI, the AI writes the brief, the brief becomes a PDF, the PDF lands in the owner's inbox.** That's the highest-leverage AI moment in the product.

### Summary table: what every AI integration costs and gives back

| Integration | Trigger | LLM call cost | What the user gets |
|---|---|---|---|
| 9.1 On-demand forecast | User click | 1 forecast call, ~5k tokens | Per-item 30/60/90 day predictions + reorder point + reasoning |
| 9.2 Batch forecast | User click "all items" | N forecast calls, ~5k each | Whole-portfolio refresh; progress on dashboard |
| 9.3 PO receipt retrigger | System | 1 forecast call per item (rate-gated) | Predictions auto-refresh after stock changes |
| 9.4 Quote comparison | User click | 1 text call, ~2-3k tokens | Numeric ranking + AI prose tradeoff |
| 9.5 Weekly report | Cron | 1 text call, ~3-4k tokens | PDF executive brief by email |

All five share the same `forecastPipeline` / `runTextPipeline`, the same circuit breaker, the same usage roll-up. **One pipeline, five customers.**

---

## 10. Background processing

The worker process drains four queues. Each has its own concurrency tuning, retry policy, and dead-letter strategy.

```
                        ┌──────────────────────────────┐
                        │       Redis (BullMQ)         │
                        │  ┌────────┐  ┌────────────┐  │
   API process          │  │ email  │  │ forecast   │  │   Worker process
   ──────────►          │  └────────┘  └────────────┘  │  ◄────────────
                        │  ┌────────┐  ┌────────────┐  │
   enqueueEmail         │  │ report │  │ scheduled  │  │  drains and processes
   enqueueReport        │  └────────┘  └────────────┘  │
   enqueueForecast      │                              │
   enqueueScheduled     └──────────────────────────────┘
```

| Queue | Concurrency | Retries | Backoff | Dead-letter behaviour |
|---|---|---|---|---|
| email | 5 | 5 | 5min exp | Flips `emailDeliveries.state = 'failed'`, logs warn |
| report | 2 | 2 | 5min exp | Logs error; admin manually re-enqueues |
| forecast | 3 | 2 | 1min exp | Logs warn; LLM costs make aggressive retry expensive |
| scheduled | 4 | 1 | n/a | Single-attempt by design; the row state usually no-ops on miss |

**Why such low concurrency for forecast?** Groq's free-tier cap is 30 RPM. Three concurrent workers give us headroom to process two tenants in parallel without hitting 429s. Production should re-tune from real telemetry.

**Why scheduled is single-attempt?** A missed quote-expiry check just expires on the next nightly cron. A missed PO-overdue alert means one tenant gets the alert a day late. Both are recoverable without retry storms.

### How a job actually runs

Take an email job:

```
emailService action (e.g. notifyPoApproved)
   │
   ├── construct { to, subject, html, text, tags }
   ├── enqueueEmail('email.send', payload)  ← writes to Redis
   └── return immediately (HTTP response goes out)

(asynchronously, in the worker process)

email.worker
   │
   ├── pulls 'email.send' from Redis
   ├── attempt 1: emailClient.send (Resend SDK)
   │   - on 5xx or network error → BullMQ schedules retry with exp backoff
   ├── attempt 2..5
   └── final failure → emailDeliveries.state = 'failed', warn log
```

The same pattern applies to forecasts (with progress events emitted), reports (with PDF rendering), and scheduled jobs.

---

## 11. Real-time updates

WebSocket layer is **read-only from the client's perspective**. Clients can only `ping`; everything else is server-emitted.

```
Browser
   │  socketio-client connects to /realtime
   │  with handshake auth: { token: <JWT> }
   ▼
Socket.io server (in API process)
   │
   ├── verifyAccessToken (handshake middleware)
   ├── auto-join rooms: tenant:<tenantId>, user:<userId>
   ├── emit system.connected
   │
   └── ANY emit other than ping → disconnect + audit log
       (defence against compromised clients)

Server-side emitters (anywhere in any module):
   getIo().to(tenantRoom(tenantId)).emit('po.state.changed', { ... });

Cross-process scaling:
   The Socket.io Redis adapter pub/subs over the third Redis connection
   (redisSockPub / redisSockSub). Multiple API instances stay in sync.
```

The 11 events the server can emit are listed in `shared/realtime/events.ts`. Notable ones:

- `ai.forecast.batch.progress` — per-item ticks during a batch run; the dashboard renders a progress bar.
- `po.state.changed` — every PO transition; lets a peer's dashboard reflect the change without polling.
- `inventory.balance.changed` — emitted from cron tasks (low-stock cron, balance-audit cron); turns the warehouse view into a live grid.

---

## 12. The audit log

`recordAudit` is called from **every privileged action across every module**. It's the only durable cross-module trail.

```ts
// shared/audit/audit.service.ts
recordAudit({
  tenantId,
  actorUserId,
  actorRole,
  action: AuditActions.PoApproved,           // stable string; clients depend on these
  target: { kind: 'po', id: po._id },
  before, after,                              // diff'd into changes[] automatically
  payload: { thresholdRule, total },          // free-form context
  requestId,
});
```

Inside the helper:

- Sensitive keys (`password`, `token`, `secret`, `apiKey`, ...) are recursively redacted before persistence.
- `before` + `after` are diffed into a `changes[]` array of `{ path, before, after }` so the audit UI can render them.
- Failure to write **never propagates** — audit logging must not block business operations. A warn log is emitted.

Every audit entry is tenant-scoped (`tenantId` indexed) and TTL-eligible (90 days hot, archive cold). The audit reading module (`modules/audit/`) lands in a future prompt to expose `/audit` browse endpoints; for now, every action is being captured durably.

---

## 13. The wiring diagram

The whole system, on one page:

```
                       ┌──────────────────────────────┐
                       │           Browser            │
                       │  (React dashboard, future)   │
                       └──────────────┬───────────────┘
                                      │
              REST /api/v1/*          │          WebSocket /realtime
              (Bearer JWT, CSRF       │          (JWT in handshake)
               on /refresh,           │
               Idempotency-Key        │
               on POST)               │
                                      ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │                    src/server.ts (API process)                   │
   │                                                                  │
   │   helmet, cors, requestId, requestLogger,                        │
   │   express.json (1 MiB), rateLimitUnauthenticated                 │
   │                          │                                       │
   │                          ▼                                       │
   │      ┌────────────────────────────────────────────┐              │
   │      │  /api/v1/auth (public sub-router)          │              │
   │      │  rateLimitAuthSensitive on /login          │              │
   │      └────────────────────────────────────────────┘              │
   │                          │                                       │
   │                          ▼                                       │
   │      ┌────────────────────────────────────────────┐              │
   │      │  /api/v1/* (authenticated sub-router)      │              │
   │      │  rateLimitAuthenticated                    │              │
   │      │  resolveTenant ─► JWT verify + denylist    │              │
   │      │  tenantScope ─► AsyncLocalStorage          │              │
   │      │  rateLimitTenant                           │              │
   │      └─────┬─────┬─────┬─────┬─────┬─────┬─────┬──┘              │
   │            │     │     │     │     │     │     │                 │
   │            ▼     ▼     ▼     ▼     ▼     ▼     ▼                 │
   │       ┌────────────────────────────────────────────────┐         │
   │       │   modules: inventory / supplier / po / ai /    │         │
   │       │   rpt / notification / billing / auth          │         │
   │       │                                                │         │
   │       │   each: routes ─► controller ─► service ─►     │         │
   │       │         repository ─► model + plugins          │         │
   │       └─────┬───────────────────────────┬──────────────┘         │
   │             │                           │                        │
   │             │                           │                        │
   │   ──────────┼───────────────────────────┼──────────────           │
   │             │                           │                        │
   │             │                           │                        │
   │      Mongoose (with                Socket.io                     │
   │      tenancyPlugin,                (Redis adapter,                │
   │      softDelete,                   tenant + user                  │
   │      audit hooks)                  rooms)                         │
   │             │                           │                        │
   │             ▼                           ▼                        │
   │      ┌──────────────┐           ┌───────────────┐                │
   │      │   MongoDB    │           │     Redis     │                │
   │      │   Atlas      │           │  (4 connections:               │
   │      │              │           │   cache, queue,                │
   │      │              │           │   sock-pub,                    │
   │      │              │           │   sock-sub)                    │
   │      └──────────────┘           └──────┬────────┘                │
   │                                        │                         │
   └────────────────────────────────────────┼─────────────────────────┘
                                            │
                          BullMQ            │           Resend (email),
                          queues            │           Groq + Gemini (AI),
                                            │           R2 (S3 storage)
                                            │
                                            ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │                  src/worker.ts (worker process)                  │
   │                                                                  │
   │   ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌────────────┐     │
   │   │  email   │  │  report  │  │  forecast  │  │ scheduled  │     │
   │   │  worker  │  │  worker  │  │  worker    │  │  worker    │     │
   │   └──────────┘  └──────────┘  └────────────┘  └────────────┘     │
   │                                                                  │
   │   - share the same module imports as the API                     │
   │   - run business logic (e.g. forecastPipeline) directly          │
   │   - emit Socket.io events back via the shared Redis adapter      │
   └──────────────────────────────────────────────────────────────────┘
```

---

## 14. Three end-to-end scenarios traced through the system

The cleanest way to absorb everything is to trace concrete scenarios. Here are three.

### Scenario A: a new factory signs up and creates its first item

```
User submits the registration form.
   │
   ▼
POST /api/v1/auth/register { factoryName, slug, businessType, ownerEmail, ownerPassword }
   │
   ├── auth.service.register
   │   ├── creates Factory row (the tenant root — NOT tenant-scoped itself)
   │   ├── creates User row with role='owner', bcrypt-hashed password
   │   ├── creates Subscription row (tier='trial', 14-day trial)
   │   ├── issues access + refresh tokens
   │   ├── creates a Session row tracking the refresh token family
   │   ├── enqueueEmail welcome email
   │   └── recordAudit auth.register
   │
   ▼
Response: { accessToken, refreshToken, tenantId, userId }

(later)

User submits "Create item" form.
   │
   ▼
POST /api/v1/inventory/items { sku, name, unit, type, ... }
   │
   ├── helmet, cors, requestId, requestLogger, express.json (MIDDLEWARE CHAIN)
   ├── rateLimitUnauthenticated → rateLimitAuthenticated
   ├── resolveTenant: JWT verify, denylist check, build req.context
   ├── tenantScope: bind tenantId to AsyncLocalStorage
   ├── rateLimitTenant
   ├── rbacFor('inventory.item.create') → owner has it
   ├── idempotencyKey: SETNX on Idempotency-Key header
   ├── validate(CreateItemRequestSchema): Zod parses + transforms
   ├── inventoryController.createItem(ctx, req.body)
   │   ▼
   │   inventoryService.createItem
   │     ├── duplicate-SKU check
   │     ├── inventoryRepository.createItem
   │     │     ▼
   │     │     Item.create(...)
   │     │       ├── tenancyPlugin pre('save'): inject tenantId
   │     │       ├── auditPlugin: stamp createdAt / updatedAt
   │     │       └── persisted to MongoDB
   │     └── recordAudit inventory.item.created
   │
   ▼
Response: 201 { data: { id, sku, ... }, requestId }
```

Notice every numbered step is in fact one of the layers we discussed — middleware → controller → service → repository → model + plugins.

### Scenario B: PO receipt cascade (the most complex flow in the system)

```
User scans goods at the warehouse, hits "Record receipt" on the dashboard.
   │
   ▼
POST /api/v1/purchase-orders/:id/receipts { warehouseId, lines: [...], grnDocumentUrl }
   │
   ├── (middleware chain — same as Scenario A)
   ├── rbacFor('po.receive')
   ├── idempotencyKey
   ├── validate(ReceivePoRequestSchema)
   ├── poController.receive
   │
   ▼
poService.receive
   │
   ├── 1. Load PO; assertTenantOwns; check state ∈ {sent, partially_received}
   ├── 2. Load warehouse; assertTenantOwns
   ├── 3. Validate every receipt line against PO line remaining qty
   │      (throw BAD_REQUEST if user tries to over-receive)
   ├── 4. poRepository.setLineReceived
   │      - mutates the embedded lines array, increments quantityReceived
   │      - .save() the PurchaseOrder doc
   ├── 5. Determine resultingState: fully_received vs partially_received
   ├── 6. poRepository.createReceipt
   │      - new PoReceipt row capturing this delivery
   ├── 7. For each received line:
   │      - inventoryRepository.createMovement(type:'in', ref:'po_receipt')
   │      - inventoryRepository.incrementBalance(delta = receivedQty)
   ├── 8. poRepository.transitionState
   │      - CAS update of PO.state from previous → resultingState
   │      - if CAS fails, throw PO_STATE_RACE
   ├── 9. recordAudit po.received
   ├── 10. Fire-and-forget applyPostReceiptSideEffects:
   │      ├── for each item:
   │      │   ├── inventoryRepository.clearLowStockIfResolved
   │      │   │     (drops the lowStockSince flag if balance ≥ reorderLevel)
   │      │   └── (with 6h staleness check) enqueueForecast for itemId
   │      │       (worker will refresh the forecast in the background)
   │      └── if fully_received:
   │          notifyPoFullyReceived
   │            └── enqueueEmail with summary (worker will send via Resend)
   │
   ▼
Response: 201 { data: { po, receipt }, requestId }

(meanwhile, ASYNC in the worker process)

forecast.worker pulls forecast.single_item job
   │
   ├── builds tenant context from tenantId + userId (worker doesn't have JWT)
   ├── runs the full ai.service.runForecastForItem pipeline (see §9.1)
   │   ├── data prep reads the FRESH StockMovement rows (incl. the 'in' just posted)
   │   ├── Groq call → Forecast row → Redis cache → AiUsage roll-up
   │   └── Socket.io emit ai.forecast.completed → dashboard updates

(separately, ASYNC)

email.worker pulls email.send job
   │
   ├── emailClient.send via Resend SDK
   └── EmailDelivery row updated with delivered/failed state
```

Three modules cooperated to handle one user action: **po, inventory, ai**. Plus three workers (forecast, email) plus the audit log plus Socket.io. None of those steps blocked the user's HTTP response.

### Scenario C: weekly report generation (the highest-leverage AI moment)

```
Cron fires (when wired) → enqueueReport('report.weekly_digest', { tenantId, weekStart, weekEnd })
   │
   ▼
report.worker pulls the job
   │
   ▼
reportGenerator.generateWeeklyReport
   │
   ├── 1. Load Factory (tenant root) for branding + name
   │
   ├── 2. aggregateWeeklyMetrics — runs SIX aggregations in parallel:
   │      a. StockMovement.aggregate → totalMovements, consumed, received
   │      b. PurchaseOrder.aggregate → poCount, poTotalValue
   │      c. PurchaseOrder.countDocuments → fully-received count this week
   │      d. StockBalance.countDocuments → low-stock count
   │      e. StockBalance.countDocuments → dead-stock count (90+d no movement)
   │      f. StockMovement.aggregate → top 5 consumed items
   │      g. PurchaseOrder.aggregate → top 5 supplier spend
   │      h. Forecast.countDocuments → forecasts generated this week
   │      i. compute on-time delivery rate from PO.closedAt vs expectedDeliveryAt
   │
   ├── 3. checkQuota(tier, 'report', estimatedTokens) — block if monthly cap hit
   │
   ├── 4. renderReportPrompt({ tenantName, weekStart, weekEnd, metrics })
   │      versioned `weekly-report-v1.0.0` — Markdown out, no JSON contract
   │
   ├── 5. runTextPipeline (Groq → Gemini fallback, same circuit breaker)
   │
   ├── 6. aiUsageRepository.increment (callKind: 'report')
   │
   ├── 7. markdownToHtml — in-house converter (no external CSS, sandboxed)
   │
   ├── 8. renderHtmlToPdf — Puppeteer + Chromium
   │      - graceful no-op on dev boxes without Chromium
   │      - in production runs in the worker, never the API process
   │
   ├── 9. resolveOwnerEmail (factory.ownerUserId or fallback to any active Owner)
   │
   ├── 10. emailClient.send: subject "Weekly procurement brief", PDF attached
   │
   └── 11. recordAudit rpt.weekly.generated with provider + pdfRendered + emailSent
```

The factory owner gets a PDF in their inbox once a week with **everything they need to know about the procurement state, narrated in plain English by the AI**, with the data verifiable in the dashboard. That single workflow is the highest-value AI moment in the product, and it threads through five modules (inventory, po, supplier, ai, rpt-implicitly) plus three workers (report, email) plus two cloud services (LLM provider, Resend).

---

## Appendix — what to remember

If you only remember six things from this document:

1. **Two processes**: API + worker. Slow work doesn't steal from fast work.
2. **Vertical-slice modules**: every domain owns dto + service + repo + controller + routes + models. Cross-module imports go through `index.ts` barrels.
3. **Three tenant control points**: JWT-only context → AsyncLocalStorage → Mongoose plugin. Defence in depth.
4. **CAS state transitions**: every PO state change is `findOneAndUpdate({ _id, state: <expected> }, ...)`. No race silently absorbed.
5. **Best-effort side effects**: receipt persists even if the forecast retrigger or the email fails. Failures degrade the system gracefully, never cascade.
6. **One AI pipeline, five customers**: forecast (sync), forecast (batch), forecast (PO retrigger), quote-compare (prose), weekly-report (narration). All share the Groq → Gemini circuit breaker, the deterministic baseline floor, and the per-tenant cost roll-up.

That's the system.
