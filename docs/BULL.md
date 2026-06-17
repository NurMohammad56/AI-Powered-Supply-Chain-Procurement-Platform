# BullMQ (the job queue) in the AI-Powered Supply Chain Procurement Platform

> A deep, code-level walkthrough of **what BullMQ does in this project, every queue
> and worker, how jobs flow from API to worker, and why the design is the way it is.**

Companion document: [REDIS.md](./REDIS.md). BullMQ is built on top of Redis — read
REDIS.md §2 for the connection layer that BullMQ depends on.

> **Naming note:** the library is **BullMQ** (`bullmq@^5.34.10`), the modern,
> TypeScript-native successor to the original "Bull". People often say "Bull" loosely;
> everywhere below it means BullMQ.

---

## 1. Why a job queue exists at all

The application runs as **two separate processes** (SDD §5.6):

- **API server** — [backend/src/server.ts](../backend/src/server.ts). Serves HTTP +
  WebSocket. Must respond fast.
- **Worker** — [backend/src/worker.ts](../backend/src/worker.ts). Runs slow,
  long-running, or flaky background work.

Some work is too slow or too unreliable to do inside an HTTP request:

- **Sending email** — depends on an external provider (Resend) that can be slow or
  temporarily down.
- **AI demand forecasting** — LLM calls (Groq → Gemini failover) take seconds and hit
  rate limits.
- **Report / weekly-digest generation** — analytics aggregation + PDF rendering + AI
  narrative.
- **"Fire later" cron-style tasks** — quote-expiry checks, PO-overdue alerts that must
  run *days* after the triggering request.

BullMQ is the bridge. The API **enqueues** a job (a tiny, fast Redis write) and
returns immediately; the worker **consumes** it later. The comment in `worker.ts`
states the goal plainly: background work "cannot steal CPU from the request-serving
API process."

```
  HTTP request                         Redis (BullMQ)                  Worker process
 ┌────────────┐   enqueue(job)        ┌──────────────┐   pop job      ┌──────────────┐
 │ API server │ ───────────────────►  │  queue lists │ ─────────────► │  Worker      │
 │ (server.ts)│   returns 202 now     │  + zsets     │   process      │ (worker.ts)  │
 └────────────┘                       └──────────────┘   ack/retry    └──────────────┘
        ▲                                                                     │
        └──────────── Socket.io progress events (via Redis pub/sub) ─────────┘
```

---

## 2. Architecture: producers, queues, workers

| Layer | File | Responsibility |
|-------|------|----------------|
| **Job type contracts** | [shared/queue/jobTypes.ts](../backend/src/shared/queue/jobTypes.ts) | TypeScript payload shapes shared by producer + consumer |
| **Queues + producers** | [shared/queue/queues.ts](../backend/src/shared/queue/queues.ts) | `Queue` objects, default retry policy, `enqueue*` helpers |
| **Workers (consumers)** | [workers/*.worker.ts](../backend/src/workers/) | `Worker` objects that process jobs |
| **Worker bootstrap** | [worker.ts](../backend/src/worker.ts) | Starts all workers in the worker process |

The key safety property: **producers and consumers share the exact same payload
types** from `jobTypes.ts`. A mismatched job payload is a *compile error*, not a
runtime surprise. This is the discriminated-union pattern — e.g. `ForecastJobMap`
maps job-name strings to payload interfaces:

```ts
export type ForecastJobMap = {
  'forecast.single_item': ForecastSingleItemJob;
  'forecast.batch': ForecastBatchJob;
};
```

---

## 3. The four queues

Defined in [jobTypes.ts](../backend/src/shared/queue/jobTypes.ts) (`QueueNames`) and
constructed in [queues.ts](../backend/src/shared/queue/queues.ts). Note: `QueueNames`
also lists `Pdf`, `Webhook`, `LowStock`, `Accuracy` — these are **reserved names**
for future queues; only the four below are actually instantiated and consumed.

| Queue | `QueueNames` | Producer helper | Worker | Concurrency | Attempts | Backoff |
|-------|--------------|-----------------|--------|-------------|----------|---------|
| **email** | `Email` | `enqueueEmail` | `startEmailWorker` | 8 | **5** | exp, 5 min |
| **report** | `Report` | `enqueueReport` | `startReportWorker` | 2 | 2 | exp, 5 min |
| **forecast** | `Forecast` | `enqueueForecast` | `startForecastWorker` | 3 | 2 | exp, 1 min |
| **scheduled** | `Scheduled` | `enqueueScheduled` | `startScheduledWorker` | 4 | 1 | (none) |

The per-queue tuning is deliberate (the source comments explain each):

- **email** — most retries (5) and the longest backoff (5 min, exponential): the
  external provider being down is the most common failure and is usually transient,
  so retry patiently. High concurrency (8) because each job is mostly I/O wait.
- **forecast** — only 2 attempts because "LLM calls are flaky"; low concurrency (3)
  because **Groq has a 30 RPM limit on free tiers** and one tenant's batch must not
  starve another tenant's single forecast.
- **report** — 2 attempts, low concurrency (2) since reports are heavy.
- **scheduled** — **1 attempt, no retry**: a failure here usually means the upstream
  row no longer exists (quote/PO deleted), which is a fine no-op, not an error to
  retry.

### 3.1 Default job options

Every queue inherits these defaults (overridden per queue as above):

```ts
const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 }, // keep 24h or last 1000
  removeOnFail: { age: 7 * 24 * 3600 },              // keep failures 7 days
};
```

- **`attempts` + `backoff`** — automatic retry with exponential backoff. On failure
  BullMQ re-schedules the job after `delay × 2^(attempt-1)` ms.
- **`removeOnComplete` / `removeOnFail`** — auto-cleanup so Redis doesn't fill up
  with finished jobs. Completed jobs vanish after 24h (or beyond 1000 kept); failed
  jobs are kept 7 days for debugging then dropped. Without this, the completed/failed
  sets would grow forever.

### 3.2 `buildQueue` factory

```ts
function buildQueue<TPayload>(name, opts = {}) {
  return new Queue<TPayload>(name, {
    connection: redisQueue,
    defaultJobOptions: { ...defaultJobOptions, ...opts },
  });
}
```

All queues share the single dedicated `redisQueue` ioredis client (see REDIS.md §2.1
for why it is dedicated). The generic `<TPayload>` ties each queue to its payload map.

### 3.3 QueueEvents — failure logging

For each queue a `QueueEvents` listener logs terminal failures:

```ts
const emailEvents = new QueueEvents(QueueNames.Email, { connection: redisQueue });
emailEvents.on('failed', ({ jobId, failedReason }) =>
  logger.warn({ queue: QueueNames.Email, jobId, failedReason }, 'email job failed'));
```

`QueueEvents` taps BullMQ's Redis event stream so the **API process** (not just the
worker) can observe job outcomes. This is separate from the `worker.on('failed', …)`
handlers inside each worker — `QueueEvents` works cross-process.

### 3.4 Producer helpers

Thin, type-safe wrappers around `queue.add(jobName, payload, opts)`:

```ts
export async function enqueueForecast<K extends keyof ForecastJobMap>(
  jobName: K, payload: ForecastJobMap[K], opts: JobsOptions = {},
): Promise<{ jobId: string }> {
  const job = await forecastQueue.add(jobName, payload, opts);
  return { jobId: job.id ?? '' };
}
```

`enqueueForecast` and `enqueueScheduled` return the `jobId` so the caller can report
it back to the client or use it for progress tracking; `enqueueEmail` and
`enqueueReport` return `void`.

---

## 4. Queue-by-queue deep dive

### 4.1 Email queue

**Producers** (who enqueues `email.send`):
- [auth.service.ts](../backend/src/modules/auth/auth.service.ts) — verification,
  password-reset, and other account emails (3 call sites).
- [po.notifications.ts](../backend/src/modules/po/po.notifications.ts) — PO sent to
  supplier, fully-received, delivery-overdue alerts, etc. (6 call sites).
- [forecast.worker.ts](../backend/src/workers/forecast.worker.ts) — the batch-forecast
  worker enqueues a *summary email* when a batch finishes. **A worker producing a job
  for another queue** is a normal and intended pattern.

**Payload** (`SendEmailJob`): `to`, `subject`, `html`, optional `text`, `replyTo`,
`tags`, plus `emailDeliveryId`/`tenantId` for tracking.

**Worker** ([email.worker.ts](../backend/src/workers/email.worker.ts)): concurrency 8.
Calls `emailClient.send(...)` (Resend). If the provider reports `!delivered`, it
**throws**, which makes BullMQ retry (up to 5 attempts, 5-min exponential backoff).
The job-type comment notes that on terminal failure the worker flips
`emailDeliveries.state` (FR-NOT-08) — i.e. permanently-failed email is recorded in
the DB.

### 4.2 Forecast queue — the showcase

This is the most sophisticated queue. **Two job kinds:**

#### `forecast.single_item`
Enqueued from:
- [po.service.ts](../backend/src/modules/po/po.service.ts) (line ~707) — after goods
  are received, demand is re-forecast for affected items. Note the pre-flight check:
  it skips enqueue if a forecast was generated in the last 6h, "to avoid queue spam
  during a 200-line GRN."

The worker (`handleSingleItem`) builds a tenant context, calls
`aiService.runForecastForItem(...)`, and returns the persisted forecast id.

#### `forecast.batch`
Enqueued from:
- [ai.service.ts](../backend/src/modules/ai/ai.service.ts) `runForecastForAll(...)`,
  driven by `POST /api/v1/ai/forecasts/batch`
  ([ai.routes.ts](../backend/src/modules/ai/ai.routes.ts)). Before enqueueing it
  checks the **monthly forecast call cap** for the tenant's tier and estimates cost,
  then returns the `batchJobId` to the dashboard.

The worker (`handleBatch`) loads all (or specified) non-archived items for the tenant
and processes them **sequentially within the job**, calling `runForecastForItem` with
`skipRateLimit: true` / `skipReadCache: true`. Why sequential inside the job rather
than fanning out one job per item? To keep per-call concurrency small for the LLM
rate limit while still showing the user a single, coherent progress bar.

**Live progress via Socket.io** — as each item starts/completes/fails the worker emits:

```ts
io.to(tenantRoom(tenantId)).emit(SocketEvents.AiForecastBatchProgress, { batchJobId, itemId, index, total, status });
```

and on completion `AiForecastBatchCompleted` with totals + duration. It also calls
`job.updateProgress(pct)` (BullMQ's built-in 1–100 progress, useful for queue
dashboards). These socket emits reach the right browser even across replicas because
of the Redis pub/sub adapter (REDIS.md §7). The emits are wrapped in `try/catch`
because the worker may run before/without a socket server. Finally it enqueues a
**summary email** via `enqueueEmail`.

This queue is the clearest illustration of the whole pattern: **API returns instantly
with a job id → worker does the slow LLM work → realtime progress streams back over
WebSocket → a summary email lands when done.**

### 4.3 Report queue

**Producer:** `enqueueReport` (`report.weekly_digest`, `report.adhoc`). **Worker**
([report.worker.ts](../backend/src/workers/report.worker.ts)), concurrency 2:
- `report.weekly_digest` → `generateWeeklyReport(...)` (analytics + AI narrative + PDF
  + email). Returns whether the PDF rendered and the email sent.
- `report.adhoc` → currently a **stub**: ad-hoc analytics use the `rpt` aggregations
  layer directly and only the weekly digest gets an AI narrative. The stub exists so
  any already-enqueued ad-hoc jobs are consumed rather than piling up on the dead-letter
  set.

### 4.4 Scheduled queue — "fire later" cron jobs

This is where BullMQ's **delayed jobs** shine. Jobs are enqueued with
`{ delay: <ms> }`; BullMQ holds them in a Redis sorted set scored by run-at time and
only moves them to the active list when the delay elapses — even if that's **days**
later.

**Producers:**
- [quotation.service.ts](../backend/src/modules/supplier/quotation.service.ts) — when
  an RFQ is created, schedules `scheduled.quotation.expiry_check` to fire exactly at
  `validUntil`:
  ```ts
  const delay = Math.max(0, validUntil.getTime() - Date.now());
  void enqueueScheduled('scheduled.quotation.expiry_check', { tenantId, quotationId }, { delay });
  ```
- [po.service.ts](../backend/src/modules/po/po.service.ts) — when a PO is sent,
  schedules `scheduled.po.delivery_overdue_check` for 7 days past
  `expectedDeliveryAt`.

**Worker** ([scheduled.worker.ts](../backend/src/workers/scheduled.worker.ts)),
concurrency 4, **1 attempt (no retry)**:
- `quotation.expiry_check` — atomically flips an *open*, past-`validUntil` RFQ to
  `closed`. **Idempotent**: a conditional `updateOne` that no-ops if already
  accepted/cancelled.
- `po.delivery_overdue_check` — if the PO is still `sent`/`partially_received` 7+ days
  overdue, fans out alert emails; otherwise no-ops. May re-schedule a 7-day follow-up.

The no-retry policy is intentional: by the time these fire days later, the upstream
row may legitimately be gone, and a "failure" is really a benign no-op. The handlers
are written to be safe to run late or twice.

---

## 5. The worker process lifecycle (`worker.ts`)

```ts
async function bootstrap() {
  await connectDatabase();
  await connectRedis();
  const workers = [
    startEmailWorker(), startReportWorker(),
    startForecastWorker(), startScheduledWorker(),
  ];
  // ... signal handlers ...
}
```

1. **Connect dependencies** — Mongo + Redis before starting any worker.
2. **Start all four workers** — each creates a BullMQ `Worker` bound to `redisQueue`
   that immediately begins long-polling its queue for jobs.
3. **Graceful shutdown** — on `SIGTERM`/`SIGINT` (and uncaught errors) it:
   - `worker.close()` on each — stops accepting new jobs and lets in-flight jobs
     finish (so a job is never killed mid-execution and left half-done),
   - `closeQueues()` — closes the `Queue`/`QueueEvents` handles,
   - disconnects Redis + Mongo, then exits.

   This ordering matters: draining workers **before** cutting Redis ensures active
   jobs can write their completion state back. The API server (`server.ts`) does the
   mirror-image shutdown and also calls `closeQueues()` because it holds the producer
   handles.

Each worker also has an inline `worker.on('failed', …)` handler logging the failing
job — complementing the cross-process `QueueEvents` listeners in §3.3.

---

## 6. End-to-end example: "Run a batch forecast"

Putting every piece together:

1. **Client** → `POST /api/v1/ai/forecasts/batch`. Middleware chain:
   `rbacFor('ai.forecast.generate')` → `rateLimitAi` (sliding-window, 10/min/tenant,
   REDIS.md §4.2) → `idempotencyKey` (REDIS.md §5.2) → `validate`.
2. **`aiService.runForecastForAll`** checks the tenant's monthly forecast cap,
   estimates cost, and calls `enqueueForecast('forecast.batch', { tenantId, itemIds,
   requestedBy })`. This is a fast Redis write. It returns `{ batchJobId, itemCount,
   estimatedCostUsd }` and the **HTTP response returns immediately** — no LLM work
   happened in the request.
3. **BullMQ** stores the job in the `forecast` queue's Redis structures. The dashboard
   subscribes to progress using the returned `batchJobId`.
4. **Worker** (`startForecastWorker`, concurrency 3) pops the job, runs `handleBatch`:
   for each item it generates a forecast (LLM call), emits `AiForecastBatchProgress`
   over Socket.io (fanned out via Redis pub/sub), and updates BullMQ progress.
5. On finish it emits `AiForecastBatchCompleted` and enqueues a **summary email**
   (`email` queue) — which the email worker later delivers via Resend.
6. If any item throws, that item is logged and the batch continues; if the *whole*
   job throws, BullMQ retries up to 2× with 1-min backoff.

The same skeleton — *enqueue fast, process slow, stream progress, retry on failure* —
underlies every feature in this document.

---

## 7. Design principles recap

1. **Offload anything slow or flaky.** Email, LLM forecasts, reports, and deferred
   checks never block an HTTP response.
2. **Type-safe job contracts.** `jobTypes.ts` makes producer/consumer payload
   mismatches compile errors.
3. **Per-queue tuning by failure mode.** Retries, backoff, and concurrency are set
   from how each workload actually fails (provider flakiness, LLM rate limits, stale
   rows).
4. **Delayed jobs replace a cron server.** The `scheduled` queue handles day-scale
   "fire later" tasks natively in Redis.
5. **Idempotent, safe-to-rerun handlers.** Especially for retried and long-delayed
   jobs — conditional DB updates, no-op on missing rows.
6. **Auto-cleanup.** `removeOnComplete`/`removeOnFail` keep Redis bounded.
7. **Graceful drain on shutdown.** Workers finish in-flight jobs before exit.
8. **Realtime feedback loop.** BullMQ progress + Socket.io (over the Redis adapter)
   turn slow background work into a live dashboard experience.
</content>
