# Bangladesh garments backend verification

Generated: 2026-10-18T07:20:45.723Z. API: http://localhost:4001/api/v1. Atlas tenant: 6ad469df663965b6a909baf0.

## Verified results

| Check | Result |
|---|---|
| Real seed and complete HTTP workflow | 288 passed; 0 failed |
| Extended real regression | 218 passed; 0 failed |
| Instrumented full suite | 108 passed; 0 failed (including all 3 real integration cases) |
| Unit/security contracts | 105 passed; 0 failed; 3 opt-in integration tests skipped in unit-only mode |
| Imported Postman presentation + complete PO | 45 requests and 45 assertions passed |
| Actual SSLCommerz sandbox card + OTP | PASSED; invoice paid; 1 payment attempt after IPN replay |
| Production dependency audit | 0 known vulnerabilities |
| Development dependency audit | 24 findings (4 high, 20 moderate, 0 critical) |

## Persisted presentation data

Atlas database: test. Presentation plan: enterprise (synthetic configuration; no charge or real upgrade). Recorded AI usage is retained.

- items: 46
- stockMovements: 3698
- stockBalances: 49
- purchaseOrders: 115
- forecasts: 59
- liveAiForecasts: 59
- aiInsights: 38
- emailDeliveries: 232

Includes a 180-day movement history, 24 core garments SKUs, three warehouses, six categories, eight core suppliers, quotations, all nine PO states, GRNs, budgets, real AI output, R2 PDFs, SMTP delivery records, stock/KPI snapshots and synthetic billing examples. Additional QA records remain identified by QA/BULK prefixes. Every tested stock balance reconciles to the signed movement ledger.

## Coverage gates (unchanged repository requirements)

| Metric | Actual | Required | Result |
|---|---|---|---|
| statements | 83.75% | 70% | PASS |
| branches | 60.26% | 60% | PASS |
| functions | 82.97% | 70% | PASS |
| lines | 85.9% | 70% | PASS |

Unit-only coverage does not measure HTTP calls served by a separate process. The real coverage command runs an instrumented application and workers with actual Atlas, Redis, SMTP, R2, AI and sandbox calls. A failing coverage gate is an outstanding check, even when all functional assertions pass; no threshold has been lowered.

## Material fixes

Typecheck, build, lint and formatting checks passed. Lint retains 11 warnings; formatting was normalized across existing sources to pass the configured check.

- Atomic stock adjustments, warehouse transfers, bulk imports and PO receipts; concurrent operations cannot overspend or over-receive.
- Receipt item/line validation and duplicate-line rejection. Idempotency binds payload, route and actor and prevents concurrent duplicates.
- Correct PO tax recalculation for tax-only and revised-line updates; warehouse references remain tenant-scoped.
- Correct paid subscription tier and seats in JWT; role changes, disable and password changes revoke prior access.
- Accessible AI model configuration, bounded provider requests, fallback provenance and retryable failures. Transfers/count corrections no longer become production demand.
- Forecast history retained after cache expiry, persisted AI comparisons/briefs and report PDFs, worker tenant scopes and realtime fan-out.
- Raw webhook body preservation, minor-unit invoice amounts, strict gateway transaction/amount/currency validation and real sandbox settlement/replay verification.
- Correct 400/413/403 responses for malformed JSON, oversized JSON and rejected CORS origins; corrected Postman payloads/URLs/dates.

## Limits and deployment requirements

- Business history/prices and seeded paid/failed invoice examples are synthetic. Saved LLM responses are real. The separately verified sandbox payment is identified in artifacts/sandbox-payment-results.json.
- New forecasts have no future actuals yet; null accuracy metrics are correct. No unsupported model accuracy claim is made.
- Email was delivered over real SMTP to a local capture server; external inbox reputation/delivery was not tested. Automatic internet IPN needs a public callback URL; the test forwarded the real gateway return form to the local API and validated it against the gateway. Live merchant settlement was not attempted.
- The 20-request concurrent GET probe is a smoke load check (initial p95 422 ms), not a production-scale load/soak test.
- Installed Redis 5.0.14.1 passed the workflows but BullMQ recommends Redis >=6.2. Production should use a supported version.
- Default upload malware scanning checks the EICAR test signature only; production antivirus must be wired separately.
- Development dependency findings remain recorded; production audit is clean.

## Run and review

Read [the Bengali manual workflow](../postman/MANUAL-TEST-WORKFLOW.bn.md). Import the generated Postman collection/environment. Run Login, then folder 02 for existing data; folder 03 exercises a new complete PO. Credentials and IDs are in artifacts/garments-demo-manifest.json.

Commands: npm run typecheck; npm run build; npm run lint; npm test; npm run test:integration; npm run test:coverage:real; npm run test:payment:sandbox.

Machine evidence: artifacts/verification-summary.json, real-test-results.json, real-regression-results.json, unit-test-results.json, sandbox-payment-results.json, persisted-ai-responses.json, dependency-audit.json and production-dependency-audit.json. HTML coverage is coverage/lcov-report/index.html.
