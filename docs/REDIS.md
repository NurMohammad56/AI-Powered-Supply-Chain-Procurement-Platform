# Redis in the AI-Powered Supply Chain Procurement Platform

> A deep, code-level walkthrough of **what Redis does in this project, how every
> consumer uses it, and why each design decision was made.**

Companion document: [BULL.md](./BULL.md) covers the BullMQ job-queue layer, which
sits on top of Redis. Read REDIS.md first — BullMQ is just one of Redis's five
roles here.

---

## 1. The 30-second summary

Redis is the platform's **shared in-memory data plane**. The application is split
into two process types — an **API server** ([backend/src/server.ts](../backend/src/server.ts))
and a **background worker** ([backend/src/worker.ts](../backend/src/worker.ts)) —
and Redis is the connective tissue that lets them (and multiple replicas of each)
behave as one coherent system.

Redis is used for **five distinct jobs**:

| # | Role | Where | Why Redis (not Mongo/in-memory) |
|---|------|-------|--------------------------------|
| 1 | **Job queue backend** (BullMQ) | [shared/queue/queues.ts](../backend/src/shared/queue/queues.ts) | Atomic blocking pop, retries, delayed jobs |
| 2 | **Rate limiting** | [shared/middleware/rateLimit.ts](../backend/src/shared/middleware/rateLimit.ts) | Atomic counters shared across all API replicas |
| 3 | **Caching** (AI forecasts, idempotency) | [modules/ai/ai.service.ts](../backend/src/modules/ai/ai.service.ts), [shared/middleware/idempotency.ts](../backend/src/shared/middleware/idempotency.ts) | TTL eviction, sub-ms reads |
| 4 | **Auth token denylist** | [shared/security/tokenDenylist.ts](../backend/src/shared/security/tokenDenylist.ts) | Fast-path revocation check on every request |
| 5 | **Socket.io pub/sub adapter** | [shared/realtime/socketServer.ts](../backend/src/shared/realtime/socketServer.ts) | Broadcast WebSocket events across replicas |

The common thread: every one of these needs **state that is shared across
processes, mutated atomically, and (mostly) ephemeral with automatic expiry.**
That is exactly Redis's sweet spot, and exactly what MongoDB would be slow and
clumsy at.

---

## 2. Connection layer — `config/redis.ts`

All Redis access flows through one module: [backend/src/config/redis.ts](../backend/src/config/redis.ts).
It uses the **ioredis** client (`^5.4.2`).

### 2.1 Four named clients, not one

```ts
export const redisCache   = createClient('cache');     // caching, rate limit, denylist, idempotency
export const redisQueue   = createClient('queue');     // BullMQ queues + workers
export const redisSockPub = createClient('sock-pub');  // Socket.io adapter publisher
export const redisSockSub = createClient('sock-sub');  // Socket.io adapter subscriber
```

**Why four separate connections to the same Redis server?**

1. **BullMQ requires a dedicated connection.** BullMQ issues *blocking* commands
   (`BRPOPLPUSH`, `BZPOPMIN`) that park the connection waiting for a job. If the
   cache shared that connection, a cache `GET` would queue up behind a blocking
   queue read. The `redisQueue` client is therefore isolated.
2. **The Socket.io adapter requires two connections** — one in *subscriber* mode
   (`redisSockSub`) and one in normal mode for publishing (`redisSockPub`). Once a
   connection enters Redis pub/sub subscriber mode it can only run subscribe-family
   commands, so it cannot be shared.
3. **`redisCache`** serves everything else (rate limiting, caching, denylist,
   idempotency, health checks). These are all short, non-blocking commands and can
   safely multiplex over one connection.

Each client is tagged with a `connectionName` (`scp-cache`, `scp-queue`, …) so they
are individually identifiable in `redis-cli CLIENT LIST` and in Redis monitoring
dashboards.

### 2.2 Connection options and why each matters

```ts
function buildOptions(role: string): RedisOptions {
  return {
    maxRetriesPerRequest: null,   // (a)
    enableReadyCheck: true,       // (b)
    connectionName: `scp-${role}`,// (c)
    lazyConnect: true,            // (d)
    tls: env.REDIS_TLS ? {} : undefined, // (e)
  };
}
```

- **(a) `maxRetriesPerRequest: null`** — This is **mandatory for BullMQ**. By
  default ioredis gives up on a command after 20 retries and throws. BullMQ's
  blocking commands must survive arbitrarily long waits and transient blips, so the
  cap is disabled. The same option is applied to all clients for consistency.
- **(b) `enableReadyCheck: true`** — ioredis runs `INFO` after connecting and only
  emits `ready` once Redis reports it is not still loading its dataset from disk.
  This prevents commands being sent to a Redis that is mid-startup.
- **(c) `connectionName`** — observability (see above).
- **(d) `lazyConnect: true`** — the client does **not** dial Redis the moment it is
  constructed; it connects on the first command or an explicit `.connect()`. This is
  what makes the idempotent-connect logic below possible.
- **(e) `tls`** — when `REDIS_TLS=true` (the `.env.example` notes this is for
  **Upstash** and other managed TLS Redis providers), an empty TLS options object
  enables `rediss://`-style encrypted transport.

### 2.3 The idempotent `connectRedis()` — a subtle bootstrap bug, solved

This is the most interesting part of the file, and the long comment in the source
explains why it exists. The problem:

- `server.ts` imports `shared/queue/queues.ts` at the top of the file (it needs
  `closeQueues` for shutdown).
- The moment that module loads, the `new Queue(...)` and `new QueueEvents(...)`
  constructors run. **BullMQ calls `.connect()` on the shared `redisQueue` client
  internally**, as a side effect of construction.
- So by the time `bootstrap()` explicitly calls `connectRedis()`, the `redisQueue`
  client is *already* connecting. Calling `.connect()` again throws
  `Redis is already connecting/connected`.

The fix is `safeConnect`, which inspects the ioredis status state machine
(`wait | connecting | connect | ready | reconnecting | close | end`) and:

```ts
if (status === 'ready') return;                       // nothing to do
if (status === 'wait' || status === 'end') {          // safe to dial
  await client.connect();
  return;
}
// otherwise already connecting — just wait for the 'ready' event
```

This makes `connectRedis()` safe to call regardless of what BullMQ already did to
the client. It is the kind of bug that only appears once you split producers and
workers across processes, and the comment is preserved so future maintainers don't
"simplify" it back into a crash.

### 2.4 Lifecycle helpers

- **`connectRedis()`** — called once at startup by both `server.ts` and `worker.ts`.
  Connects all four clients in parallel.
- **`disconnectRedis()`** — graceful shutdown. Calls `.quit()` (not `.disconnect()`)
  on all four so in-flight commands drain before the socket closes. Errors are
  swallowed because we are exiting anyway.
- **`pingRedis()`** — health probe used by `/readyz`. Returns `true` only if
  `redisCache.ping()` returns `PONG`.

### 2.5 Configuration

From [config/env.ts](../backend/src/config/env.ts):

```
REDIS_URL   (required)  e.g. redis://127.0.0.1:6379   or rediss://...@upstash
REDIS_TLS   (default false; set true for Upstash)
```

In Docker ([backend/docker-compose.yml](../backend/docker-compose.yml)) Redis is
`redis:7-alpine` started with `--appendonly yes` (AOF persistence on, so queued
jobs and delayed jobs survive a Redis restart), and both the `api` and `worker`
services `depends_on` it with a `redis-cli ping` healthcheck.

---

## 3. Role 1 — BullMQ job queue backend

This is covered in depth in [BULL.md](./BULL.md). The Redis-level facts:

- Every queue and worker is constructed with `connection: redisQueue`.
- BullMQ stores each queue as a **collection of Redis data structures** under keys
  prefixed `bull:<queueName>:*` — lists for waiting jobs, a sorted set for delayed
  jobs (scored by run-at timestamp), hashes for each job's data, and sets for
  completed/failed jobs.
- Atomicity of "move a job from waiting → active → completed" is guaranteed by
  BullMQ's bundled **Lua scripts**, executed server-side in Redis so no two workers
  can grab the same job.

See BULL.md §2 and §4 for the full mechanics.

---

## 4. Role 2 — Rate limiting (`shared/middleware/rateLimit.ts`)

Redis is the backing store for **all** rate limiting because the API runs as
multiple replicas; an in-memory counter would let a client get `N × replicaCount`
requests through. There are **two algorithms** here.

### 4.1 Fixed-window limiters via `rate-limit-redis`

These wrap the `express-rate-limit` package with a Redis store. A single
`sendCommand` adapter routes the library's raw Redis commands through `redisCache`:

```ts
const sendCommand: SendCommandFn = (...args) =>
  redisCache.call(args[0], ...args.slice(1));
```

Each limiter gets its own key **prefix** so the budgets never collide:

| Export | Prefix | Window | Limit | Keyed by | Purpose |
|--------|--------|--------|-------|----------|---------|
| `rateLimitUnauthenticated` | `rl:ip:unauth:` | 60s | `RATE_LIMIT_UNAUTH_PER_MIN` | IP | Public endpoints |
| `rateLimitAuthenticated` | `rl:ip:auth:` | 60s | `RATE_LIMIT_AUTH_PER_MIN` | IP | Logged-in traffic |
| `rateLimitTenant` | `rl:tenant:` | 60s | `RATE_LIMIT_TENANT_PER_MIN` | tenantId | Per-organization fairness |
| `rateLimitLogin` | `rl:login:` | 15min | 10 | **email** | Brute-force defense |
| `rateLimitRefresh` | `rl:refresh:` | 60s | 12 | IP | Token-theft race detection |
| `rateLimitAuthSensitive` | `rl:auth-sensitive:` | 15min | 5 | IP | Password-spray defense |
| `rateLimitWebhook` | `rl:webhook:` | 60s | 1000 | IP | Flood protection only |

Note the **deliberately different keying strategies**: `rateLimitLogin` keys by the
*submitted email* (so an attacker trying many passwords against one account is
throttled even if they rotate IPs), while `rateLimitAuthSensitive` keys by *IP* (so
a password-spray across many accounts from one host is throttled). They overlap on
purpose — defense in depth.

### 4.2 Sliding-window limiter via Redis sorted sets

For **cost-bearing** endpoints (AI calls, file uploads) the fixed window is too
loose — a burst at the window boundary could effectively double the budget. So
`slidingWindowLimiter()` implements a true sliding window with a Redis **sorted set
(ZSET)**, executed as one atomic `MULTI` pipeline:

```ts
const pipeline = redisCache.multi();
pipeline.zremrangebyscore(key, 0, cutoff);      // 1. drop entries older than window
pipeline.zadd(key, now, member);                // 2. record this request
pipeline.zcard(key);                            // 3. count requests in window
pipeline.pexpire(key, opts.windowMs * 2);       // 4. self-evict abandoned buckets
const results = await pipeline.exec();
```

Each request is a ZSET member scored by its timestamp. Trimming + counting + adding
happen atomically so concurrent requests can't both read a stale count. The
`member` is `${now}-${random}` so two requests in the same millisecond don't collapse
into one ZSET entry. Two instances:

- **`rateLimitAi`** — `rl:ai:tenant:`, 10 calls/min per tenant. Stops a "regenerate"
  click-loop from draining LLM cost in seconds.
- **`rateLimitFileUpload`** — `rl:upload:tenant:`, 20 uploads/hour per tenant.

### 4.3 Fail-open philosophy

A critical design choice: the sliding limiter **never blocks the request if Redis
itself fails**:

```ts
} catch (err) {
  logger.warn({ err, ... }, 'sliding rate limiter degraded; failing open');
  return next();   // let the request through
}
```

Rationale: the rate limiter exists to protect against *abuse*, not to be a
single point of failure for the whole API. If Redis is down, the platform is
already degraded; refusing all traffic would make it worse. The same fail-open
posture appears in the token denylist (§6).

---

## 5. Role 3 — Caching

### 5.1 AI forecast cache + per-item lock (`modules/ai/ai.service.ts`)

The AI forecast path is the most Redis-intensive feature because LLM calls are
**slow and expensive**. It uses Redis for two things keyed on
`(tenantId, itemId, horizonDays)`:

**(a) A 6-hour per-item rate-limit lock** — `ai:forecast:lock:...`:

```ts
const acquired = await redisCache.set(key, '1', 'EX', RATE_LIMIT_PER_ITEM_SECONDS, 'NX');
if (acquired === null) {            // lock already held → forecast is fresh
  const cached = await this.peekCachedResult(...);
  if (cached) return cached;
  throw new TooManyRequestsError(...);
}
```

`SET ... NX` ("set if not exists") is the classic atomic-lock primitive. If the key
already exists, another forecast for this exact item/horizon ran in the last 6 hours,
so we return the cached result instead of paying for another LLM call. `EX` gives the
lock automatic expiry so a crash can never leave an item permanently locked.

**(b) A 24-hour result cache** — `ai:forecast:result:...`:

```ts
// after generating:
await redisCache.set(cacheKey(...), JSON.stringify(created), 'EX', REDIS_PER_ITEM_TTL_SECONDS);
// on read:
const raw = await redisCache.get(cacheKey(...));
```

The forecast document is serialized to JSON and cached for 24h. `peekCachedResult`
reads Redis first; on a miss (or a corrupt entry) it falls through to MongoDB, which
keeps forecasts indefinitely for history. So Redis is the **hot path**, Mongo is the
**source of truth** — a textbook cache-aside pattern.

The batch worker passes `skipReadCache: true` and `skipRateLimit: true` because the
batch already passed the global quota/rate check at enqueue time and per-item locks
would create false negatives mid-batch.

### 5.2 Idempotency cache (`shared/middleware/idempotency.ts`)

For mutating requests (`POST`/`PUT`/`PATCH`) that carry an `Idempotency-Key` header,
the response is cached under `idem:<tenantId>:<key>` for 24 hours:

```ts
const hit = await redisCache.get(redisKey);
if (hit) { const cached = JSON.parse(hit); res.status(cached.status).json(cached.body); return; }
// otherwise wrap res.json to cache the response when the handler finishes:
res.json = (body) => {
  redisCache.set(redisKey, JSON.stringify({ status: res.statusCode, body }), 'EX', TTL_SECONDS).catch(...);
  return originalJson(body);
};
```

If a client retries a `POST /forecasts` (e.g. after a network timeout) with the same
key, it gets the **original response replayed from Redis** instead of triggering a
second forecast/charge. The key is tenant-scoped so two tenants can't collide. Cache
read/write failures are logged but **non-fatal** — the request proceeds, and the
controller's database-level idempotency (unique indexes, CAS) is the real safety net.
The `ai.routes.ts` shows both `rateLimitAi` and `idempotencyKey` applied to the
forecast endpoints.

---

## 6. Role 4 — Auth access-token denylist (`shared/security/tokenDenylist.ts`)

JWT access tokens are short-lived (15 min) and **stateless** — normally you can't
revoke them. To support logout-everywhere, force-re-auth on role change, and
incident response, this module keeps a Redis denylist that the auth middleware
checks on every request, right after JWT signature verification.

Two key shapes:

- **`auth:deny:jti:<jti>`** — denylist one specific token by its JWT ID. TTL is set
  to the token's own remaining lifetime (`exp - now`, capped at 24h) so the entry
  self-evicts exactly when the token would have expired anyway — the set never grows
  unbounded:
  ```ts
  await redisCache.set(`auth:deny:jti:${jti}`, '1', 'EX', ttlSeconds, 'NX');
  ```
- **`auth:deny:user:<userId>`** — a "revoked-at" **watermark** timestamp. Rather than
  enumerate every token a user holds, we record `Date.now()`. The verify path rejects
  any token whose `iat` (issued-at) predates the watermark:
  ```ts
  await redisCache.set(`auth:deny:user:${userId}`, Date.now().toString(), 'EX', SAFETY_TTL_SECONDS);
  ```
  Combined with the 15-minute token TTL, this gives a hard cap on staleness without
  ever listing individual tokens. This is the **logout-everywhere** mechanism.

The check is two parallel O(1) `GET`s:

```ts
const [jtiHit, userWatermark] = await Promise.all([
  redisCache.get(`auth:deny:jti:${jti}`),
  redisCache.get(`auth:deny:user:${userId}`),
]);
```

**Why Redis and not Mongo?** This runs on *every authenticated request*. A Mongo
round trip per request would add noticeable latency; Redis keeps it sub-millisecond.
Refresh tokens, by contrast, are tracked in Mongo (family/jti) because they are
long-lived and need durable reuse-detection — Redis is the fast path for the
short-lived access tokens only.

Like the rate limiter, denylist reads **fail open** (`return false` on Redis error):
for short-lived tokens the team prefers availability over revocation latency, and the
refresh path remains the authoritative revocation gate.

---

## 7. Role 5 — Socket.io Redis adapter (`shared/realtime/socketServer.ts`)

The platform pushes realtime events to dashboards over WebSocket (forecast
completion, inventory changes, PO state, notifications — see
[shared/realtime/events.ts](../backend/src/shared/realtime/events.ts)). With more
than one API replica, a WebSocket connected to replica A must receive events
*emitted* on replica B. The `@socket.io/redis-adapter` solves this:

```ts
io.adapter(createAdapter(redisSockPub, redisSockSub));
```

Internally the adapter uses Redis **pub/sub**: when any replica calls
`io.to(room).emit(...)`, the event is published to a Redis channel; every replica is
subscribed and re-emits to its locally-connected sockets in that room. Rooms used:

- `tenant:<tenantId>` — every user of a tenant (e.g. `AiForecastBatchProgress`).
- `user:<userId>` — a single user (e.g. `SessionInvalidated`).

This is why the worker can call `getIo().to(tenantRoom(...)).emit(...)` from a
forecast job (in `forecast.worker.ts` and `ai.service.ts`) and the message reaches a
browser connected to a *different* process — Redis fans it out. The worker wraps these
emits in `try/catch` because in some deploys the worker has no socket server attached;
the emit is best-effort.

The adapter needs **two** connections (`redisSockPub` + `redisSockSub`) because the
subscriber connection is locked into pub/sub mode (see §2.1).

---

## 8. Health checks

Two endpoints in [app.ts](../backend/src/app.ts):

- **`/healthz`** — liveness; just process uptime, no Redis.
- **`/readyz`** — readiness; pings Redis (and Mongo) and returns `503` if either is
  down, so a load balancer / Kubernetes can pull a not-ready replica out of rotation:
  ```ts
  redisCache.ping().then((r) => r === 'PONG')
  ```

---

## 9. Key namespace reference

Every Redis key this app writes, in one place:

| Key pattern | Written by | TTL | Type |
|-------------|-----------|-----|------|
| `bull:email:*`, `bull:report:*`, `bull:forecast:*`, `bull:scheduled:*` | BullMQ | per job opts | lists/zsets/hashes |
| `rl:ip:unauth:*`, `rl:ip:auth:*`, `rl:tenant:*` | fixed-window limiter | 60s window | counter |
| `rl:login:*`, `rl:refresh:*`, `rl:auth-sensitive:*`, `rl:webhook:*` | fixed-window limiter | window | counter |
| `rl:ai:tenant:*`, `rl:upload:tenant:*` | sliding-window limiter | `2 × window` | sorted set |
| `ai:forecast:lock:<tenant>:<item>:<horizon>` | ai.service | 6h | string lock |
| `ai:forecast:result:<tenant>:<item>:<horizon>` | ai.service | 24h | JSON string |
| `idem:<tenant>:<key>` | idempotency middleware | 24h | JSON string |
| `auth:deny:jti:<jti>` | tokenDenylist | token exp (≤24h) | string |
| `auth:deny:user:<userId>` | tokenDenylist | 24h | timestamp string |
| Socket.io adapter channels | redis-adapter | n/a | pub/sub |

---

## 10. Cross-cutting design principles

1. **Everything ephemeral has a TTL.** No code path writes an unbounded key. Locks,
   caches, denylist entries, rate-limit buckets all self-evict. Redis memory stays
   bounded without a sweeper.
2. **Atomicity via Redis primitives, not app-level locking.** `SET NX` for locks,
   `MULTI` pipelines for the sliding window, BullMQ's Lua scripts for job moves.
   Concurrency correctness lives in Redis, not in fragile JavaScript.
3. **Cache-aside, Redis-first / Mongo-authoritative.** Forecasts and idempotency
   read Redis first and fall back to Mongo, which is the durable record.
4. **Fail-open for protective features.** Rate limiting and the token denylist
   degrade gracefully if Redis blips — availability beats perfect enforcement for
   these specific features.
5. **Connection isolation by workload.** Four named clients keep blocking queue
   reads, pub/sub, and cache traffic from interfering with each other.
6. **Two-process architecture.** Redis is the shared substrate that lets the API
   server and the background worker — and any number of replicas of each — act as a
   single distributed system.
</content>
</invoke>
