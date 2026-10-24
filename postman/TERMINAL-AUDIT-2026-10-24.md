# API and Worker terminal audit

Audited on 24 October 2026, approximately 10:18 AM Asia/Dhaka. Evidence: [queue and readiness snapshot](../backend/artifacts/terminal-audit-results.json). Counts are a snapshot; live workers continue processing jobs.

## Findings in priority order

### 1. Gmail delivery is blocked; synthetic email jobs are being retried

The development `bull:email` queue has 96 delayed jobs. All 96 have already encountered the same provider rejection:

```text
550-5.4.5 Daily user sending limit exceeded
```

All 96 jobs address synthetic `.test` recipients. Of these, 78 reference tenant IDs whose company records are absent from the configured Atlas database. This is a real delivery failure. It is not a MongoDB connection failure or an API crash. The SMTP credentials can authenticate while Gmail still refuses the send because of its daily limit.

The development configuration uses `smtp.gmail.com:587`; the presentation configuration uses the local capture SMTP server on port 2525. A successful local presentation email test therefore does not establish that Gmail production delivery is available.

Remediation: separate local/demo delivery from real SMTP; prevent synthetic and missing-tenant jobs from reaching a real provider; handle provider quota failures with an appropriate retry policy. Gmail's external quota cannot be reset by changing application code. Preserve legitimate pending mail when quarantining stale test work.

### 2. The development Redis queue contains work for missing companies

Snapshot for prefix `bull`:

- 10 failed forecast jobs: all 10 report `Tenant not found` and refer to absent factories.
- 96 delayed emails: 78 refer to absent factories.
- 21 delayed scheduled jobs: 20 refer to absent factories; one job is the global monitor without a tenant ID.

The default shared prefix is `bull`. Queue records remain in Redis when the database connection or tenant fixtures change. The evidence is consistent with previously queued test work surviving a database/fixture change; the audit does not establish when those companies were removed.

Remediation: inspect and quarantine only the confirmed orphan jobs, retain failure evidence and valid work, validate tenant existence before external side effects, and use explicit queue namespaces for separate environments/databases. Do not flush Redis or delete current Atlas data to solve this.

### 3. Windows is running an old Redis service

The API/Worker Redis endpoint responds with version **5.0.14.1**. BullMQ repeatedly prints:

```text
It is highly recommended to use a minimum Redis version of 6.2.0
Current: 5.0.14.1
```

This warning is distinct from the Gmail and missing-tenant failures. Multiple queue connections produce multiple copies. [BullMQ's Redis compatibility documentation](https://docs.bullmq.io/guide/redis-tm-compatibility/) identifies Redis 6.2 or newer as its compatibility target.

An Ubuntu WSL installation already has Redis **8.4.0**, but the project is connected to the Windows Redis 5 service. Docker Desktop's daemon is stopped; the existing Compose configuration expects Redis 7 and port 6379, which is currently occupied by the Windows service.

Remediation: plan a supported Redis cutover with a queue/session backup and coordinated API/Worker restart. Do not start a second server against the occupied port or discard queued work to remove a warning. Current Redis memory policy is `noeviction`, which is appropriate for the queue data.

### 4. The same background failure appears in both API and Worker terminals

`src/shared/queue/queues.ts` subscribes to queue failure events and logs them. That module loads in both processes. Worker files also attach their own failure handlers. One failed send/forecast can therefore produce several terminal messages across the processes; these are not necessarily separate failed API requests.

Development additionally uses `LOG_LEVEL=debug`. This makes normal activity and retries much more visible. Reducing the log level alone would hide output without resolving delivery/orphan-job failures.

### 5. Two local configurations are running

- Development: API 4000, `.env`, default `bull` queues, Gmail SMTP, low-stock monitor scanning all active/trial factories.
- Presentation: API 4001, `.env.presentation`, `garments-presentation` queues, local SMTP 2525, monitor scoped to the presentation tenant.
- Both point to the same configured Atlas database and Redis server, using different queue prefixes.
- Stripe CLI currently forwards to API 4001.

These are separate consumers of separate queue namespaces, not two workers competing for the same job. The presentation queue snapshot has no failed email/forecast/report/scheduled jobs. The errors identified above are concentrated in the development namespace. Use a consistent API URL, configuration, worker and webhook target when reproducing a problem.

## Healthy checks

- API 4000 `/readyz`: HTTP 200, MongoDB and Redis ready.
- API 4001 `/readyz`: HTTP 200, MongoDB and Redis ready.
- Both API processes and both worker processes are running.
- No current port collision was found for these services.
- Presentation queues: zero failed jobs in the inspected queues.

Historical logs also contain an older AI-provider quota error. That archived error is not proof that a current AI call fails; no new AI generation or external email was triggered during this audit.

## Scope

This audit inspected running processes, listeners, saved logs, configuration summaries, Redis job states and tenant existence in Atlas. Existing terminal scrollback is not directly exposed by the available tools. No queues were cleared/retried, no SMTP messages were sent by the audit, and no service configuration or database records were changed. The next repair should address synthetic/orphan email work before restarting delivery against Gmail, then perform the Redis cutover separately.
