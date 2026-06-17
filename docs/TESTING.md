# How to test the backend end-to-end

This is the hands-on companion to [BACKEND.md](BACKEND.md) and [ARCHITECTURE.md](ARCHITECTURE.md). Follow it top to bottom and you will have validated every layer of the system.

It covers, in order:

1. [What you need installed](#1-what-you-need-installed)
2. [Setting up Redis (the most-asked-about piece)](#2-setting-up-redis)
3. [Setting up MongoDB](#3-setting-up-mongodb)
4. [The full `.env` walkthrough](#4-the-full-env-walkthrough)
5. [Installing and starting the project](#5-installing-and-starting-the-project)
6. [Health checks before you open Postman](#6-health-checks)
7. [Importing the Postman collection](#7-importing-the-postman-collection)
8. [Phase-by-phase API testing playbook](#8-phase-by-phase-api-testing-playbook)
9. [How AI behaves at every step (with and without API keys)](#9-how-ai-behaves) 10.[How to verify the worker process is doing its job](#10-how-to-verify-the-worker) 11.[Testing real-time events (WebSockets)](#11-testing-real-time-events) 12.[Troubleshooting](#12-troubleshooting)

---

## 1. What you need installed

| Tool                       | Version                   | Why                                                                                   |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------- |
| **Node.js**                | 20 LTS (>= 20.0.0)        | The codebase uses ESM + native `--env-file` (Node 20+). Anything older fails to boot. |
| **npm**                    | 10+                       | Comes with Node 20.                                                                   |
| **MongoDB**                | 7+ (replica set or Atlas) | Persistent state for every collection.                                                |
| **Redis**                  | 7+                        | Rate limiting, BullMQ queues, idempotency cache, AI result cache, Socket.io adapter.  |
| **Postman**                | latest                    | Hitting the APIs.                                                                     |
| **mongosh** _(optional)_   | 2+                        | Reading from Mongo (e.g. harvesting the quote response token).                        |
| **Docker** _(recommended)_ | latest                    | Easiest way to run Mongo + Redis locally.                                             |

Verify Node:

```bash
node --version    # v20.x.x  (anything below 20 → upgrade first)
```

---

## 2. Setting up Redis

**Redis is mandatory.** The API and worker processes will not boot without it. If `REDIS_URL` is missing or unreachable, every request will fail and the env validator will print the exact missing field at startup.

### What Redis is used for

The codebase opens **four separate Redis connections** (see `backend/src/config/redis.ts`) — they share the same Redis server but each has its own role:

| Connection     | Used by                                                           | Why separate                                                                     |
| -------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `redisCache`   | rate limiting, idempotency cache, AI result cache, token denylist | Read/write commands                                                              |
| `redisQueue`   | BullMQ queues (email, report, forecast, scheduled)                | BullMQ blocks long-poll commands; mixing with cache causes head-of-line blocking |
| `redisSockPub` | Socket.io publish channel                                         | Pub/sub commands take over the connection                                        |
| `redisSockSub` | Socket.io subscribe channel                                       | Same — pub and sub need separate connections                                     |

You do **not** need four servers — you need four _connections_ to the _same_ server. The code handles this automatically.

### Option A: Docker (recommended for local dev)

If you have Docker installed, this is the easiest:

```bash
docker run -d \
  --name scp-redis \
  -p 6379:6379 \
  --restart unless-stopped \
  redis:7-alpine
```

Verify it's up:

```bash
docker ps | grep scp-redis
docker exec scp-redis redis-cli PING    # expect PONG
```

Connection string for `.env`:

```bash
REDIS_URL=redis://localhost:6379
REDIS_TLS=false
```

### Option B: Native install (Linux)

```bash
# Ubuntu / Debian
sudo apt update
sudo apt install redis-server -y
sudo systemctl enable --now redis-server

# Verify
redis-cli PING    # expect PONG
```

```bash
# Fedora / RHEL
sudo dnf install redis -y
sudo systemctl enable --now redis
redis-cli PING
```

```bash
# macOS (Homebrew)
brew install redis
brew services start redis
redis-cli PING
```

`.env` is identical to Docker:

```bash
REDIS_URL=redis://localhost:6379
REDIS_TLS=false
```

### Option C: Native install (Windows)

Redis isn't officially supported on Windows. Pick one:

1. **WSL2** (best): install Ubuntu in WSL, then follow Option B inside WSL.
2. **Memurai** (Redis-compatible Windows port): https://www.memurai.com/ — runs as a Windows service.
3. **Docker Desktop**: follow Option A.

### Option D: Cloud Redis (no install)

If you don't want to run anything locally, use a free cloud Redis. Two good options:

**Upstash** (free tier, no credit card):

1. Sign up at https://upstash.com
2. Create a database (region close to you)
3. Copy the "Redis Connect URL" — it looks like `rediss://default:<password>@<host>.upstash.io:6379`
4. Note the `rediss://` (with two `s`) — that's TLS. Set `REDIS_TLS=true` in `.env`.

```bash
REDIS_URL=rediss://default:abc123xyz@us1-helping-hyena-12345.upstash.io:6379
REDIS_TLS=true
```

**Render Redis add-on** (paid, for production): managed inside the same Render account as the API.

### How the project connects

When the API or worker boots, `config/redis.ts` runs:

```ts
const client = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  tls: env.REDIS_TLS ? {} : undefined,
});
```

It opens four such clients (one per role) and waits for all to be `ready` before serving traffic. The `readyz` endpoint (see §6) returns `false` for `redis` until all four are connected.

### Verifying Redis is reachable from the project

Once the API is running, hit:

```bash
curl http://localhost:4000/readyz
# expect {"ok":true,"deps":{"mongo":true,"redis":true}}
```

If `redis: false`:

- Wrong port (default is 6379)
- Wrong host (use `localhost` for Docker/native, the cloud host for Upstash)
- TLS mismatch (cloud usually requires `REDIS_TLS=true`; local does not)
- Authentication needed but password missing from URL

To debug from the command line:

```bash
# Local Redis
redis-cli -u "$REDIS_URL" PING

# Upstash (TLS)
redis-cli --tls -u "$REDIS_URL" PING
```

If `redis-cli` returns `PONG` but the project still shows `redis: false`, restart both `npm run dev` and `npm run dev:worker` after fixing `.env`.

---

## 3. Setting up MongoDB

You have three good options:

### Option A: Docker

```bash
# MongoDB requires a replica set for some features (transactions); we run a single-node RS:
docker run -d \
  --name scp-mongo \
  -p 27017:27017 \
  --restart unless-stopped \
  mongo:7 \
  --replSet rs0 --bind_ip_all

# Initialise the replica set (one-time)
docker exec scp-mongo mongosh --eval "rs.initiate()"
```

Connection string:

```bash
MONGO_URI=mongodb://localhost:27017/scp_dev?replicaSet=rs0
```

### Option B: MongoDB Atlas (cloud, free tier, recommended)

1. Sign up at https://cloud.mongodb.com
2. Create a free cluster (M0 tier, 512 MB)
3. Database Access → add a user with read/write to any database
4. Network Access → add IP `0.0.0.0/0` for dev (lock this down for prod)
5. Connect → "Drivers" → copy the connection string

Connection string looks like:

```bash
MONGO_URI=mongodb+srv://<user>:<password>@cluster0.abcde.mongodb.net/scp_dev?retryWrites=true&w=majority
```

### Option C: Native install (not recommended for Windows / new users)

Use Docker or Atlas instead unless you have a strong reason.

---

## 4. The full `.env` walkthrough

Create `backend/.env`. **Required** vars must be set or the app refuses to boot. **Optional** vars degrade gracefully if missing.

### Required

| Variable             | What it is                                             | Example value                           | What if missing            |
| -------------------- | ------------------------------------------------------ | --------------------------------------- | -------------------------- |
| `NODE_ENV`           | Environment label                                      | `development`                           | Defaults to `development`. |
| `PORT`               | API HTTP port                                          | `4000`                                  | Defaults to `4000`.        |
| `LOG_LEVEL`          | Pino log level                                         | `debug` for dev, `info` for prod        | Defaults to `info`.        |
| `MONGO_URI`          | MongoDB connection string                              | `mongodb://localhost:27017/scp_dev`     | **App refuses to boot.**   |
| `REDIS_URL`          | Redis connection string                                | `redis://localhost:6379`                | **App refuses to boot.**   |
| `REDIS_TLS`          | Whether Redis uses TLS                                 | `false` (local), `true` (Upstash)       | Defaults to `false`.       |
| `JWT_ACCESS_SECRET`  | HS256 signing key, ≥32 chars                           | Generate with `openssl rand -base64 48` | **App refuses to boot.**   |
| `JWT_REFRESH_SECRET` | HS256 signing key, ≥32 chars (must differ from access) | Generate with `openssl rand -base64 48` | **App refuses to boot.**   |
| `BCRYPT_COST`        | Password hashing cost                                  | `12` (must be ≥ 12)                     | Defaults to `12`.          |

Generate JWT secrets right now:

```bash
openssl rand -base64 48    # use the output as JWT_ACCESS_SECRET
openssl rand -base64 48    # different output for JWT_REFRESH_SECRET
```

### Recommended (have sensible defaults but you'll want to set them)

| Variable                    | What it is                  | Default if missing        | When you'd change it                                                 |
| --------------------------- | --------------------------- | ------------------------- | -------------------------------------------------------------------- |
| `JWT_ACCESS_TTL`            | Access token lifetime       | `15m`                     | Shorten for security demo, lengthen for ergonomics                   |
| `JWT_REFRESH_TTL`           | Refresh token lifetime      | `7d`                      | Shorten in production-grade                                          |
| `JWT_ISSUER`                | JWT `iss` claim             | `scp-platform`            | Multi-environment deployments                                        |
| `JWT_AUDIENCE`              | JWT `aud` claim             | `scp-platform-clients`    | Same                                                                 |
| `CORS_ORIGINS`              | Comma-separated allowlist   | empty (no origin allowed) | Add your frontend URL: `http://localhost:3000,http://localhost:5173` |
| `COOKIE_DOMAIN`             | Refresh-token cookie domain | `localhost`               | Set to your domain in prod                                           |
| `COOKIE_SECURE`             | HTTPS-only cookie flag      | `false` (dev)             | `true` in prod                                                       |
| `FRONTEND_BASE_URL`         | Used in email deep links    | `http://localhost:3000`   | Set to deployed frontend URL                                         |
| `RATE_LIMIT_UNAUTH_PER_MIN` | Per-IP unauth limit         | `60`                      | Tighten for hostile environments                                     |
| `RATE_LIMIT_AUTH_PER_MIN`   | Per-IP auth limit           | `600`                     |                                                                      |
| `RATE_LIMIT_TENANT_PER_MIN` | Per-tenant limit            | `6000`                    |                                                                      |

### Optional (the system degrades gracefully without these)

These services unlock specific features but the API still works without them:

| Variable                                                                                | Feature it unlocks                      | What happens without it                                                      |
| --------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| `RESEND_API_KEY`                                                                        | Real email delivery (Resend)            | All emails log `email.stub_send`; no real email sent.                        |
| `EMAIL_FROM` / `EMAIL_REPLY_TO`                                                         | "From" address on emails                | Defaults to `noreply@factory.bd` / `support@factory.bd`.                     |
| `GROQ_API_KEY`                                                                          | Primary AI provider (Llama 3.3 70B)     | Forecast pipeline falls through to Gemini → deterministic baseline.          |
| `GROQ_MODEL`                                                                            | Override Groq model name                | Defaults to `llama-3.3-70b-versatile`.                                       |
| `GEMINI_API_KEY`                                                                        | Fallback AI provider (Gemini 1.5 Flash) | Forecast pipeline → deterministic baseline if both keys missing.             |
| `GEMINI_MODEL`                                                                          | Override Gemini model name              | Defaults to `gemini-1.5-flash`.                                              |
| `AI_PER_CALL_TIMEOUT_MS`                                                                | Per-LLM-call timeout                    | Defaults to `30000` (30s).                                                   |
| `AI_FAILURE_THRESHOLD`                                                                  | Circuit breaker trip count              | Defaults to `3` consecutive failures.                                        |
| `AI_COOLDOWN_MS`                                                                        | Circuit breaker open duration           | Defaults to `60000` (60s).                                                   |
| `FIELD_ENCRYPTION_KEY`                                                                  | AES-256-GCM at-rest encryption          | Encrypt-helper throws if used (no encrypted fields written by default).      |
| `FIELD_ENCRYPTION_KEY_PREVIOUS`                                                         | Old keys for decrypt during rotation    | Optional even when encryption is on.                                         |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT` | Cloudflare R2 file uploads              | PDF uploads return `stub://r2/...` URL. The PDF buffer still gets generated. |
| `R2_PUBLIC_URL_TTL_SECONDS`                                                             | Presigned URL TTL                       | Defaults to `300` (5 min).                                                   |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                                            | Stripe billing                          | Checkout endpoint returns 501. Webhooks accept but don't dispatch.           |
| `SSLCOMMERZ_STORE_ID`, `SSLCOMMERZ_STORE_PASSWORD`, `SSLCOMMERZ_IS_LIVE`                | SSLCommerz billing                      | Same as Stripe — 501 / accept-only.                                          |
| `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`                                               | Sentry error tracking                   | Errors only logged to stdout.                                                |

### Where to get the API keys

- **Groq**: https://console.groq.com → API Keys (free tier, 30 RPM)
- **Gemini**: https://aistudio.google.com → API Keys (free tier, generous)
- **Resend**: https://resend.com → API Keys (free 100 emails/day)
- **Cloudflare R2**: Cloudflare dashboard → R2 → Manage Tokens (10 GB free/month)
- **Stripe**: https://dashboard.stripe.com → Developers → API keys (use test keys in dev)

### A complete dev `.env` to copy-paste

This is the minimum viable file for a fully working local setup with stubbed external services:

```bash
# === Core ===
NODE_ENV=development
PORT=4000
LOG_LEVEL=debug
GIT_SHA=local

# === Database (use ONE of these blocks) ===
# Local Mongo via Docker single-node RS
MONGO_URI=mongodb://localhost:27017/scp_dev?replicaSet=rs0
# Or Atlas (free tier):
# MONGO_URI=mongodb+srv://USER:PASS@cluster0.abc.mongodb.net/scp_dev?retryWrites=true&w=majority

MONGO_MAX_POOL_SIZE=20
MONGO_MIN_POOL_SIZE=5

# === Redis (use ONE of these blocks) ===
# Local
REDIS_URL=redis://localhost:6379
REDIS_TLS=false
# Or Upstash (TLS):
# REDIS_URL=rediss://default:PASS@us1-host-12345.upstash.io:6379
# REDIS_TLS=true

# === JWT (REQUIRED — generate fresh) ===
JWT_ACCESS_SECRET=PASTE_OUTPUT_OF_openssl_rand_base64_48_HERE
JWT_REFRESH_SECRET=PASTE_DIFFERENT_OUTPUT_HERE
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
JWT_ISSUER=scp-platform
JWT_AUDIENCE=scp-platform-clients

BCRYPT_COST=12

# === Cookies + CORS ===
COOKIE_DOMAIN=localhost
COOKIE_SECURE=false
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
FRONTEND_BASE_URL=http://localhost:3000

# === Rate limits (defaults are fine) ===
RATE_LIMIT_UNAUTH_PER_MIN=60
RATE_LIMIT_AUTH_PER_MIN=600
RATE_LIMIT_TENANT_PER_MIN=6000

# === Optional services — add later as you wire them ===
RESEND_API_KEY=
EMAIL_FROM=noreply@factory.bd
EMAIL_REPLY_TO=support@factory.bd

GROQ_API_KEY=
GROQ_MODEL=llama-3.3-70b-versatile
GEMINI_API_KEY=
GEMINI_MODEL=gemini-1.5-flash
AI_PER_CALL_TIMEOUT_MS=30000
AI_FAILURE_THRESHOLD=3
AI_COOLDOWN_MS=60000

FIELD_ENCRYPTION_KEY=
FIELD_ENCRYPTION_KEY_PREVIOUS=

R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_ENDPOINT=
R2_PUBLIC_URL_TTL_SECONDS=300

STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
SSLCOMMERZ_STORE_ID=
SSLCOMMERZ_STORE_PASSWORD=
SSLCOMMERZ_IS_LIVE=false

SENTRY_DSN=
```

**Generate the JWT secrets right now:**

```bash
echo "JWT_ACCESS_SECRET=$(openssl rand -base64 48)"
echo "JWT_REFRESH_SECRET=$(openssl rand -base64 48)"
```

Copy each line into the `.env` (without the `echo` prefix).

---

## 5. Installing and starting the project

```bash
cd backend
npm install
```

This installs ~900 packages including LangChain, BullMQ, Mongoose, PDFKit, AWS SDK, Resend, etc.

**Two terminals.** Both must be running for full functionality:

```bash
# Terminal 1 — API server
npm run dev
```

You'll see Pino logs in pretty format. Look for:

```
{"event":"redis.connect","role":"cache"}
{"event":"redis.connect","role":"queue"}
{"event":"redis.connect","role":"sock-pub"}
{"event":"redis.connect","role":"sock-sub"}
{"event":"socket.server_ready"}
{"event":"app.ready","port":4000}
```

If you see `redis.error` or the process exits with `Invalid environment variables`, fix the offending env var and restart.

```bash
# Terminal 2 — BullMQ worker
npm run dev:worker
```

You'll see:

```
{"event":"worker.ready","queues":["email","report","forecast","scheduled"]}
```

The worker is now listening for jobs. Most of the time it will be idle.

---

## 6. Health checks

Before opening Postman, run these:

```bash
curl http://localhost:4000/healthz
# Expected: {"status":"ok","uptime":12.3,"version":"local"}
```

`healthz` is liveness — it confirms the process is running. It does **not** check Mongo/Redis.

```bash
curl http://localhost:4000/readyz
# Expected: {"ok":true,"deps":{"mongo":true,"redis":true}}
```

`readyz` is readiness — it confirms Mongo + Redis are reachable. **If `mongo:false` or `redis:false`, fix that before testing.** A 503 here means the dependencies are not connected.

---

## 7. Importing the Postman collection

Files (already in this repo):

- [`docs/postman/api.collection.json`](postman/api.collection.json) — 78 requests in 15 folders
- [`docs/postman/api.environment.json`](postman/api.environment.json) — environment variables

In Postman:

1. **File → Import** → drop both JSON files into the dialog.
2. Top-right environment selector → choose **SCP Platform - Local Dev**.
3. Confirm `{{baseUrl}}` is `http://localhost:4000/api/v1`.

The collection sets `Authorization: Bearer {{accessToken}}` at the collection level. The Login/Register requests have test scripts that auto-save tokens, so subsequent calls work without manual copy-paste.

---

## 8. Phase-by-phase API testing playbook

This is the critical section. **Follow the order strictly** — most phases depend on state from earlier phases.

Each phase below has:

- **Folder → Request** — exact path in the Postman collection
- **What it does** — what the call accomplishes
- **What to verify** — what success looks like
- **What it proves** — the architectural concept the call validates

### Phase 1 — Onboarding (creates the tenant + first user)

| Step | Request                                                                   | What to verify                                                                                 | What it proves                                                                                                     |
| ---- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1    | `01 - Auth (Public)` → **Register Factory + Owner**                       | `201 Created`. Env vars `accessToken`, `refreshToken`, `tenantId`, `userId` are now populated. | Factory + Owner User + trial Subscription + first refresh-token family all created in one transaction. JWT issued. |
| 2    | `02 - Auth (Private)` → **Get Me**                                        | `200`. Returns the user you just registered.                                                   | JWT verification works. `resolveTenant` middleware built `req.context` from JWT claims only.                       |
| 3    | `01 - Auth (Public)` → **Refresh Token**                                  | `200`. `accessToken` and `refreshToken` change.                                                | Refresh-token rotation + family tracking works. The old refresh token is now revoked.                              |
| 4    | `01 - Auth (Public)` → **Refresh Token** _(again with the now-old token)_ | `401`, code `AUTH_REFRESH_REUSE_DETECTED`.                                                     | Reuse detection fires. **The whole token family is revoked**, so the user must log in again.                       |
| 5    | `01 - Auth (Public)` → **Login**                                          | `200`. New tokens issued.                                                                      | Recovery from a reuse event works.                                                                                 |

After Phase 1: you have a tenant, an owner, and fresh tokens.

### Phase 2 — Master data (3 requests, in order)

| Step | Request                                              | Saves to env  | Why                                                                                |
| ---- | ---------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| 6    | `03 - Inventory - Warehouses` → **Create Warehouse** | `warehouseId` | Stock has to live somewhere.                                                       |
| 7    | `04 - Inventory - Categories` → **Create Category**  | `categoryId`  | Items belong to categories.                                                        |
| 8    | `05 - Inventory - Items` → **Create Item**           | `itemId`      | The thing you'll order, stock, and forecast. The body references `{{categoryId}}`. |

**What this phase proves:**

- The `tenancyPlugin` auto-injects `tenantId` on every save (your request body never sent one).
- Zod validation runs (try sending `unit: "wxyz"` — you get 400 with `VALIDATION_FAILED`).
- The `Capability` matrix is enforced — Owner role has `inventory.item.create`, so this passes.

### Phase 3 — Stock the warehouse (3 requests)

| Step | Request                                                                          | Quantity | What runs internally                                                                                       |
| ---- | -------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| 9    | `06 - Inventory - Stock & Reports` → **Adjust Stock (positive opening balance)** | +500     | New `StockMovement` row (append-only ledger). `StockBalance` upserted to 500 via atomic CAS. Audit logged. |
| 10   | `06 - Inventory - Stock & Reports` → **Item Balances (per warehouse)**           | —        | Reads materialised view. Shows 500 in your warehouse.                                                      |
| 11   | `06 - Inventory - Stock & Reports` → **Item Movement History**                   | —        | Reads ledger. One row, type `adjustment`, qty 500.                                                         |

**What this phase proves:** the append-only ledger pattern + materialised balance + atomic CAS upserts. Now the AI has data to read in Phase 7.

### Phase 4 — Suppliers (3 requests)

| Step | Request                                       | Saves              |
| ---- | --------------------------------------------- | ------------------ |
| 12   | `07 - Suppliers` → **Create Supplier**        | `supplierId`       |
| 13   | `07 - Suppliers` → **Create Second Supplier** | `secondSupplierId` |
| 14   | `07 - Suppliers` → **Compare Suppliers**      | — (read only)      |

You can also test embedded array operations:

- `Add Contact` → adds to the supplier's `contacts[]`
- `Update Contact (by index)` → mutates a specific position
- `Remove Contact (by index)` → removes by index

These prove the embedded-array CRUD pattern.

### Phase 5 — RFQ → quote acceptance → auto-PO (5 requests)

| Step | Request                                                            | What happens                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 15   | `08 - Quotations (Private)` → **Create Quotation Request**         | RFQ created with two invited suppliers. Each invitation has a one-time `responseToken`. **A scheduled expiry job is enqueued** with delay = `validUntil - now`. Saves `quotationId`. |
| 16   | `08 - Quotations (Private)` → **Get Quotation**                    | Reads RFQ. Note: `responseToken` is **NOT exposed** by the API (it's PII).                                                                                                           |
| 17   | _(manual)_                                                         | **Harvest the response token from MongoDB** so you can test the public endpoint. See note below.                                                                                     |
| 18   | `09 - Quotations (Public, no JWT)` → **Submit Quotation Response** | Public endpoint, no JWT. Uses `{{quoteToken}}`. Run twice (once per supplier) by changing the token.                                                                                 |
| 19   | `08 - Quotations (Private)` → **Compare Quotes**                   | Returns numeric ranking + AI prose summary (or numeric-only without AI keys).                                                                                                        |
| 20   | `08 - Quotations (Private)` → **Accept Quotation**                 | Auto-builds a draft PO from the chosen supplier's response. Test script auto-saves `poId`.                                                                                           |

**Harvesting the response token:**

```bash
mongosh "$MONGO_URI" --eval '
  db.quotationrequests.findOne({}, { number: 1, supplierInvitations: 1 })
'
```

Copy `responseToken` from the output → paste into the env var `quoteToken`.

**What this phase proves:**

- Public token-gated endpoints work without JWT.
- The AI text pipeline runs (or gracefully returns numeric ranking when keys missing).
- Cross-module orchestration: `quotation.service.accept` → `po.service.create` builds a PO programmatically.
- Scheduled jobs are enqueued with delay (BullMQ delayed job).

### Phase 6 — PO state machine (8 requests, strict order)

This is the core procurement workflow. **Order matters.**

| Step | Request                                               | State transition                        | Side effects                                                                                                                 |
| ---- | ----------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 21   | `10 - Purchase Orders` → **Get PO**                   | — (state should be `draft`)             | —                                                                                                                            |
| 22   | `10 - Purchase Orders` → **Submit PO for Approval**   | `draft` → `pending_approval`            | `approval.submittedAt` set. Email enqueued to managers/owner.                                                                |
| 23   | `10 - Purchase Orders` → **Approve PO**               | `pending_approval` → `approved`         | `approvedAt` set. **Background:** PDF rendered + uploaded to R2 (or stub URL). Email enqueued to requester.                  |
| 24   | `10 - Purchase Orders` → **Get PO** _(refresh)_       | —                                       | `pdfUrl` is now set.                                                                                                         |
| 25   | `10 - Purchase Orders` → **Dispatch PO**              | `approved` → `sent`                     | `dispatch.sentAt` set. Supplier email with PDF link. **Scheduled overdue check enqueued** for `expectedDeliveryAt + 7 days`. |
| 26   | `10 - Purchase Orders` → **Record Receipt (partial)** | `sent` → `partially_received`           | Body has `quantity: 50` (half). Stock balance increases. **Forecast retrigger enqueued.**                                    |
| 27   | `10 - Purchase Orders` → **Record Receipt (final)**   | `partially_received` → `fully_received` | Receive remaining 50. Owner gets confirmation email. Low-stock alert clears. Forecast retrigger again.                       |
| 28   | `10 - Purchase Orders` → **Close PO**                 | `fully_received` → `closed`             | `closedAt` set. Terminal state.                                                                                              |

**Try a CAS race**: open two Postman tabs. After step 22, click **Approve** in both nearly simultaneously. One returns 200; the other returns 409 with `PO_STATE_RACE`. **This proves optimistic locking works.**

**Try an invalid transition**: try **Approve** on a PO that's still `draft` (skip step 22). You get 409 with `PO_INVALID_STATE_TRANSITION`. Same if you try to receive against a `cancelled` PO.

### Phase 7 — AI forecasts (5 requests)

Now that you have stock + movement history, the AI has real data to learn from.

| Step | Request                                                 | What it tests                                                                                                                                              |
| ---- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 29   | `11 - AI - Forecasts` → **Generate Single Forecast**    | Full forecast pipeline. Saves `forecastId`. See §9 for what happens with/without AI keys.                                                                  |
| 30   | `11 - AI - Forecasts` → **Get Forecast**                | Returns the persisted forecast with full provenance (`provider`, `model`, `latencyMs`, `promptTokens`, `completionTokens`, `cacheHit`, `failoverInvoked`). |
| 31   | `11 - AI - Forecasts` → **Override Forecast**           | Manual override with justification. Audit-logged.                                                                                                          |
| 32   | `11 - AI - Forecasts` → **AI Usage Snapshot**           | Shows `used` vs `cap` for tokens, forecast calls, report calls, and estimated cost USD.                                                                    |
| 33   | `11 - AI - Forecasts` → **Run Batch Forecast (subset)** | Enqueues `forecast.batch` job. Body: `{ "itemIds": ["{{itemId}}"] }`. **Watch Terminal 2** — the worker logs progress per item.                            |

**Try the per-tenant rate limit:** call step 29 ten times in 60 seconds. The 11th returns `RATE_LIMITED`. This is the sliding-window AI limiter (10/min per tenant).

**Try the per-item lock:** call step 29 twice for the same `itemId` within 6 hours. The second returns 429 with a hint to read the cached result. The cached result is in Redis (24h TTL).

### Phase 8 — Analytics (5 requests, all read-only)

| Step | Request                                                   |
| ---- | --------------------------------------------------------- |
| 34   | `12 - Reports (Analytics)` → **Inventory Turnover**       |
| 35   | `12 - Reports (Analytics)` → **Spend by Supplier**        |
| 36   | `12 - Reports (Analytics)` → **Supplier Cost Comparison** |
| 37   | `12 - Reports (Analytics)` → **Cash Flow Projection**     |
| 38   | `12 - Reports (Analytics)` → **Dead Stock**               |

These pull from MongoDB aggregation pipelines (`rpt.aggregations.ts`). With limited test data they may return small or empty arrays — that's fine.

### Phase 9 — Notifications + Billing (4 quick checks)

| Step | Request                                       | What to expect                                                              |
| ---- | --------------------------------------------- | --------------------------------------------------------------------------- |
| 39   | `13 - Notifications` → **List Notifications** | Empty unless you've configured Resend or other notification triggers fired. |
| 40   | `13 - Notifications` → **Unread Count**       | `{ count: 0 }` for a fresh tenant.                                          |
| 41   | `14 - Billing` → **List Plans**               | Returns the four-tier catalogue (trial / starter / growth / enterprise).    |
| 42   | `14 - Billing` → **Get Subscription**         | Returns the trial subscription created at registration.                     |

**Skip these in folder 14 unless you've wired gateway adapters:**

- `Create Checkout Session` returns 501 (intentional stub).
- The webhook endpoints (folder 15) accept and audit-log but don't yet verify signatures or process events.

### Phase 10 — Auth tear-down (3 requests)

Verify revocation works.

| Step | Request                                          | What to verify                                                 |
| ---- | ------------------------------------------------ | -------------------------------------------------------------- |
| 43   | `02 - Auth (Private)` → **Logout Everywhere**    | Revokes every session + denylists access tokens for this user. |
| 44   | `02 - Auth (Private)` → **Get Me** _(run again)_ | `401` with `AUTH_TOKEN_INVALID` — denylist is honoured.        |
| 45   | `01 - Auth (Public)` → **Login**                 | `200` — fresh tokens issued.                                   |

**This proves**: the Redis access-token denylist (per-user "revoked-at" watermark) works correctly.

---

## 9. How AI behaves

The AI module is the most-asked-about piece. Its behaviour depends on which env vars you've set.

### Mode 1: No AI keys (`GROQ_API_KEY` and `GEMINI_API_KEY` both empty)

**Forecast generation (`POST /ai/forecasts`):**

1. Data prep runs normally — reads 180 days of stock movements, computes features.
2. Pipeline tries Groq → no key → moves to Gemini.
3. Gemini → no key → falls through to **deterministic baseline**.
4. Returns: a forecast row with:
   - `provenance.provider = "groq"` (the attempted provider)
   - `provenance.failoverInvoked = true`
   - `confidence = "low"`
   - `reasoning` includes "Deterministic fallback used because the LLM response could not be parsed..."
   - `predictedQuantity30Day = avg × 30` (extrapolation of historical mean)
   - Range widens based on coefficient of variation.

**Quote comparison (`GET /quotations/:id/compare`):**

- Numeric ranking still works (deterministic sort by total cost).
- `aiSummary: null` (no prose).
- `recommendedSupplierId` = cheapest complete response.

**Weekly report:**

- The metrics are aggregated.
- The AI text pipeline throws because both providers are unavailable.
- The report job fails. The user gets no email until at least one key is configured.

**This is the safe default.** You can run the entire backend with no AI keys and every endpoint will respond without 500-erroring.

### Mode 2: Groq only

- Forecasts succeed via Groq.
- If Groq's circuit breaker trips (3 consecutive failures), pipeline falls through to deterministic baseline (no Gemini).
- Token counts in `provenance.promptTokens` / `completionTokens` are real Groq numbers.
- Cost in `aiUsage.estimatedCostMicroUsd` reflects Groq's pricing.

### Mode 3: Both Groq and Gemini

- Forecasts go to Groq first.
- On Groq error, parse failure, or breaker open → automatic Gemini fallback.
- `provenance.failoverInvoked = true` indicates a fallback occurred.
- This is the production-recommended mode.

### Mode 4: Gemini only

- Pipeline tries Groq → no key → moves to Gemini.
- Gemini handles every call (slower than Groq but still acceptable).
- `provenance.provider = "gemini"`.

### What gets persisted on every forecast

Every successful forecast (whether AI or baseline) creates a `Forecast` row with:

```ts
{
  itemId,
  horizonDays: 30,
  predictedQuantity,             // integer, rounded
  predictedRange: { lower, upper }, // integers, monotonic-checked
  confidence: 'low' | 'medium' | 'high',
  reasoning,                     // string
  seasonalityDetected,
  reorderPointSuggestion: { quantity, safetyStockFactor, leadTimeDaysAssumed } | null,
  provenance: {
    provider, model, promptVersion,
    failoverInvoked, latencyMs, cacheHit,
    promptTokens, completionTokens
  },
  rawPrompt,                     // truncated 32k
  rawResponse,                   // truncated 32k
  generatedAt, expiresAt,
  inputSeries: [...]             // last 30 days for traceability
}
```

The `rawPrompt` + `rawResponse` are kept so you can audit any past forecast — what the LLM actually saw and said.

### How the per-tenant cost gate works

Before every LLM call:

1. Look up `AiUsage` row for `(tenantId, currentMonth)`.
2. Compute `usedTokens = promptTokens + completionTokens`.
3. Compare against `monthlyTokenCap` for the tenant's tier:
   - `trial`: 100k tokens, 50 forecast calls, 4 reports
   - `starter`: 500k tokens, 500 forecast calls, 8 reports
   - `growth`: 5M tokens, 5k forecast calls, 32 reports
   - `enterprise`: 50M tokens, 50k forecast calls, 200 reports
4. If `used + estimated > cap` → reject with `AI_QUOTA_EXCEEDED` **before** the LLM call.
5. If `(used + estimated) / cap >= 0.8` → set `softAlert = true` and log a warn line.

After every successful call:

- Roll up tokens, calls, and cost (USD micros) into the `AiUsage` row.

You can see the snapshot any time via `GET /ai/usage`.

### How forecast retriggers work after a PO receipt

When you record a receipt in Phase 6:

1. `po.service.receive` posts the stock movement.
2. `applyPostReceiptSideEffects` runs (best-effort, never blocks the receipt):
   - For each affected item, calls `aiRepository.findLatestForItem`.
   - **6h staleness check**: if the latest forecast is < 6 hours old, skip the retrigger (avoid spam during a 200-line GRN).
   - Else, `enqueueForecast('forecast.single_item', { itemId })`.
3. Worker picks up the job. Runs the full pipeline. Persists a fresh forecast.
4. Socket.io emits `ai.forecast.completed` to the tenant room.
5. The dashboard (when built) updates the chart in place.

---

## 10. How to verify the worker

While running Phase 6 + 7, watch Terminal 2 (`npm run dev:worker`).

**On PO receipt (Phase 6, step 26):**

```
{"event":"forecast.single.start","tenantId":"...","itemId":"..."}
{"event":"forecast.single.complete","forecastId":"..."}
{"event":"email.send","to":"...","subject":"PO ... fully received","delivered":true}
```

**On batch forecast (Phase 7, step 33):**

```
{"event":"forecast.batch.start","tenantId":"...","count":1}
{"event":"forecast.single.start","tenantId":"...","itemId":"..."}
{"event":"forecast.single.complete","forecastId":"..."}
{"event":"forecast.batch.complete","total":1,"succeeded":1,"failed":0,"durationMs":1234}
```

**If the worker shows nothing during these phases:**

- Worker process not running → start `npm run dev:worker`.
- Worker can't reach Redis → check `REDIS_URL` matches the API's value.
- Job is queued but stuck → `redis-cli LRANGE bull:forecast:wait 0 -1` shows pending job IDs.

**Clearing a stuck queue (dev only):**

```bash
redis-cli FLUSHDB
```

This wipes everything: queues, rate-limit counters, idempotency cache, AI cache. Don't do this in production.

---

## 11. Testing real-time events

WebSocket events fire during Phases 6, 7, and 9. Postman doesn't speak WebSocket, so use a separate client.

### Quick check with `wscat`

```bash
npm install -g wscat

# Connect with JWT in handshake auth
wscat -c "ws://localhost:4000/realtime" \
  --header "Authorization: Bearer $ACCESS_TOKEN"
```

Once connected, you'll see:

```
{"event":"system.connected","data":{"serverTime":"2026-...","sessionId":"..."}}
```

Then in another terminal, run Phase 6 step 26 (Record Receipt). Back in `wscat`:

```
{"event":"po.state.changed","data":{"poId":"...","fromState":"sent","toState":"partially_received",...}}
{"event":"ai.forecast.batch.progress","data":{...}}
{"event":"ai.forecast.completed","data":{"forecastId":"...","itemId":"...","horizonDays":30,...}}
```

### Alternative: browser devtools

Open browser console:

```js
const ws = new WebSocket("ws://localhost:4000/realtime", [], {
  headers: { Authorization: "Bearer " + accessToken },
});
ws.onmessage = (e) => console.log("msg:", JSON.parse(e.data));
```

(Browsers actually use Socket.io client lib — install it if you want strict event handling.)

---

## 12. Troubleshooting

### "MONGO_URI is required" / "REDIS_URL is required" at startup

Your `.env` is missing or malformed. Check:

1. The file is at `backend/.env` (NOT project root).
2. No spaces around `=` (e.g. `MONGO_URI=mongo...` not `MONGO_URI = mongo...`).
3. No quotes around URLs unless they contain special chars.

### `readyz` returns `mongo: false`

- Mongo isn't running. Start your container or check Atlas Network Access whitelist.
- Wrong `MONGO_URI`. Test with `mongosh "$MONGO_URI"`.
- Replica set not initialized (Docker single-node). Run `rs.initiate()` once.

### `readyz` returns `redis: false`

- Redis isn't running. Test with `redis-cli PING`.
- Wrong `REDIS_URL` or `REDIS_TLS` mismatch. Upstash needs `rediss://` and `REDIS_TLS=true`.
- Firewall blocking 6379.

### `AUTH_TOKEN_MISSING` on every request

- Env var `accessToken` is empty. Re-run **Login** (Phase 1 step 5).
- Postman environment not selected. Top-right → choose **SCP Platform - Local Dev**.

### `RATE_LIMITED` on auth endpoints

- 5 logins per 15 min per IP. Wait or `redis-cli FLUSHDB` (dev only).

### `PO_INVALID_STATE_TRANSITION`

- You skipped a step in Phase 6. Read the response — `details` shows current state.

### `AUTH_REFRESH_REUSE_DETECTED` after a successful login

- You ran the **Refresh Token** request twice with the same (now-rotated) `refreshToken`. The whole token family is revoked. Re-run **Login**.

### Forecast returns the same generic reasoning every time

- Both `GROQ_API_KEY` and `GEMINI_API_KEY` empty → deterministic baseline. Fix by adding at least one key and restarting both processes.

### Worker terminal silent during Phase 7

- Worker process isn't running. Start `npm run dev:worker` in Terminal 2.

### `validate` returns 400 with `Invalid request body`

- Check the response `details` — it lists which Zod field failed and why. Common causes: missing required field, wrong type (e.g. number sent as string), enum mismatch.

### "Cannot find module 'puppeteer-core'" when running weekly report

- Expected on dev boxes without Chromium. The report falls back to Markdown email. Install `puppeteer` (full bundle) or skip this test.

### Postman pre-request script errors

- The collection uses `pm.variables.replaceIn('{{$guid}}')` for Idempotency-Key. If your Postman is < v9, upgrade it.

---

## Appendix — total time to complete the playbook

| Phase                                       | Approx. time                |
| ------------------------------------------- | --------------------------- |
| Setup (Redis + Mongo + .env + install)      | 15-30 min (first time)      |
| Phase 1 (auth)                              | 2 min                       |
| Phase 2-3 (master data + stock)             | 3 min                       |
| Phase 4 (suppliers)                         | 2 min                       |
| Phase 5 (RFQ + accept)                      | 5 min (incl. token harvest) |
| Phase 6 (PO state machine)                  | 5 min                       |
| Phase 7 (AI forecasts)                      | 3 min                       |
| Phase 8 (analytics)                         | 1 min                       |
| Phase 9-10 (notifications + auth tear-down) | 2 min                       |
| **Total testing**                           | **~25 minutes**             |

You will have validated tenant isolation, JWT rotation, refresh-token reuse detection, capability-based RBAC, append-only ledger + atomic CAS balance, optimistic locking on the PO state machine, BullMQ queue + worker fan-out, AI pipeline with circuit breaker + deterministic fallback, AI cost governance, audit logging, idempotency, rate limiting, and Socket.io events.

That's the whole system.
