# Socket.io / Real-time Events — Frontend Integration Guide

> A complete, in-depth reference for **every WebSocket event in this project**: how to
> connect, authenticate, which rooms you're in, and **exactly what each event emits and
> how to listen for it** from the frontend.
>
> Audience: frontend developers wiring the live dashboard.
> Backend source: [socketServer.ts](../backend/src/shared/realtime/socketServer.ts),
> [events.ts](../backend/src/shared/realtime/events.ts).
> Related: [REDIS.md §7](./REDIS.md) (how events fan out across server replicas),
> [BULL.md](./BULL.md) (background jobs that emit progress events).

---

## 0. TL;DR for the impatient

```ts
import { io } from 'socket.io-client';

const socket = io('http://localhost:4000', {
  path: '/realtime',          // NOT the default '/socket.io'
  transports: ['websocket'],  // websocket ONLY — polling is rejected
  auth: { token: accessToken },  // your JWT access token (no "Bearer " prefix)
});

socket.on('system.connected', (p) => console.log('connected', p));
socket.on('ai.forecast.completed', (p) => updateForecastChart(p));
socket.on('connect_error', (err) => console.error('socket auth failed', err.message));
```

That's the whole handshake. The rest of this doc is the detail behind it.

---

## 1. The mental model

This is a **server → client push** system. The backend tells your dashboard when
something happened (a forecast finished, a batch is 40% done) so you **never have to
poll**. Think of it as a live news feed for one factory.

Three things you must internalize:

1. **The connection is read-only from the client's side.** The only message a client is
   allowed to send is `ping`. Send anything else and **the server disconnects you
   immediately** (and logs it as suspicious). You *listen*; you don't *emit* business
   events. All actions still go through the normal REST API.
2. **You're automatically placed in two "rooms"** based on your JWT: your factory's room
   (`tenant:<id>`) and your personal room (`user:<id>`). Events are addressed to rooms —
   you only ever receive events meant for your factory or you personally. This is the
   real-time half of the multi-tenant isolation.
3. **Auth is per-connection, at handshake time.** Your access token is checked once when
   the socket connects. Because access tokens are short-lived (15 minutes), you must
   handle reconnection with a fresh token (see §7).

---

## 2. Connecting

### 2.1 Connection parameters (all required / important)

| Option | Value | Why |
|---|---|---|
| URL | `http://localhost:4000` (the API origin, **not** `/api/v1`) | Socket.io attaches to the same HTTP server as the REST API |
| `path` | `'/realtime'` | The server mounts Socket.io at `/realtime`, **not** the default `/socket.io`. Wrong path → connection never establishes |
| `transports` | `['websocket']` | Server runs **WebSocket-only** (no HTTP long-polling fallback). If you leave the default, socket.io-client tries polling first and fails |
| `auth.token` | your access JWT (raw, no `Bearer `) | Verified in the handshake; missing/invalid → `connect_error` |
| `withCredentials` | `true` (if cookies needed) | CORS is credentialed; origin must be in the server's `CORS_ORIGINS` allowlist |

> **CORS:** the server only accepts socket origins listed in `CORS_ORIGINS`
> (`.env`, e.g. `http://localhost:3000`). If your frontend runs on a different
> origin/port, it must be added there or the handshake is refused.

### 2.2 Server-side config you should know about

From [socketServer.ts](../backend/src/shared/realtime/socketServer.ts):

```ts
{
  path: '/realtime',
  transports: ['websocket'],   // websocket only
  pingInterval: 25_000,        // server pings you every 25s
  pingTimeout: 20_000,         // if no pong in 20s, you're dropped
  maxHttpBufferSize: 1MiB,     // frames larger than 1 MiB kill the connection
}
```

You don't configure these on the client — socket.io negotiates `pingInterval` /
`pingTimeout` automatically. Just know that a dead connection is detected within
~25–45s.

---

## 3. Authentication — deep dive

The token goes in the **handshake auth payload**, not an HTTP header:

```ts
const socket = io('http://localhost:4000', {
  path: '/realtime',
  transports: ['websocket'],
  auth: { token: accessToken },   // ← here
});
```

What the server does ([socketServer.ts](../backend/src/shared/realtime/socketServer.ts) `io.use(...)`):

1. Reads `socket.handshake.auth.token`.
2. If missing/empty → rejects with `Error('AUTH_TOKEN_MISSING')`.
3. Verifies the JWT signature + expiry. On failure → `Error('AUTH_TOKEN_INVALID')`.
4. On success, attaches `{ tenantId, userId, role }` to the socket and lets it connect.

On the client, **both rejection cases surface as a `connect_error`**:

```ts
socket.on('connect_error', (err) => {
  // err.message is 'AUTH_TOKEN_MISSING' or 'AUTH_TOKEN_INVALID'
  if (err.message === 'AUTH_TOKEN_INVALID') {
    // token likely expired → refresh it, then socket.connect() again (see §7)
  }
});
```

> ⚠️ **There is no per-message auth and no token-refresh-over-socket.** When your access
> token expires, the *existing* connection keeps working until it drops, but any
> *reconnect* needs a fresh token. The robust pattern (see §7) is: refresh the token via
> REST, update `socket.auth`, and reconnect.

---

## 4. Rooms — what you receive and why

On connect, the server auto-joins you to **exactly two rooms** (you cannot join others;
client-initiated room joins are not supported):

| Room | Format | Contains | Used for |
|---|---|---|---|
| Tenant room | `tenant:<tenantId>` | everyone in your factory | factory-wide events (forecasts, inventory, POs) |
| User room | `user:<userId>` | just you | personal events (session invalidated, your notifications) |

You never specify rooms on the client — the server derives them from your JWT. This is
why a user from Factory A can **never** receive Factory B's events: A is in `tenant:A`,
the event is emitted to `tenant:B`, and the rooms never overlap. (Across multiple server
replicas this still holds because events fan out through the Redis adapter — see
[REDIS.md §7](./REDIS.md).)

**Implication for the frontend:** you don't filter by tenant yourself. If an event
arrives, it's already meant for your factory or you. You only filter by *which item /
PO / batch* the event concerns, using the IDs in the payload.

---

## 5. The strict client contract (don't break it)

```ts
// ✅ The ONLY thing a client may emit:
socket.emit('ping');

// ❌ Anything else → server disconnects you + logs 'socket.unexpected_client_emit'
socket.emit('subscribe', ...);    // NO
socket.emit('po.update', ...);    // NO — use the REST API
```

The server installs an `onAny` guard: any inbound event other than `ping` triggers an
immediate `socket.disconnect(true)` and an audit-grade warning log. This is a deliberate
security posture — the socket is a one-way notification channel. **All writes/actions go
through REST.**

---

## 6. The Event Catalog — every event, payload, and how to listen

> **Status legend:**
> 🟢 **LIVE** — emitted by the backend today, wire it up now.
> 🟡 **PLANNED** — the event name + payload shape are defined in
> [events.ts](../backend/src/shared/realtime/events.ts) and reserved, but no backend code
> emits it yet. Safe to add a listener now (it just won't fire until the backend wires
> it); building for it is forward-compatible.

All event **names are dotted strings** (e.g. `'ai.forecast.completed'`). You listen with
`socket.on('<name>', handler)`. Payload field types below are the TypeScript shapes from
`events.ts`; `string` timestamps are ISO-8601.

---

### 6.1 🟢 `system.connected` — connection confirmed

Fires **once**, right after a successful connect, to *your socket only* (not a room).
Use it to confirm the realtime layer is ready and to grab a session id for debugging.

- **Emitted from:** `socketServer.ts` on `connection`
- **Room:** direct to the connecting socket

```ts
interface SystemConnectedPayload {
  serverTime: string;   // ISO timestamp from the server
  sessionId: string;    // the socket.id, useful in logs/support
}
```
```ts
socket.on('system.connected', (p: SystemConnectedPayload) => {
  console.log('Realtime ready at', p.serverTime, 'session', p.sessionId);
  setRealtimeStatus('connected');
});
```

---

### 6.2 🟢 `ai.forecast.completed` — a single forecast finished

Fires when **one** item's forecast is generated and saved (whether triggered by a user
click, or auto-triggered after a PO receipt). Use it to live-update a forecast chart/card
without refetching.

- **Emitted from:** [ai.service.ts](../backend/src/modules/ai/ai.service.ts) after persisting a forecast
- **Room:** `tenant:<id>` (whole factory sees it)

```ts
interface AiForecastCompletedPayload {
  forecastId: string;
  itemId: string;
  horizonDays: number;     // e.g. 30
  confidence: string;      // 'low' | 'medium' | 'high'
  generatedAt: string;     // ISO timestamp
}
```
```ts
socket.on('ai.forecast.completed', (p: AiForecastCompletedPayload) => {
  // You typically have the itemId on screen; match and refresh just that card.
  if (p.itemId === currentItemId) {
    refetchForecast(p.forecastId);   // or optimistically update from payload
  }
  toast(`New forecast ready (confidence: ${p.confidence})`);
});
```

---

### 6.3 🟢 `ai.forecast.batch.progress` — per-item tick during a batch run

When a user runs **"Forecast all items"** (a background BullMQ job), this fires **once
per item** as the worker processes it. Use it to drive a live progress bar.

- **Emitted from:** [forecast.worker.ts](../backend/src/workers/forecast.worker.ts)
- **Room:** `tenant:<id>`

```ts
interface AiForecastBatchProgressPayload {
  batchJobId: string;                               // ties ticks to one batch run
  itemId: string;
  index: number;                                    // 0-based position in the batch
  total: number;                                    // total items in the batch
  status: 'started' | 'completed' | 'failed';
}
```
```ts
socket.on('ai.forecast.batch.progress', (p: AiForecastBatchProgressPayload) => {
  if (p.batchJobId !== activeBatchId) return;       // ignore other batches
  // index is 0-based; show "x of total"
  const done = p.index + 1;
  setProgress(Math.round((done / p.total) * 100));
  if (p.status === 'failed') markItemFailed(p.itemId);
});
```

> **How you get `batchJobId`:** the REST call `POST /api/v1/ai/forecasts/batch` returns
> `{ batchJobId, itemCount, ... }`. Store it, then filter these events by it.

---

### 6.4 🟢 `ai.forecast.batch.completed` — the whole batch finished

Fires once when a batch run ends, with the summary. Use it to close the progress bar and
show a result toast.

- **Emitted from:** [forecast.worker.ts](../backend/src/workers/forecast.worker.ts)
- **Room:** `tenant:<id>`

```ts
interface AiForecastBatchCompletedPayload {
  batchJobId: string;
  total: number;
  succeeded: number;
  failed: number;
  durationMs: number;
}
```
```ts
socket.on('ai.forecast.batch.completed', (p: AiForecastBatchCompletedPayload) => {
  if (p.batchJobId !== activeBatchId) return;
  setProgress(100);
  toast(`Batch done: ${p.succeeded}/${p.total} succeeded in ${(p.durationMs/1000).toFixed(1)}s`);
  refetchForecastList();
});
```

---

### 6.5 🟡 `inventory.balance.changed` — stock level moved

Defined for live-updating the warehouse grid when stock changes (receipts, adjustments,
transfers, low-stock cron). Wire a listener now; it will start firing when the backend
emits it.

- **Room:** `tenant:<id>`

```ts
interface InventoryBalanceChangedPayload {
  itemId: string;
  warehouseId: string;
  quantity: number;     // new balance
  lowStock: boolean;    // true if now below reorder level
  at: string;           // ISO timestamp
}
```
```ts
socket.on('inventory.balance.changed', (p: InventoryBalanceChangedPayload) => {
  updateGridCell(p.itemId, p.warehouseId, p.quantity);
  if (p.lowStock) flagLowStock(p.itemId);
});
```

---

### 6.6 🟡 `po.state.changed` — a purchase order moved state

Defined for reflecting PO lifecycle transitions (draft→approved→sent→received…) live on
a peer's screen without polling.

- **Room:** `tenant:<id>`

```ts
interface PoStateChangedPayload {
  poId: string;
  fromState: string;       // e.g. 'pending_approval'
  toState: string;         // e.g. 'approved'
  actorUserId: string;     // who triggered it
  at: string;
}
```
```ts
socket.on('po.state.changed', (p: PoStateChangedPayload) => {
  updatePoBadge(p.poId, p.toState);
});
```

---

### 6.7 🟡 `notification.created` — a new in-app notification

Defined to push notifications into the bell-icon feed in real time. Pairs with the REST
notifications API.

- **Room:** typically `user:<id>` (per-user feed)

```ts
interface NotificationCreatedPayload {
  notificationId: string;
  category: string;
  title: string;
  link: string;
  createdAt: string;
}
```
```ts
socket.on('notification.created', (p: NotificationCreatedPayload) => {
  prependNotification(p);
  incrementUnreadBadge();
});
```

---

### 6.8 🟡 `session.invalidated` — your session was killed

Defined for "logout everywhere", admin revocation, or token-reuse detection. When it
fires for you, tear down the session client-side and route to login.

- **Room:** `user:<id>`

```ts
interface SessionInvalidatedPayload {
  reason: 'logout_everywhere' | 'admin' | 'reuse_detected';
}
```
```ts
socket.on('session.invalidated', (p: SessionInvalidatedPayload) => {
  clearTokens();
  socket.disconnect();
  redirectToLogin(`Session ended: ${p.reason}`);
});
```

---

### 6.9 🟡 Other reserved event names

These names exist in `SocketEvents` for future use; payload shapes aren't finalized yet.
Listening is harmless but they won't fire today:

| Event name | Intended meaning |
|---|---|
| `inventory.item.created` | a new item was added |
| `inventory.item.archived` | an item was archived |
| `po.received` | goods received against a PO |
| `supplier.score.recomputed` | a supplier's performance score updated |
| `quote.response.received` | a supplier submitted an RFQ response |
| `notification.read` | a notification was marked read (multi-device sync) |

---

## 7. Connection lifecycle & token expiry (critical)

Access tokens live **15 minutes**. Handle this properly or users get silently
disconnected.

### 7.1 Built-in socket.io lifecycle events

```ts
socket.on('connect', () => setStatus('online'));
socket.on('disconnect', (reason) => {
  setStatus('offline');
  // reason === 'io server disconnect' → server kicked us (e.g. we emitted something illegal,
  // or were force-disconnected). socket.io will NOT auto-reconnect in that case — call connect() manually.
  if (reason === 'io server disconnect') socket.connect();
});
socket.on('connect_error', (err) => {
  // handshake failed — usually auth (expired/invalid token)
});
```

### 7.2 The token-refresh-and-reconnect pattern

Because the handshake token can expire, refresh it and update `socket.auth` before
reconnecting:

```ts
async function reconnectWithFreshToken() {
  const { accessToken } = await refreshAccessTokenViaRest();  // your existing /auth/refresh call
  socket.auth = { token: accessToken };   // update the handshake payload
  socket.disconnect().connect();          // force a fresh handshake with the new token
}

socket.on('connect_error', (err) => {
  if (err.message === 'AUTH_TOKEN_INVALID') reconnectWithFreshToken();
});
```

A common robust approach: whenever you proactively refresh the access token for REST
calls, also update `socket.auth.token` so the next reconnect already has a valid one.

---

## 8. A complete, production-shaped React hook

```ts
import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';

export function useRealtime(getAccessToken: () => string, handlers: Record<string, (p: any) => void>) {
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(import.meta.env.VITE_API_ORIGIN ?? 'http://localhost:4000', {
      path: '/realtime',
      transports: ['websocket'],
      auth: { token: getAccessToken() },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    socket.on('connect', () => console.debug('[rt] connected', socket.id));
    socket.on('system.connected', (p) => console.debug('[rt] ready', p));
    socket.on('connect_error', (err) => console.warn('[rt] connect_error', err.message));
    socket.on('disconnect', (reason) => {
      console.warn('[rt] disconnect', reason);
      if (reason === 'io server disconnect') socket.connect(); // server-initiated → manual reconnect
    });

    // Register all business-event handlers
    for (const [event, fn] of Object.entries(handlers)) socket.on(event, fn);

    return () => { socket.removeAllListeners(); socket.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return socketRef;
}
```

Usage:

```ts
useRealtime(() => store.accessToken, {
  'ai.forecast.completed': (p) => queryClient.invalidateQueries(['forecast', p.itemId]),
  'ai.forecast.batch.progress': (p) => batchStore.applyTick(p),
  'ai.forecast.batch.completed': (p) => batchStore.finish(p),
  'inventory.balance.changed': (p) => gridStore.setBalance(p),     // 🟡 future
  'po.state.changed': (p) => poStore.setState(p.poId, p.toState),  // 🟡 future
  'notification.created': (p) => notifStore.prepend(p),            // 🟡 future
  'session.invalidated': (p) => auth.forceLogout(p.reason),        // 🟡 future
});
```

---

## 9. Testing the socket manually

**Browser console (fastest):**
```js
const s = io('http://localhost:4000', { path:'/realtime', transports:['websocket'], auth:{ token: '<paste access token>' }});
s.onAny((e, ...a) => console.log('EVENT', e, a));
s.on('connect_error', e => console.log('ERR', e.message));
```
Then trigger a forecast via the REST API (`POST /api/v1/ai/forecasts`) and watch
`ai.forecast.completed` arrive.

**To see batch progress:** call `POST /api/v1/ai/forecasts/batch`, note the returned
`batchJobId`, and watch the `ai.forecast.batch.progress` / `...completed` events stream
in. (Requires the **worker process** to be running — see [BULL.md](./BULL.md).)

---

## 10. Gotchas & FAQ

| Symptom | Cause / Fix |
|---|---|
| Connects then instantly disconnects | You emitted something other than `ping` — the server kicks illegal emits. Only `socket.emit('ping')` is allowed. |
| `connect_error: AUTH_TOKEN_MISSING` | No `auth.token` in the handshake, or it's empty. |
| `connect_error: AUTH_TOKEN_INVALID` | Token expired/invalid → refresh and reconnect (§7). |
| Never connects, no error | Wrong `path` (must be `/realtime`) or polling transport — set `transports: ['websocket']`. |
| Connects locally but not in prod | Your origin isn't in `CORS_ORIGINS`; add it to the server `.env`. |
| Event handler never fires | Event may be 🟡 PLANNED (not emitted yet), or you're listening on the wrong string. Use `socket.onAny()` to see what actually arrives. |
| Batch events never arrive | The background **worker** isn't running, so the job never processes. |
| Disconnected after ~30s idle | Heartbeat (`pingTimeout`) — usually a network/proxy dropping the WS. Ensure your reverse proxy allows WebSocket upgrades and long-lived connections. |
| Frames over 1 MiB drop the socket | `maxHttpBufferSize` is 1 MiB — but remember clients only send `ping`, so this practically never applies to you. |

---

## 11. Quick reference card

```
Connect:   io('http://localhost:4000', { path:'/realtime', transports:['websocket'], auth:{ token } })
Rooms:     tenant:<tenantId>  (factory-wide)   |   user:<userId>  (personal)
Client may emit:   ONLY 'ping'   (anything else → disconnect)

LIVE events (listen now):
  system.connected               { serverTime, sessionId }
  ai.forecast.completed          { forecastId, itemId, horizonDays, confidence, generatedAt }
  ai.forecast.batch.progress     { batchJobId, itemId, index, total, status }
  ai.forecast.batch.completed    { batchJobId, total, succeeded, failed, durationMs }

PLANNED events (safe to pre-wire):
  inventory.balance.changed      { itemId, warehouseId, quantity, lowStock, at }
  po.state.changed               { poId, fromState, toState, actorUserId, at }
  notification.created           { notificationId, category, title, link, createdAt }
  session.invalidated            { reason }
  + inventory.item.created/archived, po.received, supplier.score.recomputed,
    quote.response.received, notification.read  (names reserved)
```
</content>
