# AI-Powered Supply Chain & Procurement Platform — Backend

**Status:** all functional modules complete (Prompts 01-06).
**Out of scope (yet):** CI/CD, deployment automation, automated test suite.

This document covers everything you need to (a) run the backend locally, (b) test every endpoint, and (c) explain how the system fits together to anyone — engineer or stakeholder. Read top to bottom the first time; use the table of contents thereafter.

## Table of contents

1. [Quick start](#1-quick-start)
2. [Test environment requirements](#2-test-environment-requirements)
3. [Architecture at a glance](#3-architecture-at-a-glance)
4. [Request lifecycle (one diagram, internalise this)](#4-request-lifecycle)
5. [Module reference](#5-module-reference)
6. [Module-to-module wiring (the connection map)](#6-module-to-module-wiring)
7. [Background jobs (BullMQ workers)](#7-background-jobs)
8. [Real-time events (Socket.io)](#8-real-time-events)
9. [Security layer](#9-security-layer)
10. [AI pipeline (end-to-end)](#10-ai-pipeline)
11. [Error envelope and shared codes](#11-error-envelope-and-shared-codes)
12. [End-to-end test workflows](#12-end-to-end-test-workflows)
13. [Common issues](#13-common-issues)

---

## 1. Quick start

### Prerequisites

- Node.js **20 LTS** (the codebase uses ESM + native `--env-file`)
- MongoDB 6+ (Atlas free tier works) — connection string with replica-set support
- Redis 7+ (local Docker, Upstash free tier, or Render add-on)
- npm (the project uses npm; `package-lock.json` is checked in)

### Install

```bash
cd backend
npm install
```

### Environment file

Create `backend/.env` (loaded by `tsx --env-file=.env`):

```bash
# Core
NODE_ENV=development
PORT=4000
LOG_LEVEL=debug
GIT_SHA=local

# Database
MONGO_URI=mongodb://localhost:27017/scp_dev
MONGO_MAX_POOL_SIZE=20
MONGO_MIN_POOL_SIZE=5

# Redis
REDIS_URL=redis://localhost:6379
REDIS_TLS=false

# JWT (>=32 chars each, generate with `openssl rand -base64 48`)
JWT_ACCESS_SECRET=replace-with-random-base64-string-32-or-more-chars
JWT_REFRESH_SECRET=another-different-random-base64-32-or-more
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
JWT_ISSUER=scp-platform
JWT_AUDIENCE=scp-platform-clients

# Auth / cookies
BCRYPT_COST=12
COOKIE_DOMAIN=localhost
COOKIE_SECURE=false
CORS_ORIGINS=http://localhost:3000,http://localhost:5173

# Rate limits (per-minute baselines)
RATE_LIMIT_UNAUTH_PER_MIN=60
RATE_LIMIT_AUTH_PER_MIN=600
RATE_LIMIT_TENANT_PER_MIN=6000

# Email (optional — falls back to log-only if missing)
RESEND_API_KEY=
EMAIL_FROM=noreply@factory.bd
EMAIL_REPLY_TO=support@factory.bd

# AI providers (optional — pipeline returns deterministic baseline if missing)
GROQ_API_KEY=
GROQ_MODEL=llama-3.3-70b-versatile
GEMINI_API_KEY=
GEMINI_MODEL=gemini-1.5-flash
AI_PER_CALL_TIMEOUT_MS=30000
AI_FAILURE_THRESHOLD=3
AI_COOLDOWN_MS=60000

# Field-level encryption (optional)
FIELD_ENCRYPTION_KEY=
FIELD_ENCRYPTION_KEY_PREVIOUS=

# R2 / S3-compatible storage (optional — uploads return stub URLs if missing)
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_ENDPOINT=
R2_PUBLIC_URL_TTL_SECONDS=300

# Billing gateways (currently stub)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
SSLCOMMERZ_STORE_ID=
SSLCOMMERZ_STORE_PASSWORD=
SSLCOMMERZ_IS_LIVE=false

# Frontend base URL (used in email deep links)
FRONTEND_BASE_URL=http://localhost:3000
```

### Run

Two processes — both must be running for full functionality:

```bash
# Terminal 1 — API server
npm run dev

# Terminal 2 — BullMQ worker (emails, forecasts, weekly reports, scheduled jobs)
npm run dev:worker
```

API listens on `http://localhost:4000`. Health checks:

```bash
curl localhost:4000/healthz   # liveness
curl localhost:4000/readyz    # checks Mongo + Redis
```

If both return 200, you can hit the Postman collection.

---

## 2. Test environment requirements

| Component                             | Why it matters                                                                                                | How to run locally                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| MongoDB                               | Persistent state for every collection (users, items, POs, forecasts...)                                       | Docker: `docker run -d -p 27017:27017 mongo:7`                                                               |
| Redis                                 | Rate limiting, BullMQ queues, idempotency cache, AI result cache, Socket.io adapter                           | Docker: `docker run -d -p 6379:6379 redis:7`                                                                 |
| API process (`npm run dev`)           | Serves REST + WebSocket                                                                                       | required                                                                                                     |
| Worker process (`npm run dev:worker`) | Drains queues: email send, forecast generation, weekly report, scheduled cron jobs (quote expiry, PO overdue) | required if you want async side effects to actually happen                                                   |
| Resend API key                        | Real email delivery                                                                                           | optional — without it, emails log a `email.stub_send` line                                                   |
| Groq + Gemini keys                    | Real AI forecasts and AI quote-comparison narration                                                           | optional — without keys the forecast pipeline returns a deterministic numeric baseline with confidence=`low` |
| R2 credentials                        | Real PO PDF download URLs                                                                                     | optional — without them the URL is `stub://r2/...` (PDF buffer is still generated by PDFKit)                 |
| Stripe / SSLCommerz keys              | Live billing                                                                                                  | not yet wired (intentional)                                                                                  |

**Practical minimum to test everything:** Mongo + Redis + JWT secrets + 2 terminals.

---

## 3. Architecture at a glance

The backend is a **modular monolith with a separate worker process** (SDD §2 / §5). Two Node entry points:

- `src/server.ts` — Express HTTP API + Socket.io
- `src/worker.ts` — BullMQ workers (no HTTP listener)

Each functional area is a vertical slice under `src/modules/<name>/` containing its own DTO (Zod), repository (Mongoose), service (business logic), controller (HTTP), routes (Express), and `models/` (Mongoose schemas). Cross-module imports go through each module's `index.ts` barrel; `eslint-plugin-boundaries` enforces this.

Shared infrastructure under `src/shared/`:

```
shared/
├── audit/         # recordAudit, AuditLog model
├── auth/          # jwt, password, rbac matrix, types, assertTenantOwns
├── db/            # tenancyPlugin, softDeletePlugin, auditPlugin, auditLog model
├── email/         # Resend client wrapper
├── errors/        # AppError + HttpErrors + errorCodes
├── http/          # asyncHandler, apiResponse helpers
├── middleware/    # validate, rbac, tenant, rateLimit, idempotency, csrf, ...
├── queue/         # jobTypes, queues, enqueue helpers
├── realtime/      # socketServer, events
├── repositories/  # base helpers
├── security/      # tokenDenylist, fieldCrypto, fileUpload
├── storage/       # r2.client (S3-compatible)
└── utils/         # objectId, pagination, ...
```

Modules currently shipped:

| Module       | Path                    | What it owns                                                                                     |
| ------------ | ----------------------- | ------------------------------------------------------------------------------------------------ |
| auth         | `modules/auth/`         | Users, factories (tenants), sessions, registration, login, role management                       |
| inventory    | `modules/inventory/`    | Warehouses, item categories, items, stock balances + movements (append-only ledger)              |
| supplier     | `modules/supplier/`     | Suppliers, contacts, documents, performance score, RFQs (`quotation.*` files inside this module) |
| po           | `modules/po/`           | Purchase orders, line items, receipts, state machine, PDF, email triggers                        |
| ai           | `modules/ai/`           | Forecasts, AI usage tracking, prompt + pipeline + validators, weekly report generator            |
| rpt          | `modules/rpt/`          | Aggregation pipelines + read-only reporting endpoints                                            |
| notification | `modules/notification/` | In-app notification feed                                                                         |
| billing      | `modules/billing/`      | Subscriptions, plans, invoices, webhooks (gateway adapters stubbed)                              |

---

## 4. Request lifecycle

Every authenticated REST request flows through the same chain:

```
HTTP request
   │
   ▼
helmet / cors / cookieParser / requestId / requestLogger
   │
   ▼
express.json (1 MiB cap) ─► rateLimitUnauthenticated (per IP)
   │
   ▼
─── /api/v1/auth (public) ─► no further middleware, hits authPublicRouter
   │
   └── all other /api/v1/* paths:
            │
            ▼
       rateLimitAuthenticated (per IP)
            │
            ▼
       resolveTenant   ← reads JWT, checks denylist, builds req.context
            │
            ▼
       tenantScope     ← AsyncLocalStorage runs the rest under tenantId
            │
            ▼
       rateLimitTenant (per tenant)
            │
            ▼
       module router (e.g. /inventory)
            │
            ▼
       rbacFor(<capability>)        ← role → capability lookup
       idempotencyKey               ← for POSTs: Redis Idempotency-Key cache
       validate(<schema>, <where>)  ← Zod for body / params / query
            │
            ▼
       controller (asyncHandler)
            │
            ▼
       service        ← business logic
            │
            ▼
       repository     ← Mongoose .lean() reads, model writes
            │
            ▼
       (audit log + socket emit + queue enqueue side effects)
            │
            ▼
       apiResponse helper → JSON
```

The error envelope is consistent: `{ error: { code, message, details?, requestId } }`. See §11.

---

## 5. Module reference

### 5.1 auth

**Owns:** the multi-tenant boundary. A factory (tenant) is the root entity; users belong to a factory.

**Models:** `Factory` (NOT tenant-scoped — it IS the tenant root), `User`, `Session`.

**Capabilities:** `user.invite`, `user.role.assign`. Owner-only protection for last-Owner removal and self-role-change.

**Endpoints (private):**

| Method | Path                      | Purpose                                                |
| ------ | ------------------------- | ------------------------------------------------------ |
| GET    | `/auth/me`                | current user profile                                   |
| PATCH  | `/auth/me`                | update name, notification preferences                  |
| GET    | `/auth/users`             | list users in the tenant (cursor)                      |
| POST   | `/auth/invite`            | invite by email, sends magic link                      |
| PATCH  | `/auth/users/:id/role`    | change role (Owner-only)                               |
| DELETE | `/auth/users/:id`         | disable user                                           |
| POST   | `/auth/change-password`   | with currentPassword check                             |
| POST   | `/auth/logout-everywhere` | revokes every active session + denylists access tokens |

**Endpoints (public):**

| Method | Path                    | Purpose                                      |
| ------ | ----------------------- | -------------------------------------------- |
| POST   | `/auth/register`        | new factory + Owner user                     |
| POST   | `/auth/login`           | returns access + refresh tokens              |
| POST   | `/auth/refresh`         | rotates refresh token (CSRF header required) |
| POST   | `/auth/logout`          | clears the cookie                            |
| POST   | `/auth/forgot-password` | initiate reset                               |
| POST   | `/auth/reset-password`  | with token from email                        |
| POST   | `/auth/verify-email`    | with token from registration                 |

**Security**: bcrypt cost ≥12, JWT HS256 (15m access / 7d refresh), refresh-token _family_ tracking + reuse detection, JWT denylist in Redis, CSRF header on `/refresh`, rate limit 5/15min per IP on sensitive endpoints.

### 5.2 inventory

**Owns:** physical stock — what is where, how it's moving.

**Models:** `Warehouse`, `ItemCategory`, `Item` (raw_material / finished_good / packaging / consumable), `StockBalance` (materialised view), `StockMovement` (append-only ledger).

**Critical invariant:** `stockMovements` is append-only. `stockBalances` is derived. The weekly `inventory.balance_audit` cron reconciles drift.

**Endpoints:** warehouses CRUD, categories CRUD, items CRUD, stock adjustments, stock transfers, item history (paginated), item balances, low-stock list, bulk import (CSV-style payload with atomic / partial mode).

**Notable internal hooks:**

- `incrementBalance` — atomic CAS upsert (`findOneAndUpdate` with `$inc`).
- `clearLowStockIfResolved` — called from PO receive to drop low-stock alerts when fresh stock arrives.

### 5.3 supplier

**Owns:** suppliers + the RFQ (Request For Quotation) flow.

**Models:** `Supplier` (with embedded contacts, documents, performance score), `QuotationRequest` (with embedded lines, supplier invitations, AI recommendation).

**Endpoints (supplier):** CRUD + contact array operations + document array operations + performance read + multi-supplier compare.

**Endpoints (quotation, private):** list, create RFQ, get, cancel, accept (auto-PO from chosen supplier's response), compare (deterministic numeric ranking + AI prose summary).

**Endpoints (quotation, public):** `POST /public/quotations/responses/:token` — invited supplier submits their quote without a JWT, gated by a one-time response token issued at RFQ creation.

### 5.4 po (purchase orders)

**Owns:** the procurement workflow.

**Models:** `PurchaseOrder` (with embedded lines, totals, approval, dispatch, cancellation, revisions, snapshots), `PoReceipt` (delivery records).

**State machine:**

```
draft ──► pending_approval ──► approved ──► sent ──► partially_received ──► fully_received ──► closed
   │              │                  │                │                                              ▲
   │              ├──► rejected ─────┘ (rejected can return to draft after edit)                    │
   │              │                                                                                  │
   ▼              ▼                                                                                  │
cancelled    cancelled              cancelled                       cancelled  ────────────────────►│
```

Enforced by `canTransition` + CAS `transitionState` (rejects on `state` mismatch, throws `PO_STATE_RACE`).

**Endpoints:** create, update (only draft / rejected), get, list, submit, approve, reject, dispatch (= `sendToSupplier`), cancel, close, receive (idempotent within remaining-quantity check), listReceipts, **createFromForecast** (AI-suggested order), **getPdfDownload** (re-presigns the R2 URL or generates PDF on demand).

**Dispatch:** generates the PDF via PDFKit, uploads to R2, persists the URL, transitions state, sends supplier email.

**Receive side effects (best-effort, never roll back the receipt):**

- Posts a `StockMovement` row + increments `StockBalance` per line.
- Calls `clearLowStockIfResolved` for each affected item.
- Re-enqueues a 30-day forecast for each affected item (with a 6h staleness pre-flight to avoid spamming a 200-line GRN).
- If fully received, sends `notifyPoFullyReceived` email to the requester.

### 5.5 ai

**Owns:** AI-driven forecasting and the weekly executive report.

**Models:** `Forecast` (per-item, per-horizon, with `provenance` block: provider, model, prompt version, latency, token counts, cache-hit), `AiUsage` (per-tenant per-month roll-up: tokens, calls, estimated cost in USD micros).

**Pipeline (`forecastPipeline.ts`):**

```
prepareForecastContext (180-day stock-movement window
   → daily/monthly bucketing
   → features: avg, median, CV, trend slope, lag-7/lag-30 autocorrelation,
     recency bias, sparsity classification)
        │
        ▼
renderForecastPrompt (versioned PromptTemplate, role + JSON schema +
                      few-shot for rich/sparse/empty cases)
        │
        ▼
ChatGroq (primary) ──[failure / parse error]──► ChatGoogleGenerativeAI (fallback)
        │                                                │
        │ per-provider circuit breaker                   │
        │ (3 fails → 60s cooldown)                       │
        ▼                                                ▼
            JSON extraction (strips fences / prose)
                       │
                       ▼
             coerceForecast (strict Zod → lenient repair → deterministic baseline)
                       │
                       ▼
             persist Forecast doc + Redis 24h cache + AiUsage roll-up
                       │
                       ▼
                socket emit ai.forecast.completed
```

**Endpoints:** generate single forecast, list, get, override, batch (BullMQ), usage snapshot.

**Cost control:** tier-based monthly token + call caps (`AI_QUOTAS` table). `checkQuota` runs _before_ the LLM call. Soft alert at 80% (85% enterprise).

**Weekly report (`reportGenerator.ts`):** aggregates 7-day metrics from movements + POs + suppliers + balances + forecasts → text pipeline → Markdown → HTML → Puppeteer PDF (graceful no-op without Chromium) → Resend email to factory owner.

### 5.6 rpt (reporting)

**Owns:** read-only analytics endpoints. Logic lives in aggregation pipelines (`rpt.aggregations.ts`); the service layer is a thin pass-through.

**Endpoints:** inventory turnover, spend by supplier, supplier cost comparison, cash flow projection, dead stock.

### 5.7 notification

**Owns:** in-app notification feed. Each notification is per-user (fan-out at write time). 90-day TTL.

**Endpoints:** list (cursor), unread count, mark-read (single, batch, or all).

### 5.8 billing

**Owns:** subscription state, invoices, gateway webhooks.

**Models:** `Subscription` (one per tenant), `Invoice`, `PaymentAttempt`.

**Endpoints:** plan catalogue, get current subscription, change tier, cancel, list invoices, **checkout-session (501)**, webhook ingestion (Stripe + SSLCommerz adapters stubbed — they audit-log the request but don't yet verify signatures).

---

## 6. Module-to-module wiring

This is the connection map. Every cross-module dependency is here.

### 6.1 The dependency graph

```
                    ┌────────┐
                    │  auth  │ (tenant root + JWT issuer)
                    └────┬───┘
                         │ tenantId, userId, role on every request
                         ▼
                ┌─────────────────────────────────────┐
                │  shared/middleware/tenant           │
                │  (resolveTenant + tenantScope)      │
                └─────────────────────────────────────┘
                         │
       ┌─────────────────┼──────────────────────────────────┐
       │                 │                                  │
       ▼                 ▼                                  ▼
┌───────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐
│ inventory │◄───│  supplier  │◄───│     po     │◄───│  billing   │
└───────┬───┘    └─────┬──────┘    └────┬───────┘    └────────────┘
        │              │                │
        │   readMovements,              │
        │   readItems   compareQuotes   │
        │              │   →via AI text │ createFromForecast
        ▼              ▼                ▼     reads latest forecast
┌────────────────────────────────────────────────────┐
│                       ai                           │ ◄──── enqueueForecast
│   prepareForecastContext reads inventory.movements │      (po.receive
│   forecastPipeline runs Groq+Gemini                │       triggers
│   reportGenerator aggregates from inventory+po+sup │       re-forecast)
└────────────────────────────────────────────────────┘
        │
        │ aggregation pipelines
        ▼
┌────────────┐    ┌────────────────┐
│    rpt     │    │  notification  │ (cross-cutting reads;
└────────────┘    └────────────────┘  no module owns it,
                                       services emit into it)
```

### 6.2 Specific wiring points (the ones that matter when something breaks)

| Caller                                      | Callee                                                                                                                                                                                                              | Purpose                                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `po.service.create`                         | `supplierRepository.findById`, `inventoryRepository.findWarehouseById`, `inventoryRepository.findItemById`                                                                                                          | Validate references + capture snapshots (sku/name/unit, supplier legalName/contact). Snapshots make POs immutable to upstream renames.                  |
| `po.service.sendToSupplier`                 | `Factory.findById`, `renderPoPdf`, `r2.uploadObject`, `notifyPoSentToSupplier` (→ `enqueueEmail`)                                                                                                                   | PDF + R2 upload + supplier email in one transition. PDF errors are best-effort.                                                                         |
| `po.service.receive`                        | `inventoryRepository.createMovement`, `inventoryRepository.incrementBalance`, then `applyPostReceiptSideEffects` → `inventoryRepository.clearLowStockIfResolved`, `enqueueForecast`, `notifyPoFullyReceived`        | The fan-out is best-effort; receipt persists even if a side-effect fails (receipt → stock → low-stock → forecast → email).                              |
| `po.service.createFromForecast`             | `aiRepository.findLatestForItem`, `inventoryRepository.findBalance`, `supplierRepository.findById`, `po.service.create`                                                                                             | Pulls 30-day forecast, subtracts on-hand, drafts a PO with the preferred supplier.                                                                      |
| `quotation.service.accept`                  | `quotationRepository.accept` (CAS), then `buildPoFromAcceptedQuote` → `po.service.create`                                                                                                                           | Auto-PO from the accepted supplier's response. PO draft failure does NOT roll back the quote acceptance; user can create the PO manually as a fallback. |
| `quotation.service.compareQuotes`           | `runTextPipeline` (AI module)                                                                                                                                                                                       | Deterministic numeric ranking + AI prose summary. Falls back to numbers-only if AI fails.                                                               |
| `ai.service.runForecastForItem`             | `Item.findOne`, `Supplier.findOne` (lead-time lookup), `prepareForecastContext` (reads `StockMovement`), `runForecastPipeline`, `aiRepository.create`, `redisCache.set`, `aiUsageRepository.increment`, socket emit | The full path each forecast walks. Has its own 6h rate-limit lock + 24h cache + tier quota gate.                                                        |
| `reportGenerator.generateWeeklyReport`      | `Factory`, `StockMovement`, `StockBalance`, `PurchaseOrder`, `Supplier`, `Forecast`, `runTextPipeline`, `markdownToHtml`, `renderHtmlToPdf` (Puppeteer), `emailClient.send`                                         | Reads from 5 modules; writes nothing back (audit log + email side effects only).                                                                        |
| `forecast.worker` (BullMQ)                  | `aiService.runForecastForItem`, Socket.io emits, `enqueueEmail` for batch summary                                                                                                                                   | Single-item and batch fan-out with progress events.                                                                                                     |
| `scheduled.worker` (BullMQ)                 | `QuotationRequest.updateOne` (expire), `notifyDeliveryOverdue` (`enqueueEmail`)                                                                                                                                     | Cron-style: quote expiry + PO overdue (7d past expected).                                                                                               |
| every privileged action across every module | `recordAudit`                                                                                                                                                                                                       | Single source of truth for "who did what". Sensitive keys are redacted before persist.                                                                  |
| every authenticated route                   | `tenancyPlugin` (Mongoose)                                                                                                                                                                                          | Auto-injects `tenantId` into queries and saves; `assertTenantOwns` is the IDOR guard returning 404 (not 403).                                           |

### 6.3 The rule of thumb for new endpoints

- Never read tenantId from the request body or URL. Take it from `req.context` (set by `resolveTenant`).
- Always call `assertTenantOwns(doc, ctx)` after a `findById` against a tenant-scoped collection. The model auto-filters by tenantId via the plugin, but the guard catches a deliberately-crafted ID from another tenant.
- Always call `recordAudit` for state changes; the audit log is the only durable cross-module trail.
- Return through `apiResponse` helpers (`ok`, `created`, `paginated`, `noContent`) so the response shape stays uniform.

---

## 7. Background jobs

All background work is BullMQ over Redis. Four queues, each drained by a dedicated worker process:

| Queue       | Worker file                   | Job kinds                                                                 | What enqueues it                                                                        |
| ----------- | ----------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `email`     | `workers/email.worker.ts`     | `email.send`                                                              | Every notification + report path.                                                       |
| `report`    | `workers/report.worker.ts`    | `report.weekly_digest`, `report.adhoc`                                    | Weekly cron (when wired) and ad-hoc requests.                                           |
| `forecast`  | `workers/forecast.worker.ts`  | `forecast.single_item`, `forecast.batch`                                  | UI batch button, PO receipt fan-out, manual single-item refresh.                        |
| `scheduled` | `workers/scheduled.worker.ts` | `scheduled.quotation.expiry_check`, `scheduled.po.delivery_overdue_check` | RFQ creation (delay = until validUntil), PO dispatch (delay = expectedDeliveryAt + 7d). |

Worker concurrency is intentionally low for AI-bound queues (3) to respect Groq's free-tier 30 RPM cap. Email worker is concurrency 5; scheduled is 4.

**Job retry policy:**

- email: 5 attempts, 5 min exponential backoff, dead-letters terminal failures into `emailDeliveries.state = 'failed'`.
- forecast: 2 attempts, 1 min backoff (LLM calls are flaky; aggressive retry costs money).
- scheduled: 1 attempt (a missed expiry / overdue check is recoverable from the next cron tick).
- report: 2 attempts, 5 min backoff.

---

## 8. Real-time events

Socket.io listens on `/realtime`. Authentication is JWT in the handshake `auth.token`. Clients auto-join `tenant:<tenantId>` and `user:<userId>` rooms; nothing else is accepted.

**Server-emitted events** (`shared/realtime/events.ts`):

| Event                         | Triggered by                        | Payload                                                        |
| ----------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| `system.connected`            | handshake success                   | `{ serverTime, sessionId }`                                    |
| `inventory.balance.changed`   | future hook on `incrementBalance`   | `{ itemId, warehouseId, quantity, lowStock, at }`              |
| `po.state.changed`            | every PO state transition           | `{ poId, fromState, toState, actorUserId, at }`                |
| `po.received`                 | PO receipt                          | per-receipt summary                                            |
| `supplier.score.recomputed`   | nightly `supplier.score_recompute`  | per-supplier delta                                             |
| `quote.response.received`     | invited supplier submits            | `{ quotationId, supplierId }`                                  |
| `ai.forecast.completed`       | every successful forecast           | `{ forecastId, itemId, horizonDays, confidence, generatedAt }` |
| `ai.forecast.batch.progress`  | each item in a batch                | `{ batchJobId, itemId, index, total, status }`                 |
| `ai.forecast.batch.completed` | batch worker finish                 | `{ batchJobId, total, succeeded, failed, durationMs }`         |
| `notification.created`        | new notification                    | `{ notificationId, category, title, link, createdAt }`         |
| `session.invalidated`         | logout-everywhere or reuse detected | `{ reason }`                                                   |

Clients can only emit `ping`. Anything else → connection killed and an audit-grade warn log line.

---

## 9. Security layer

Concise list — full mapping in `docs/SECURITY` (if you want me to split that out, ask).

- **JWT**: HS256, 15m access / 7d refresh, refresh-token _family_ tracking, reuse detection revokes the entire family, Redis access-token denylist with per-user "revoked-at" watermark for fast logout-everywhere.
- **RBAC**: capability matrix in `shared/auth/rbac.ts` — `roleHasCapability(role, capability)`. `rbacFor('inventory.item.create')` middleware on every privileged route.
- **Tenant isolation** (3 control points): JWT-only context → AsyncLocalStorage → `tenancyPlugin` (Mongoose hooks) → `assertTenantOwns` (404 on cross-tenant).
- **Validation**: Zod at every boundary (body, params, query). Mongoose typed queries. HTML escape on rendered content (PDF, email).
- **Rate limiting**: per-IP unauth (60/min), per-IP auth (600/min), per-tenant (6000/min), login per-email (10/15min), refresh per-IP (12/min), **auth sensitive per-IP (5/15min)**, **AI per-tenant (10/min, sliding window)**, **upload per-tenant (20/hr, sliding window)**, **webhook (1000/min)**.
- **Headers**: helmet with CSP `default-src 'none'`, HSTS in prod, frameguard deny, referrerPolicy strict-origin.
- **Field encryption**: AES-256-GCM with versioned envelope + key rotation chain.
- **File uploads**: MIME allowlist + magic-byte sniff + size cap + path-traversal guard + pluggable virus scanner.
- **Audit log**: every privileged action via `recordAudit`; sensitive keys redacted before persist.
- **CSRF**: `X-CSRF` header required on `/refresh`.

---

## 10. AI pipeline

End-to-end one more time, in sequence:

1. **Trigger.** A user POSTs `/ai/forecasts` (synchronous), or PO receipt fans out, or the dashboard "Run all" button hits `/ai/forecasts/batch`, or scheduled cron in the future.
2. **Quota gate.** `checkQuota(tenantId, tier, callKind, estimatedTokens)` — pre-flight against the monthly cap. Fails with `AI_QUOTA_EXCEEDED` before we spend a dollar.
3. **Per-item rate-limit lock.** `redisCache.set(...{ NX, EX: 6h })` — prevents thrashing the same item.
4. **Cache read.** Redis 24h cache; if hit, return. Else fall through.
5. **Data prep.** `prepareForecastContext` — 180 days of `StockMovement` rows for the item, bucket daily/monthly, compute features (mean, median, CV, trend slope, lag-7/30 autocorrelation, recency bias, sparsity).
6. **Prompt.** `renderForecastPrompt` — versioned `forecast-v1.0.0`. Strict JSON schema, three few-shot examples (rich, sparse, empty), explicit edge-case rules.
7. **LLM.** `runForecastPipeline`:
   - Groq first (Llama 3.3 70B). Per-provider circuit breaker; 3 consecutive failures → 60s cooldown.
   - On Groq failure or parse error → Gemini 1.5 Flash.
   - Both fail → deterministic baseline (always returns a usable answer; never throws).
8. **Parse + repair.** `extractJsonObject` strips fences and prose. `coerceForecast` runs strict Zod first; on failure the lenient repair pass merges what came back with the deterministic baseline so partial responses don't break the API.
9. **Persist.** `Forecast` doc with full provenance (provider, model, latency, token counts, cache hit, prompt version, raw prompt, raw response).
10. **Roll-up.** `aiUsageRepository.increment` — adds tokens + 1 forecast call + estimated cost (USD micros) to this month's `AiUsage` row.
11. **Cache write.** Redis 24h.
12. **Socket emit.** `ai.forecast.completed` to `tenant:<tenantId>`.
13. **Audit.** `recordAudit({ action: AiForecastGenerated, ... })`.

Weekly report follows the same circuit-breaker-protected text pipeline (no JSON contract; Markdown out), but reads from five modules to assemble metrics first.

---

## 11. Error envelope and shared codes

Every error response has the same shape:

```json
{
  "error": {
    "code": "PO_INVALID_STATE_TRANSITION",
    "message": "Cannot approve PO in state draft",
    "details": { "from": "draft", "to": "approved" },
    "requestId": "req_01HXY..."
  }
}
```

Codes are stable strings (clients depend on them — see `shared/errors/errorCodes.ts`). The handler maps `AppError` subclasses (`BadRequestError`, `ConflictError`, `NotFoundError`, `UnauthorizedError`, `ForbiddenError`, `TooManyRequestsError`, `NotImplementedError`) to the right status code automatically.

Notable codes you'll hit during testing:

- `AUTH_TOKEN_MISSING`, `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED`, `AUTH_REFRESH_REUSE_DETECTED`
- `RBAC_CAPABILITY_DENIED` (you logged in as Viewer and tried to create something)
- `TENANCY_VIOLATION` (cross-tenant access — shouldn't happen with the plugin, but the guard exists)
- `RATE_LIMITED`, `AI_QUOTA_EXCEEDED`
- `PO_INVALID_STATE_TRANSITION`, `PO_NO_LINES`, `PO_STATE_RACE`
- `STOCK_INSUFFICIENT`, `STOCK_NEGATIVE_NOT_ALLOWED`
- `QUOTE_INVALID_TOKEN`, `QUOTE_ALREADY_RESPONDED`, `QUOTE_EXPIRED`
- `NOT_IMPLEMENTED` (billing checkout, future stubs)

---

## 12. End-to-end test workflows

The Postman collection (`docs/postman/api.collection.json`) is structured to walk these flows in order. After importing both files, set `{{baseUrl}}` to `http://localhost:4000/api/v1` in the environment.

### Flow A — onboarding + first inventory item

1. `POST /auth/register` — creates a factory + Owner user. Saves `accessToken`, `refreshToken`, `tenantId`, `userId` to the environment automatically (test script).
2. `GET /auth/me` — sanity check the JWT.
3. `POST /inventory/warehouses` — create your default warehouse. Save returned `id` to `{{warehouseId}}`.
4. `POST /inventory/categories` — optional; create a category. Save `{{categoryId}}`.
5. `POST /inventory/items` — create your first item. Save `{{itemId}}`.
6. `POST /inventory/items/:id/adjust` — opening balance: `quantityDelta: 500`, `reasonCode: 'opening'`. Item now has stock.

### Flow B — supplier + RFQ + auto-PO

7. `POST /suppliers` — create one supplier with one contact (set `isPrimary: true`). Save `{{supplierId}}`.
8. `POST /quotations` — RFQ with one line for `{{itemId}}`, invite `{{supplierId}}`. Save `{{quotationId}}`. Note the `responseToken` returned in `supplierInvitations[0].responseToken` from `GET /quotations/:id` — save as `{{quoteToken}}`.
9. `POST /public/quotations/responses/:token` — submit a response without auth (clear the bearer auth on this request). Save token in URL.
10. `GET /quotations/:id/compare` — see the deterministic ranking and (if Groq/Gemini is set) the AI prose summary.
11. `POST /quotations/:id/accept` — body `{ "supplierId": "{{supplierId}}" }`. The response includes a `purchaseOrder` object; save `{{poId}}`.

### Flow C — PO lifecycle

12. `POST /purchase-orders/:id/submit` — moves to `pending_approval`.
13. `POST /purchase-orders/:id/approve` — moves to `approved`. PDF is generated in the background; check `pdfUrl` after a moment via `GET /purchase-orders/:id`.
14. `POST /purchase-orders/:id/dispatch` — body `{ "sentTo": "supplier@example.com" }`. Generates PDF (if not yet), uploads to R2, transitions to `sent`, sends email.
15. `POST /purchase-orders/:id/receipts` — record a partial receipt (`quantity` < `quantityOrdered`). State → `partially_received`. Stock balance updates. Forecast retriggers.
16. `POST /purchase-orders/:id/receipts` — record the rest. State → `fully_received`. Confirmation email sent.
17. `POST /purchase-orders/:id/close` — terminal state.

### Flow D — AI forecast

18. `POST /ai/forecasts` — body `{ "itemId": "{{itemId}}", "horizonDays": 30 }`. Returns the persisted forecast. Without Groq/Gemini keys you get the deterministic baseline.
19. `GET /ai/forecasts` — see the forecast in the list.
20. `POST /ai/forecasts/:id/override` — manual override with justification.
21. `GET /ai/usage` — current-month usage vs cap.
22. `POST /ai/forecasts/batch` — body `{}` to forecast every item. Watch the worker log in Terminal 2 — it processes one item at a time and emits Socket.IO progress events.

### Flow E — analytics

23. `GET /reports/inventory-turnover?from=2026-01-01T00:00:00Z&to=2026-04-29T00:00:00Z`
24. `GET /reports/spend-by-supplier?from=...&to=...`
25. `GET /reports/cash-flow-projection`
26. `GET /reports/dead-stock?from=...&to=...`

### Flow F — billing (mostly stubs)

27. `GET /billing/plans` — works, returns plan catalogue.
28. `GET /billing/subscription` — returns current subscription if seeded; 404 otherwise.
29. `POST /billing/checkout-session` — returns 501 NotImplemented until gateway adapters land.

---

## 13. Common issues

**"AUTH_TOKEN_MISSING" on every request.**
Set the `Authorization: Bearer {{accessToken}}` header. The collection inherits this from the Auth folder; if you copied a request out, re-attach the auth.

**"RATE_LIMITED" out of nowhere.**
You're hitting the per-IP unauth limiter on `/auth/login` (5/15min). Wait or change IP. Redis stores the counter under `rl:auth-sensitive:<ip>`; flushing that key resets it.

**"PO_INVALID_STATE_TRANSITION" when approving.**
The PO is not in `pending_approval`. Always submit before approving.

**"AI_QUOTA_EXCEEDED" on the trial tier.**
Trial is capped at 50 forecast calls / 100k tokens per month. Bump tier on the Subscription model, or wait for next month.

**"Cannot find module 'puppeteer-core'" when generating the weekly report.**
Expected on a dev box without Chromium. The report will email Markdown only. Install `puppeteer` (full bundle) or set `CHROMIUM_PATH` and use `puppeteer-core`.

**Forecast returns generic "deterministic baseline" reasoning every time.**
Either `GROQ_API_KEY` and `GEMINI_API_KEY` are both missing, or both are tripping their circuit breakers. Check the API logs for `ai.circuit_breaker.open`.

**Worker process crashes on boot.**
Most likely missing `MONGO_URI` or `REDIS_URL`. The env validator (`config/env.ts`) prints the failing field name.

**WebSocket events don't fire in Postman.**
Postman only does HTTP. Use `wscat -c ws://localhost:4000/realtime` (with the JWT in the auth handshake) or browser devtools, or skip real-time tests until the frontend is up.

---

## Appendix — one-line elevator pitch for stakeholders

> A multi-tenant SaaS backend for Bangladeshi factories: every inventory item, supplier, quotation, and purchase order is tracked end-to-end; AI predicts what to reorder and when, sends weekly executive briefings as PDFs, and the whole thing runs as a modular Node.js + MongoDB system with strict tenant isolation, role-based access, AI cost governance, and a state-machine-driven procurement workflow.
