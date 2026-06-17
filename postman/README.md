# Postman Testing Guide — every endpoint, in the right order, with the *why*

This folder contains a ready-to-run Postman collection for the whole API. This
README is a **complete testing playbook**: it tells you what to run, **in what
order**, **why each step depends on the last**, and **when an endpoint will or won't
work** (because most of this API is a state machine — calling things out of order
returns errors *by design*).

Files:

- `api.collection.json` — every endpoint, grouped into 15 folders (`01 - Auth` … `15 - Webhooks`).
- `api.environment.json` — variables (`baseUrl`, tokens, and the IDs that requests auto-save).

---

## 1. Before you start

### 1.1 Get the backend running

The API must be up before Postman can talk to it. From `backend/`:

```bash
docker compose up -d        # starts MongoDB + Redis + api + worker
# OR run locally:
npm run dev                 # API server  (port 4000)
npm run dev:worker          # worker process (emails, AI, reports) — run in a 2nd terminal
```

**Why two processes?** The `api` serves your HTTP requests; the `worker` drains
background queues (email, AI forecasts, weekly reports). If the worker is **not**
running, your requests still succeed instantly, but the *side effects* (a welcome
email, a forecast actually computing, a PDF generating) never happen. For testing
endpoints this is fine; for testing the full effect, start the worker too. See
[../docs/BULL.md](../docs/BULL.md).

Confirm it's alive: `GET http://localhost:4000/readyz` should return `{ ok: true }`
(checks Mongo + Redis). `GET http://localhost:4000/healthz` is a bare liveness ping.

### 1.2 Import into Postman

1. **File → Import** → drop both JSON files in.
2. Top-right environment selector → choose **SCP Platform - Local Dev**.
3. Verify `{{baseUrl}}` = `http://localhost:4000/api/v1`. Change it if your API runs elsewhere.

### 1.3 How the collection wires itself together (read this — it saves hours)

The collection is **stateful**: requests write IDs and tokens back into the
environment so the next request can use them. Two mechanisms do this automatically:

- **Collection-level Authorization.** Every request inherits
  `Authorization: Bearer {{accessToken}}`. You log in once; everything after is
  authenticated. (Public folders 01, 09, 15 don't need it.)
- **Collection-level pre-request script** auto-generates a fresh `Idempotency-Key`
  header for every POST (so retried POSTs are replay-safe — see §6).
- **Per-request test scripts** auto-save IDs. You almost never copy-paste an ID:

| Running this request… | …auto-saves this variable |
|---|---|
| `Register Factory + Owner` / `Login` | `accessToken`, `refreshToken`, `tenantId`, `userId` |
| `Create Warehouse` | `warehouseId` |
| `Create Category` | `categoryId` |
| `Create Item` | `itemId` |
| `Create Supplier` | `supplierId` |
| `Create Second Supplier` | `secondSupplierId` |
| `Create Quotation Request` | `quotationId` |
| `Get Quotation` | `quoteToken` (first invitation's token) |
| `Accept Quotation` | `poId` (the auto-created draft PO) |
| `Create PO (manual)` | `poId`, `poLineId` |
| `Generate Single Forecast` | `forecastId` |

IDs not in this table (e.g. `notificationId`) you copy manually from a `List`
response into the environment.

---

## 2. The dependency graph — what needs what

The single most important thing to understand: **you cannot test these endpoints in
folder order top-to-bottom.** Many depend on data created earlier. Here's the chain:

```
Register/Login  ──►  (everything below needs the token)
       │
       ├─► Warehouse ─┐
       ├─► Category    ├─►  Item ──►  Adjust Stock (seed balance)
       │               │                 │
       │               │                 ├─►  Forecast (needs movement history)
       │               │                 │
       └─► Supplier ×2 ┘                 │
                │                         │
                ├─►  Quotation (RFQ, invites suppliers, references item)
                │         │
                │         ├─► (supplier submits response — public, token-gated)
                │         ├─► Compare Quotes
                │         └─► Accept ──►  Purchase Order (draft) auto-created
                │                              │
                └──────────────────────────────┤  (or Create PO manually)
                                               │
                          Submit ► Approve ► Dispatch ► Receipt(s) ► Close
                                                            │
                                                            └─► updates Item stock,
                                                                re-triggers Forecast
```

**Rule of thumb:** create the *nouns* (warehouse, category, item, supplier) first,
then the *workflows* (quotation, PO) that reference them, then the *analytics*
(reports, AI usage) that summarize them.

---

## 3. The golden path — one end-to-end run

Run these in exactly this order for a full smoke test. Each line says **why** it's
here and **what state it requires**.

| # | Folder → Request | Why / what it proves | Requires |
|---|---|---|---|
| 1 | 01 → **Register Factory + Owner** | Creates your tenant + an Owner account; saves tokens. *(Skip & use Login if you already registered.)* | nothing |
| 2 | 03 → **Create Warehouse** | A place to hold stock. Stock can't exist without one. | token |
| 3 | 04 → **Create Category** | Optional grouping for items. | token |
| 4 | 05 → **Create Item** | The thing you forecast and buy (e.g. raw cotton). | token |
| 5 | 06 → **Adjust Stock (positive opening balance)** | Seeds an opening quantity → creates the first *stock movement*. **Forecasts need movement history**, so this matters. | `itemId`, `warehouseId` |
| 6 | 07 → **Create Supplier** | Who you buy from. | token |
| 7 | 07 → **Create Second Supplier** | A 2nd supplier so quote *comparison* has something to compare. | token |
| 8 | 08 → **Create Quotation Request (RFQ)** | Asks both suppliers for prices on the item. | `itemId`, `supplierId`, `secondSupplierId` |
| 9 | 08 → **Get Quotation** | Reads the RFQ back; saves `quoteToken` for the first invited supplier. | `quotationId` |
| 10 | 09 → **Submit Quotation Response** *(optional)* | Plays the supplier: submits a price quote via the public token. Needed for a meaningful comparison. | `quoteToken` |
| 11 | 08 → **Compare Quotes** | Deterministic numeric ranking + an AI prose summary of the trade-offs. | a submitted response (step 10) |
| 12 | 08 → **Accept Quotation** | Picks a supplier and **auto-creates a draft PO**; saves `poId`. | `quotationId` |
| 13 | 10 → **Submit PO for Approval** | Moves PO `draft → pending_approval`. | `poId` in `draft` |
| 14 | 10 → **Approve PO** | `pending_approval → approved`; queues PDF generation. | PO in `pending_approval` |
| 15 | 10 → **Dispatch PO** | `approved → sent`; emails supplier the PDF; schedules an overdue check. | PO in `approved` |
| 16 | 10 → **Record Receipt** (run twice: 50 + 50) | First partial receipt → `partially_received`; second → `fully_received`. Each updates Item stock and re-triggers a forecast. | PO in `sent`/`partially_received` |
| 17 | 10 → **Close PO** | `fully_received → closed` (terminal). | PO in `fully_received` |
| 18 | 11 → **Generate Single Forecast** | AI predicts demand for the item; saves `forecastId`. | `itemId` with history |
| 19 | 11 → **Get Forecast** | Reads the persisted forecast back. | `forecastId` |
| 20 | 12 → **Inventory Turnover / Spend by Supplier / Cash Flow** | Analytics over everything you just created. | data from steps above |
| 21 | 11 → **AI Usage Snapshot** | Token + call counts consumed this month. | one AI call made |
| 22 | 13 → **List Notifications** | Confirms the workflow produced activity-feed entries. | the workflow ran |

After this run you've exercised the core of every module.

---

## 4. Folder-by-folder reference — every endpoint, what it does, *when it works*

> **Role note:** `Register` gives you an **Owner**, which has every capability, so as
> the default test user *all* of these pass. The "Role" column tells you which
> endpoints would be **403 Forbidden** if you tested as a lower role (Manager,
> Warehouse Staff, Viewer). To test that, invite a user with a lower role and log in
> as them.

### 01 — Auth (Public) · no token needed

| Request | What it does | When it works |
|---|---|---|
| Register Factory + Owner | Creates tenant + owner, returns tokens | Always (email must be unique) |
| Login | Returns tokens for an existing user | After register; **rate-limited** 5/15min per IP + 10/15min per email |
| Refresh Token | Rotates the access token using the refresh cookie/token | Needs valid refresh token **and** the `X-CSRF` header (env `csrfToken`, defaults `dev-csrf-token`). Reusing an already-rotated token trips reuse-detection and kills the session. |
| Logout | Invalidates the current refresh token | Any time |
| Forgot Password | Emails a reset token (worker must run to send) | Always returns 200 (doesn't reveal if email exists) |
| Reset Password | Consumes the reset token, sets new password | Needs a valid, unexpired reset token from the email |
| Verify Email | Confirms the address with the emailed token | Needs the verification token |

### 02 — Auth (Private) · token required

| Request | What it does | Role |
|---|---|---|
| Get Me | Current user + tenant context | any |
| Update My Profile | Edit your own name/profile | any |
| Change Password | Change your own password (needs current password) | any |
| List Users / Invite User | See/invite team members | **`user.invite`** → Owner, Manager |
| Update User Role / Disable User | Manage other users | **`user.role.assign`** → **Owner only** (Manager can invite but not re-role) |
| Logout Everywhere | Revokes *all* your sessions (denylist watermark) | any |

> A Manager can only assign Manager-or-lower roles; an Owner can assign any. This
> blocks lateral privilege escalation.

### 03 — Inventory · Warehouses

| Request | When it works | Role |
|---|---|---|
| List / Get Warehouse | any time | `inventory.item.read` → all roles |
| **Create / Update / Archive Warehouse** | any time | **`inventory.warehouse.manage`** → **Owner only** (Manager will get 403 here!) |

### 04 — Inventory · Categories

CRUD over item categories. Create → `inventory.item.create` (Owner, Manager). Read →
all roles. Update/Archive → `inventory.item.update` / `inventory.item.archive`.

### 05 — Inventory · Items

CRUD over items. **Create Item before** anything that references an item (stock,
forecast, quotation). `List Items` supports filters like `?type=raw_material`.
Create → Owner, Manager. Read → all. Archive is a soft-delete (item stays in history).

### 06 — Inventory · Stock & Reports

| Request | What it does | When it works |
|---|---|---|
| Adjust Stock (opening balance) | `+` movement; sets starting quantity | After Item + Warehouse exist |
| Adjust Stock (correction down) | `-` movement | Balance must not go negative |
| Transfer Stock | Moves qty between two warehouses | Needs a **second** `warehouseId` (create another warehouse, set it manually) and sufficient source balance |
| Item Movement History | Append-only ledger of every movement | After ≥1 movement |
| Item Balances | Current qty per warehouse | After ≥1 movement |
| Low Stock List | Items below their reorder level | Only returns rows once something is actually low |
| Bulk Import Items | Create many items at once | `inventory.item.create` |

Movements use capability `inventory.movement.create` → Owner, Manager, **Warehouse
Staff** (staff can move stock but not create items).

### 07 — Suppliers

Full CRUD plus:

- **Compare Suppliers** (`?ids=a,b`) — side-by-side of 2–5 suppliers.
- **Supplier Performance** — on-time rate, spend, scoring (meaningful only after POs exist).
- **Contacts / Documents** — embedded sub-resources edited **by array index**
  (`/contacts/0`, `/documents/1`), not by id. Add before you update/remove an index.

Create → `supplier.create` (Owner, Manager). Edits → `supplier.update`. Read/compare/
performance → `supplier.read` (all roles).

### 08 — Quotations (RFQ) · Private

This is a **state machine**: `open → (accepted | closed/cancelled)`.

| Request | What it does | When it works |
|---|---|---|
| Create Quotation Request | Opens an RFQ, invites suppliers, generates one response-token per invitee | Needs item + ≥1 supplier; role `supplier.quote.send` (Owner, Manager) |
| Get Quotation | Reads it; saves `quoteToken` | After create |
| Compare Quotes | Numeric ranking + AI summary | Best **after** suppliers have responded; with no responses the ranking is empty |
| Accept Quotation | Picks a supplier, **auto-creates a draft PO** | Only while RFQ is `open` |
| Cancel Quotation | Closes the RFQ without accepting | Only while `open` |

> **AI behaviour:** Compare ranks by *real numbers* (total cost, lead time)
> deterministically; the AI only writes the prose explanation. If the AI is down, you
> still get the ranking with `aiSummary: null`. The AI never picks the supplier.

### 09 — Quotations (Public) · no JWT

| Request | What it does | When it works |
|---|---|---|
| Submit Quotation Response | The *supplier's* side: submit prices via their token | Needs `quoteToken` (from `Get Quotation`); only while the RFQ is `open` and before `validUntil` |

> The token is treated as PII and is **not** returned by the private GET, which is why
> the test script extracts it from the quotation's invitation list. In real life it's
> emailed to the supplier.

### 10 — Purchase Orders · the biggest state machine

States and the **only** transition that works from each:

```
draft ──submit──► pending_approval ──approve──► approved ──dispatch──► sent
  ▲                      │                                               │
  │ (update allowed      └──reject──► rejected ──update──► draft         │ receive (partial)
  │  in draft/rejected)                                                  ▼
  └───────────────────────────────────────────────  partially_received ─┐
                                                          │ receive(more)│
cancel ► cancelled (from any pre-closed state)            ▼              │
                                                     fully_received ◄────┘
                                                          │ close
                                                          ▼
                                                       closed (terminal)
```

| Request | Works only when PO is in… | Role |
|---|---|---|
| Create PO (manual) | n/a (creates a `draft`) | `po.create` (Owner, Manager) |
| Create PO from Forecast | n/a (AI-suggested draft) | `po.create` |
| Update PO | `draft` or `rejected` | `po.update` |
| Submit | `draft` | `po.submit` |
| Approve | `pending_approval` | `po.approve` — Manager is **threshold-capped**: above a monetary limit only an Owner can approve |
| Reject | `pending_approval` | `po.reject` |
| Dispatch / Send | `approved` | `po.dispatch` |
| Record Receipt | `sent` or `partially_received` | `po.receive` (incl. **Warehouse Staff**) |
| List Receipts / Get PDF | any | `po.read` |
| Close | `fully_received` | `po.update` |
| Cancel | any state before `closed` | `po.cancel` |

**Why ordering is enforced:** every transition is a compare-and-swap
(`update where state = expected`). If two people approve at once, one wins and the
other gets `PO_STATE_RACE` — refresh and retry. Calling `Approve` on a `draft` PO
returns a state error, not a crash. That's the system protecting your data integrity.

> **Over-receiving is rejected:** receipt line quantities can't exceed the remaining
> ordered quantity. That's why the golden path does 50 + 50 against a qty-100 line.

### 11 — AI · Forecasts

| Request | What it does | When it works |
|---|---|---|
| Generate Single Forecast | Predicts 30/60/90-day demand + reorder point for one item | Needs an item **with movement history**; **rate-limited** 10/min per tenant; a 2nd call for the same item within 6h returns the cached result |
| Get / List Forecasts | Read forecasts back | After ≥1 forecast |
| Override Forecast | Human corrects the AI number (audited) | `ai.forecast.override` (Owner, Manager) |
| Run Batch Forecast (all / subset) | Queues forecasts for many items; returns a `batchJobId` | **Async** — needs the **worker running**; watch progress over Socket.io. Checks your monthly quota first. |
| AI Usage Snapshot | Tokens/calls/cost used this month vs your tier cap | any time |

> If the worker isn't running, batch returns a job id but nothing computes. Single
> forecast runs **synchronously** in the API process, so it works without the worker —
> but it does call the real LLM (Groq→Gemini), so it needs those API keys set.

### 12 — Reports (Analytics) · read-only

Inventory Turnover, Spend by Supplier, Supplier Cost Comparison, Cash Flow Projection,
Dead Stock. All take `from`/`to` date ranges (except cash-flow). Numbers are only
interesting **after** you've created movements and POs. Role `rpt.read` → Owner,
Manager, Viewer (not Warehouse Staff). These are pure aggregations — no AI, no writes.

### 13 — Notifications

List, Unread Count, Mark Read (specific ids or all). No special role. Notifications
appear after the workflow generates them (PO submitted/approved, low stock, etc.). To
test `Mark Read (specific ids)`, copy a `notificationId` from `List` into the env.

### 14 — Billing

| Request | What it does | Role |
|---|---|---|
| List Plans | Public plan catalogue | any (no rbac) |
| Get Subscription | Current tier, seats, status | **`billing.read`** → **Owner only** |
| Create Checkout Session | **Returns 501 NotImplemented** today — payment gateway not wired | Owner |
| Change Subscription Tier | Schedules a tier change at period end | Owner |
| Cancel Subscription | Cancels at period end | Owner |
| List Invoices | Past invoices | Owner |

> Billing is **Owner-only**; a Manager has no billing capabilities and will get 403.

### 15 — Webhooks (Public, no JWT)

Inbound callbacks from payment gateways. They verify a signature on the **raw** body,
so a hand-made request without a valid signature will be rejected (expected). High
rate limit (1000/min) so settlement bursts don't get throttled.

> ⚠️ **Path correction:** the collection points these at
> `{{baseUrl}}/../webhooks/...` (resolving to `/api/webhooks/...`). The router is
> actually mounted at **`/api/v1/webhooks/...`**. If you get a 404, change the URL to
> **`{{baseUrl}}/webhooks/stripe`** and **`{{baseUrl}}/webhooks/sslcommerz`**.

---

## 5. Testing as different roles (proving RBAC)

The whole point of the permission system is that the wrong person can't do the wrong
thing. To see it in action:

1. As Owner, `02 → Invite User` with `role: "warehouse_staff"` (or `manager`/`viewer`).
2. Set that user's password via the invite/reset flow.
3. `01 → Login` as them (this overwrites `accessToken`).
4. Try a gated endpoint and watch it fail with **403**:
   - Warehouse Staff calling `Create Warehouse` → 403 (`inventory.warehouse.manage`).
   - Manager calling `Get Subscription` → 403 (`billing.read`).
   - Viewer calling `Create Item` → 403.
5. Log back in as Owner to continue.

---

## 6. Cross-cutting behaviours you'll notice

- **Idempotency-Key (auto-added to every POST).** Replay the same POST with the same
  key within 24h and you get the **original** response back instead of a duplicate
  write. Great for testing retry safety; if you want a *fresh* create, the
  pre-request script already rotates the key each send.
- **Rate limiting.** Login/forgot-password are deliberately strict (you can lock
  yourself out for 15 min by spamming). AI calls are 10/min/tenant. If you hit
  `429 RATE_LIMITED`, wait out the window.
- **Tenant isolation.** Your token *is* your tenant. You can never see another
  factory's data, and you can't pass a `tenantId` to override it — it's read from the
  JWT only. Requesting another tenant's object id returns **404** (not 403), on
  purpose, so attackers can't probe what exists.
- **Async side effects need the worker.** Emails, batch forecasts, weekly reports, and
  PO PDFs are produced by the worker process. Endpoints return success immediately;
  the actual artifact appears once the worker processes the job. See
  [../docs/BULL.md](../docs/BULL.md) and [../docs/REDIS.md](../docs/REDIS.md).
- **Real-time.** Many actions also emit Socket.io events (forecast completed, PO state
  changed). Postman won't show these; a connected dashboard would.

---

## 7. Quick troubleshooting

| Symptom | Likely cause |
|---|---|
| `401 Unauthorized` on everything | No/expired `accessToken` — run Login again |
| `403 Forbidden` | Your role lacks that capability (see role columns above) |
| `404` on an object you "know" exists | Wrong/empty id variable, or it belongs to another tenant |
| `409` / `PO_STATE_RACE` / "invalid transition" | You called a workflow step from the wrong state — check the state machine in §4 |
| `429 RATE_LIMITED` | Hit a rate limit — wait for the window |
| Batch forecast/email "did nothing" | Worker process isn't running |
| Webhook returns 404 | Use `{{baseUrl}}/webhooks/...` (see §4 → folder 15) |
| `readyz` returns 503 | Mongo or Redis is down |
</content>
