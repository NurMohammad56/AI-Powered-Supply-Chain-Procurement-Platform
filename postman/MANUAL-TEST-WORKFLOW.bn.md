# বাংলাদেশের garments procurement: manual API test ও presentation

> **2026-10-24 subscription update:** [Stripe, 14-day trial, verification, exact API changes and onboarding sequence](SUBSCRIPTION-STRIPE-API-CHANGES.bn.md). Follow that guide for billing; older SSLCommerz steps are superseded. Verify email before business APIs. RFQ comparison is numeric by default; Owner/Manager must explicitly add `?includeAi=true` for AI. Viewer cannot update budget, generate digest or upload.


**বিস্তারিত start-to-end নির্দেশিকা:** [START-TO-END-MANUAL.bn.md](START-TO-END-MANUAL.bn.md)। কোন role দিয়ে কখন কোন API চালাবেন, সম্পূর্ণ JSON body, response থেকে ID রাখা, automatic trigger, অপেক্ষার checkpoint ও final stock reconciliation সেখানে ধাপে ধাপে দেওয়া আছে।

সব supplier, price, stock history এবং commercial transaction presentation-এর synthetic data। Forecast, quotation comparison ও procurement brief-এর AI response আসল configured provider দিয়ে তৈরি এবং MongoDB-তে সংরক্ষিত। Synthetic billing invoice/payment fixture-কে বাস্তব settlement হিসেবে দেখাবেন না।

## ১. চালু করা

`backend` directory-তে কাজ করুন। বর্তমান `.env.presentation` আপনার সচল Atlas connection ব্যবহার করে। মূল `.env`-এর অন্য data মুছে ফেলা হয়নি।

```powershell
npm install
npm run demo:setup
npm run migrate
npm run demo:ready
```

আলাদা তিনটি terminal-এ:

```powershell
npm run demo:smtp
```

```powershell
npm run demo:api
```

```powershell
npm run demo:worker
```

ইতিমধ্যে service চালু থাকলে একই port-এ দ্বিতীয় instance চালাবেন না। API: `http://localhost:4001`। MongoDB Atlas data restart-এর পরও থাকবে। Email-গুলো external recipient-এ forward হয় না; বাস্তব SMTP transport দিয়ে `.demo-data/mail/*.eml`-এ জমে। PDF/download আসল configured R2 storage ব্যবহার করে।

সম্পূর্ণ নতুন demo factory বানাতে `npm run seed:garments`। এটি নতুন factory তৈরি করে; একই presentation দেখাতে প্রতিবার seed চালানোর প্রয়োজন নেই। Remote seeding-এর জন্য presentation config-এ `DEMO_ALLOW_REMOTE=1` আছে। সব historical seed record application schema দিয়ে validate হয়; operational workflow HTTP API দিয়ে চলে।

Offline MongoDB চাইলে `npm run demo:setup -- --local`, তারপর আরেক terminal-এ `npm run demo:db`। এটি development MongoDB replica set, production hosting নয়।

## ২. Postman import ও login

`garments-demo.collection.json` ও `garments-demo.environment.json` import করুন। Environment হিসেবে **Bangladesh Garments - Presentation** নির্বাচন করুন। ওই environment-এর `ownerEmail`, `password`, `itemId`, `warehouseId`, `supplierId`, `forecastId` আগে থেকে পূরণ করা আছে। পূর্ণ credentials/IDs আরও আছে `backend/artifacts/garments-demo-manifest.json`-এ।

Folder **01 - Login** চালান:

```http
POST {{baseUrl}}/auth/login
Content-Type: application/json

{"email":"{{ownerEmail}}","password":"{{password}}"}
```

Expected **200**। Script স্বয়ংক্রিয়ভাবে `data.accessToken` environment-এ রাখে। পরের request-গুলো `Authorization: Bearer {{accessToken}}` ব্যবহার করে। Refresh token JSON response-এ থাকে না; `scp_refresh` cookie-তে থাকে।

Repeated testing-এ Growth plan-এর monthly report quota ব্যবহৃত হয়েছে। আরও live AI demo দেখানোর জন্য শুধু এই synthetic factory-তে Enterprise demo configuration রাখা হয়েছে; এটি paid upgrade বা gateway charge নয়। `demo:ready` usage history অক্ষত রেখে ওই configuration প্রয়োগ করে। নতুন করে login করলে Enterprise quota দেখা যাবে। Sandbox billing test পরে plan বদলে দিলে presentation-এর আগে আবার `demo:ready` চালাতে পারেন।

## ৩. প্রস্তুত data দিয়ে presentation

**02 - Presentation - saved data** folder ক্রমানুসারে চালান। এই folder read-only।

| ক্রম | API | কী দেখাবেন |
|---|---|---|
| ১ | `GET /healthz`, `GET /readyz` (base URL-এর `/api/v1` বাদ দিয়ে) | API process, MongoDB ও Redis readiness |
| ২ | `GET /auth/me`, `/auth/users` | Owner, manager, warehouse staff ও viewer |
| ৩ | `GET /inventory/warehouses`, `/inventory/categories`, `/inventory/items?limit=100` | Gazipur, Savar, Chattogram; fabrics, trims, packaging, chemicals, finished garments |
| ৪ | `GET /inventory/low-stock` | Reorder-level-এর নিচে item |
| ৫ | `GET /inventory/items/{{itemId}}/balances`, `/history?limit=100` | Warehouse balance ও historical movement ledger |
| ৬ | `GET /suppliers`, `/suppliers/{{supplierId}}/performance` | Supplier details ও recorded performance |
| ৭ | `GET /suppliers/compare?ids={{supplierId}},{{secondSupplierId}}` | Numeric supplier comparison |
| ৮ | `GET /quotations`, `/quotations/{{quotationId}}` | RFQ, invited supplier, submitted price/lead time |
| ৯ | `GET /ai/insights` | Database-এ রাখা actual AI quotation explanation ও procurement briefs |
| ১০ | `GET /purchase-orders?limit=100` | Draft থেকে closed, cancelled ও rejected সব state |
| ১১ | `GET /ai/forecasts?limit=100` | 30/60/90 দিনের saved forecasts |
| ১২ | `GET /ai/forecasts/{{forecastId}}`, `/evaluation`, `/visualization` | Quantity, confidence, reasoning, provider/model, evaluation এবং chart data |
| ১৩ | `GET /ai/usage` | Actual recorded token/call usage ও quota |
| ১৪ | Report API-গুলো, নিচের ধাপ ৭ | Turnover, spend, ABC, EOQ, cash flow, budget |
| ১৫ | `GET /notifications`, `/notifications/unread-count` | Workflow notification |
| ১৬ | `GET /billing/plans`, `/billing/subscription`, `/billing/invoices` | Plans ও synthetic billing examples |

নতুন forecast-এর future actual consumption এখনো ঘটেনি। তাই evaluation-এ `actualQuantity`, MAE/MAPE/RMSE `null` থাকা সঠিক; এটিকে model accuracy প্রমাণ হিসেবে উপস্থাপন করবেন না।

## ৪. সম্পূর্ণ purchase-order workflow

**03 - Complete new PO workflow** folder ক্রমানুসারে চালানো যায়। প্রথম request নতুন draft PO তৈরি করে `poId` ও `poLineId` save করে।

```http
POST /purchase-orders
{"supplierId":"{{supplierId}}","warehouseId":"{{warehouseId}}","currency":"BDT","paymentTermsDays":30,"expectedDeliveryAt":"{{future}}","lines":[{"itemId":"{{itemId}}","quantityOrdered":100,"unitPrice":480}],"taxRate":0}
```

| ক্রম | API | Expected |
|---|---|---|
| ১ | `POST /purchase-orders` | **201**, `draft`, subtotal/total 48,000 BDT |
| ২ | `POST /purchase-orders/{{poId}}/submit` body `{}` | **200**, `pending_approval` |
| ৩ | `POST /purchase-orders/{{poId}}/approve` body `{}` | **200**, `approved` |
| ৪ | `POST /purchase-orders/{{poId}}/send` body `{"sentTo":"sales0@garments.example.test"}` | **200**, `sent`; PDF এবং local SMTP email |
| ৫ | `POST /purchase-orders/{{poId}}/receipts`, নিচের body, quantity **40** | **201**, `data.po.state=partially_received`; stock +40 |
| ৬ | একই receipt endpoint, quantity **60** | **201**, `fully_received`; মোট stock +100 |
| ৭ | `GET /purchase-orders/{{poId}}/receipts` | দুটি GRN |
| ৮ | `POST /purchase-orders/{{poId}}/close` body `{}` | **200**, `closed` |
| ৯ | `GET /purchase-orders/{{poId}}/pdf` | **200**, `data.url` খুললে আসল PDF download |
| ১০ | `GET /inventory/items/{{itemId}}/balances`, `/history` | Receipt quantity ও ledger মিলবে |

Receipt body:

```json
{"warehouseId":"{{warehouseId}}","lines":[{"poLineId":"{{poLineId}}","itemId":"{{itemId}}","quantity":40,"unitCost":480,"qualityNotes":"Demo fabric inspection passed"}]}
```

Rejection বা cancellation দেখাতে **নতুন** PO নিন। `draft → submit → reject` body `{"reason":"Budget review required"}`। Cancellation: `POST /purchase-orders/{{poId}}/cancel` body `{"reason":"Buyer style cancelled"}`। Completed PO-কে আবার approve/receive করবেন না; invalid state-এ **409** হবে।

## ৫. RFQ থেকে AI recommendation ও PO

**04 - New RFQ workflow** ব্যবহার করুন।

1. `POST /quotations`: future `validUntil`, item/quantity ও invited suppliers দিন। **201**, `quotationId` save হবে।
2. Worker email process করা পর্যন্ত অপেক্ষা করুন। `.demo-data/mail`-এর নতুন `.eml` খুলে invitation URL-এর `token` নিন। Developer ছাড়া database থেকে token নেওয়ার দরকার নেই। Quotation GET response ইচ্ছাকৃতভাবে secret token প্রকাশ করে না।
3. `quoteToken` environment-এ দিন। `POST /public/quotations/responses/{{quoteToken}}` hit করুন। এই request-এ JWT লাগে না। Body-তে RFQ-এর item, `unitPrice`, `currency`, `moq`, `leadTimeDays`, `validityDays` দিন। **200**।
4. দ্বিতীয় supplier-এর আলাদা invitation token দিয়ে আবার offer submit করুন। একই token দ্বিতীয়বার ব্যবহার করলে **409**।
5. `GET /quotations/{{quotationId}}/compare`: numeric cost/lead-time comparison, recommendation এবং live `aiSummary` দেখুন। Generated summary `/ai/insights`-এও সংরক্ষিত হয়।
6. `POST /quotations/{{quotationId}}/accept` body `{"supplierId":"{{supplierId}}","warehouseId":"{{warehouseId}}"}`। **200**, `data.purchaseOrder` নতুন draft PO। নতুন `poId` ও line ID নিয়ে ধাপ ৪-এর submit/approve/send/receive workflow চালান।

## ৬. AI forecast workflow

**05 - Live AI workflow**:

```http
POST /ai/forecasts
{"itemId":"{{itemId}}","horizonDays":30}
```

**200**। `predictedQuantity`, `predictedRange`, `confidence`, `reasoning`, `reorderPointSuggestion`, `provenance.provider/model/fallback` দেখুন। `fallback=true` হলে সেটি deterministic recovery calculation; actual LLM result বলে উপস্থাপন করবেন না। Provider failure-এর পর fallback ইতিহাসে থাকে, কিন্তু successful forecast-এর মতো cache-এ আটকে রাখা হয় না।

- একই item/horizon-এর successful result ২৪ ঘণ্টা cache হতে পারে; একই response পাওয়া স্বাভাবিক। নতুন provider call বোঝাতে অন্য item/horizon নিন।
- `horizonDays`: 7, 14, 30, 60, 90। 7/14 দিন 30 দিনের provider estimate থেকে scale হয়।
- `POST /ai/forecasts/batch` body `{"itemIds":["{{itemId}}","{{secondItemId}}"]}` → queue/job ID। Worker চালু থাকতে হবে; পরে forecast list refresh করুন।
- AI endpoint rate limit **10 requests/minute/tenant**। **429** হলে অন্তত ৬১ সেকেন্ড অপেক্ষা করুন। Provider quota আলাদাও প্রযোজ্য।
- `POST /ai/forecasts/{{forecastId}}/override` body `{"quantity":2500,"justification":"Reviewed production requirement"}`। Quantity ও justification সংরক্ষণ হবে।
- `POST /purchase-orders/from-forecast` body `{"itemId":"{{itemId}}","warehouseId":"{{warehouseId}}","expectedDeliveryAt":"{{future}}"}` → preferred supplier ও stock deficit থেকে draft PO। Stock যথেষ্ট থাকলে order creation reject হতে পারে।
- `GET /ai/usage` quota এবং recorded usage দেখায়। Cost একটি estimate; provider invoice নয়।

## ৭. Report, budget ও AI PDF

`from` এবং `to` ISO timestamp; environment-এ গত ১৮০ দিনের range আছে।

| API | কী দেখাবে |
|---|---|
| `GET /reports/inventory-turnover?from={{from}}&to={{to}}` | Inventory consumption/turnover |
| `GET /reports/spend-by-supplier?from={{from}}&to={{to}}` | Supplier-wise procurement spend |
| `GET /reports/supplier-cost-comparison?from={{from}}&to={{to}}` | Supplier cost comparison |
| `GET /reports/dead-stock?from={{from}}&to={{to}}` | Slow/dead stock |
| `GET /reports/abc-analysis?from={{from}}&to={{to}}` | A/B/C inventory classification |
| `GET /reports/eoq?itemId={{itemId}}&orderingCost=1500&holdingCostRate=0.2` | EOQ ও reorder recommendation |
| `GET /reports/cash-flow-projection` | Open PO-র forward payable projection |
| `POST /reports/budget` body `{"monthlyLimit":5000000,"currency":"BDT","warningThresholdPct":80}` | Monthly budget সংরক্ষণ |
| `GET /reports/budget` | Utilization/remaining/status |
| `POST /reports/weekly-digest` body `{"from":"{{from}}","to":"{{to}}"}` | **202**, AI report queue হবে |
| `GET /reports/artifacts` | `pending/rendering/ready/failed` status; report ID নিন |
| `GET /reports/artifacts/<id>/download` | ready PDF-এর signed URL |

Weekly report rendering-এর জন্য installed Chrome/Chromium path `.env.presentation`-এ `CHROMIUM_EXECUTABLE_PATH` হিসেবে আছে। Report narrative `/ai/insights`-এ এবং report metadata `reportartifacts` collection-এ থাকে। Signed URLs expire করে; নতুন download URL নিন।

## ৮. Auth, permission, negative case ও concurrency

পরীক্ষার আগে presentation data রক্ষায় temporary item/user/PO ব্যবহার করুন। `npm run test:integration` এগুলো বাস্তব API ও Atlas দিয়ে চালায়।

| Test | Expected |
|---|---|
| Bearer token ছাড়া protected GET | **401** |
| Invalid/tampered JWT | **401** |
| Viewer দিয়ে item create | **403** |
| অন্য factory-এর item GET | **404** |
| Invalid ObjectId, zero adjustment, duplicate receipt line, wrong receipt item | **400** |
| Duplicate SKU | **409** |
| Stock-এর বেশি negative adjustment | **400**; balance বদলাবে না |
| একই warehouse-এ transfer | **400** |
| একই `Idempotency-Key` ও একই body পুনরায় | একই result; দ্বিতীয় movement হবে না |
| একই key-তে আলাদা body | **409** |
| 10 stock রেখে একসঙ্গে দুটি -8 adjustment | একটিই সফল; final stock 2 |
| 10-unit PO-তে একসঙ্গে দুটি 6-unit receipt | একটিই সফল; received 6 |
| `atomic=true` bulk import-এর দ্বিতীয় row invalid | প্রথম row-ও rollback |
| Fake `.pdf` file-এ HTML bytes | **400/415** |
| Malformed JSON / >1 MiB JSON | **400 / 413** |
| Unapproved CORS origin | **403** |
| Expired/reused quotation token | **400/409**, invalid token **401** |
| Role change/disable/password change-এর পর পুরোনো access token | **401** |

Refresh: login-এর cookie রাখতে Postman cookie jar ব্যবহার করুন; `POST /auth/refresh` body `{}` ও `X-CSRF` header দিন (কমপক্ষে ৮ character)। Header না দিলে **403**। পুরোনো refresh cookie reuse করলে **401**, ওই session family revoke হয়। `POST /auth/logout` বর্তমান refresh session এবং `/auth/logout-everywhere` সব session revoke করে। Password reset ও invitation token local captured email-এ পাবেন।

## ৯. Upload, email ও realtime

- `POST /uploads`: `multipart/form-data`, `kind=pdf`, `file=<actual PDF>`। `uploaded=true`, key এবং signed URL পরীক্ষা করুন।
- `POST /suppliers/{{supplierId}}/documents`: multipart `kind=cert`, `file=<actual PDF>`।
- Receipt বা stock adjustment attachment-এর জন্য multipart `file` ব্যবহার করা যায়; receipt payload JSON-টি `payload` form field-এ দিন।
- `.demo-data/mail/*.eml` দিয়ে invitation, approval, dispatch, receipt এবং digest email দেখুন। এটি local SMTP delivery-এর প্রমাণ; external inbox delivery-এর দাবি নয়।
- Socket.IO path `/realtime`, WebSocket transport, handshake auth `{token: accessToken}`। API user/factory room নিজে join করায়। Worker event Redis adapter দিয়ে API client-এ যায়।

## ১০. Billing-এর বাস্তব সীমা

SSLCommerz sandbox-এ checkout, official test card/OTP দিয়ে payment, gateway response form, backend validation, `paid` invoice, `succeeded` payment attempt ও IPN replay পরীক্ষা করা হয়েছে। আবার চালাতে `npm run test:payment:sandbox`। Script শুধু sandbox host-এ চলে; gateway-এর return-form payload local backend-এ পাঠিয়ে validation API দিয়ে যাচাই করে। Evidence: `backend/artifacts/sandbox-payment-results.json`। Test card ও OTP-এর উৎস: [official SSLCommerz sandbox documentation](https://sandbox-gw.sslcommerz.com/docs)।

ম্যানুয়ালি `POST /billing/checkout-session`-এ `gateway=sslcommerz`, non-trial tier ও success/cancel URL দিন; redirect URL খুলে sandbox payment সম্পন্ন করুন। Internet থেকে automatic server-to-server IPN পেতে public callback URL লাগবে। Production merchant settlement ও external inbox delivery এই local test-এর আওতায় নয়। Synthetic `paid` invoice fixture-কে gateway-verified sandbox transaction-এর সঙ্গে গুলিয়ে ফেলবেন না।

Webhook URL: **`/api/v1/webhooks/sslcommerz`**। পুরোনো `/api/v1/webhooks` path ব্যবহার করবেন না। Raw form/JSON payload গ্রহণ করে gateway-এর validation API দিয়ে transaction, amount ও currency যাচাই করা হয়। Invoice/payment amounts smallest currency unit (BDT paisa/USD cents), plan display price major unit। Stripe এই deployment-এ disabled; Stripe checkout/webhook **501** expected।

## ১১. Test evidence ও পুনরায় চালানো

```powershell
npm run typecheck
npm run build
npm run lint
npm test
npm run test:coverage
npm run test:coverage:real
npm run test:integration
npm run demo:postman
```

`backend/artifacts/real-test-results.json`: seed/API workflow result। `real-regression-results.json`: security, concurrency, uploads, auth, workers ও external dependency result। `persisted-ai-responses.json`: saved provider output export। `garments-demo-manifest.json`: IDs, credentials ও final counts। `dependency-audit.json`/`production-dependency-audit.json`: dependency scan। Unit coverage-এর HTML: `backend/coverage/lcov-report/index.html`।

`test:coverage` এবং `test:coverage:real` একই process-এ বাস্তব HTTP app ও worker চালিয়ে Atlas/Redis/SMTP/R2/AI/sandbox flow instrument করে। `test:coverage:unit` দিয়ে শুধু unit suite-এর narrow coverage দেখা যায়; external workflow সেখানে মাপা হয় না। Repository-র coverage threshold অপরিবর্তিত আছে; `coverage-summary.json` ও test report-এ ফল দেখুন। Repeated integration run-এর আগে শুধু dedicated synthetic tenant-এর AI/file rate bucket reset হয়; production tenant-এর data বা rate limit বদলায় না।

`API-ENDPOINT-CATALOG.md`-এ current source থেকে সব endpoint তালিকাভুক্ত। Presentation collection-এর folder 02 পুরোটা read-only runner হিসেবে ব্যবহারযোগ্য। অন্য folder mutation করে; প্রয়োজনমতো পৃথক workflow চালাবেন। সব endpoint থাকা এবং প্রত্যেক external settlement/production-scale scenario tested হওয়া আলাদা বিষয়; verified result ও সীমাবদ্ধতা test report-এ দেখুন।
