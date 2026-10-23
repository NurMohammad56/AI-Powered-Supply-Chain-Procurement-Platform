# Start থেকে end: garments procurement-এর manual API walkthrough

এই নির্দেশিকায় আপনি Postman থেকে একটি নতুন cotton procurement চালাবেন: stock কমবে → RFQ যাবে → দুই supplier দাম দেবে → AI comparison হবে → একটি offer accept হবে → PO approve ও send হবে → ৪০ + ৬০ kg receive হবে → PO close হবে → AI ও PDF report যাচাই হবে। প্রতিটি ধাপ সফল হওয়ার পর পরের ধাপে যাবেন।

মূল ক্রম:

```text
Readiness → Login → Existing data দেখা → নতুন test item ও stock
→ RFQ → Supplier A/B response → Compare → Accept → Draft PO
→ Submit → Approve → Send → Receive 40 → Receive 60 → Close
→ Stock reconciliation → AI forecast/batch → Reports/PDF
→ Permission/negative tests → Optional billing → Logout
```

এখানে business data ও দাম synthetic; configured provider-এর সফল AI output বাস্তব provider response। প্রত্যেক POST আলাদা business action। পুরো collection একসঙ্গে Runner-এ চালাবেন না: supplier token নেওয়া, response থেকে ID রাখা এবং report তৈরি হওয়ার অপেক্ষায় manual checkpoint আছে।

## ১. আগে service ও Postman প্রস্তুত করুন

API root `http://localhost:4001`; environment-এর `baseUrl` হবে **`http://localhost:4001/api/v1`**। নিচের সব `/...` API path-এর আগে `{{baseUrl}}` বসবে, শুধু health/readiness ছাড়া।

প্রথমে browser/Postman দিয়ে:

| Request                             | সফল হলে                        | ব্যর্থ হলে করণীয়                    |
| ----------------------------------- | ------------------------------ | ----------------------------------- |
| `GET http://localhost:4001/healthz` | API সাড়া দেবে                  | API process চালু করুন               |
| `GET http://localhost:4001/readyz`  | `ok=true`, Mongo ও Redis ready | Atlas connection এবং Redis ঠিক করুন |

আগে থেকে চালু থাকলে আরেক instance চালাবেন না। বন্ধ থাকলে `backend` directory থেকে তিনটি আলাদা terminal-এ যথাক্রমে `npm run demo:smtp`, `npm run demo:api`, `npm run demo:worker` চালান। MongoDB ও Redis-ও সচল থাকতে হবে। শুধু API চালু থাকলে login কাজ করলেও queued email, forecast batch ও weekly report শেষ হবে না। PDF-এর জন্য Chrome এবং R2 configuration দরকার।

Postman-এ `garments-demo.collection.json` ও `garments-demo.environment.json` import করে **Bangladesh Garments - Presentation** environment select করুন। নতুন request collection-এর ভেতরে বানান, যাতে inherited Bearer auth পাওয়া যায়। JSON request: Body → raw → JSON; header `Content-Type: application/json`। GET-তে body দেবেন না।

Environment-এর existing `warehouseId`, `categoryId`, `supplierId`, `secondSupplierId`, `itemId` presentation data-এর ID। এই guide-এ নতুন item-এর জন্য আলাদা **`testItemId`** ব্যবহার করব। Existing `itemId` বদলাবেন না: historical AI demo-তে সেটি লাগবে।

নিচের script একবার কোনো request-এর Pre-request script-এ চালিয়ে সরিয়ে দিন; fresh date ও unique SKU suffix তৈরি হবে:

```javascript
const now = Date.now();
pm.environment.set("runSuffix", now.toString(36));
pm.environment.set("future", new Date(now + 14 * 86400000).toISOString());
pm.environment.set("from", new Date(now - 180 * 86400000).toISOString());
pm.environment.set("to", new Date(now + 86400000).toISOString());
```

**Retry-এর নিয়ম:** collection-এর Pre-request script প্রতিটি POST-তে নতুন `Idempotency-Key` দেয়। নতুন action-এর জন্য এটি ঠিক। Network timeout-এর পরে একই receipt/adjustment retry করতে হলে ওই script সাময়িক বন্ধ করে আগের **একই key ও একই body** পাঠাবেন; key-এর দৈর্ঘ্য ৮–২৫৫ character। নতুন key দিলে সেটি নতুন action হিসেবে চলতে পারে। Response অনিশ্চিত হলে আগে GET দিয়ে বর্তমান PO/receipt/stock দেখুন।

## ২. Login ও role বদলানোর নিয়ম

নতুন factory register করার দরকার নেই; প্রস্তুত factory-তেই কাজ করবেন। সব demo role-এর password `GarmentsDemo!2026`।

| Role            | Email                                            | এই walkthrough-এ কাজ              |
| --------------- | ------------------------------------------------ | --------------------------------- |
| Owner           | `owner.d19ac4c6@garments.example.test`           | Setup, approval, reports, billing |
| Manager         | `manager.d19ac4c6@garments.example.test`         | RFQ, PO submit ও dispatch         |
| Warehouse staff | `warehouse_staff.d19ac4c6@garments.example.test` | Stock movement ও GRN receipt      |
| Viewer          | `viewer.d19ac4c6@garments.example.test`          | Read access ও permission test     |

প্রথমে folder **01 - Login** থেকে owner login করুন:

```http
POST {{baseUrl}}/auth/login
```

```json
{ "email": "{{ownerEmail}}", "password": "{{password}}" }
```

**Expected:** 200। Generated login request নিজে `data.accessToken` → environment `accessToken` রাখে। নতুন login request বানালে Post-response script দিন:

```javascript
pm.test("Login successful", () => pm.response.to.have.status(200));
if (pm.response.code === 200) {
  pm.environment.set("accessToken", pm.response.json().data.accessToken);
}
```

এরপর `GET /auth/me` দিয়ে role ও factory মিলিয়ে নিন। Protected request-এ `Authorization: Bearer {{accessToken}}` লাগবে। অন্য role-এ যেতে একই login API-তে email বদলাবেন; script নতুন token রাখবে। Login করার পরে পরের সব request সেই role দিয়ে চলবে। Demo-র সহজ smoke test owner দিয়েও করা যায়; নিচের role switching বাস্তব দায়িত্বের ক্রম দেখায়।

## ৩. প্রথমে আগে থেকে রাখা data দেখান

Folder **02 - Presentation - saved data** চালাতে পারেন। এখানে mutation নেই। সংক্ষিপ্ত presentation-এর ক্রম:

1. `GET /inventory/warehouses`, `/inventory/categories`, `/inventory/items?limit=100` — কারখানার store ও garments catalogue।
2. `GET /inventory/items/{{itemId}}/balances`, `/history?limit=100` — saved item-এর balance ও দীর্ঘ historical ledger।
3. `GET /suppliers`, `/suppliers/{{supplierId}}/performance` — supplier ও recorded performance।
4. `GET /purchase-orders?limit=100`, `/quotations` — আগের procurement-এর বিভিন্ন state।
5. `GET /ai/forecasts?limit=100`, `/ai/insights`, `/ai/usage` — DB-তে রাখা forecast, AI explanation ও usage।

GET saved forecast/insight পড়লে নতুন AI call হয় না। `GET /quotations/:id/compare` আলাদা: এটি live AI summary তৈরি করতে পারে এবং usage বাড়তে পারে।

## ৪. নতুন controlled test item তৈরি করুন

**Role: owner।** Existing warehouse/category/supplier ব্যবহার করব; শুধু নতুন item তৈরি করব, যাতে stock-এর হিসাব পরিষ্কার থাকে।

```http
POST /inventory/items
```

```json
{
  "sku": "MANUAL-COTTON-{{runSuffix}}",
  "name": "Manual demo cotton yarn - Bangladesh RMG",
  "categoryId": "{{categoryId}}",
  "unit": "kg",
  "type": "raw_material",
  "preferredSupplierId": "{{supplierId}}",
  "reorderLevel": 100,
  "movingAverageCost": 480,
  "currency": "BDT"
}
```

**Expected:** 201; `data.id` environment-এর `testItemId`-তে রাখুন। নতুন item তৈরি করলেই opening stock তৈরি হয় না। Save করার Post-response script:

```javascript
if (pm.response.code === 201) {
  pm.environment.set("testItemId", pm.response.json().data.id);
}
```

এখন warehouse staff login করুন। Opening stock দিন:

```http
POST /inventory/items/{{testItemId}}/adjust
```

```json
{
  "warehouseId": "{{warehouseId}}",
  "quantityDelta": 200,
  "reasonCode": "opening",
  "notes": "Manual walkthrough opening stock"
}
```

সফল হলে balance হবে **200 kg** এবং movement ledger-এ +200। তারপর production consumption দেখাতে একই endpoint-এ **নতুন action/key** দিয়ে:

```json
{
  "warehouseId": "{{warehouseId}}",
  "quantityDelta": -180,
  "reasonCode": "production_consume",
  "notes": "Yarn issued to knitting production"
}
```

যাচাই করুন:

- `GET /inventory/items/{{testItemId}}/balances` → নির্বাচিত warehouse-এ **20 kg**।
- `GET /inventory/items/{{testItemId}}/history` → +200 opening ও -180 production consumption।
- `GET /inventory/low-stock` → এই নতুন item পাওয়া যাবে, কারণ 20 < reorder level 100। Stock transaction-এই low-stock marker set হয়। Threshold-এর সমান quantity healthy; threshold 0 হলে alert বন্ধ।

**কী trigger হলো:** balance, movement ও low-stock marker transactionalভাবে বদলেছে। Worker-এর monitor সাধারণত ৬০ সেকেন্ডের মধ্যে Owner/Manager/Warehouse staff-এর preference অনুযায়ী in-app alert/email queue করে এবং 30-day AI forecast queue করতে পারে। একই low-stock episode-এ বারবার email যায় না। Recent forecast, cache ও quota থাকলে নতুন provider call নাও হতে পারে। এটি নিজে RFQ/PO তৈরি করে না। বিস্তারিত: [Low-stock automation](LOW-STOCK-AUTOMATION.bn.md)।

## ৫. দুই supplier-কে RFQ পাঠান

**Role: manager login করুন।** RFQ quantity 100 kg; এখনই stock বাড়বে না।

```http
POST /quotations
```

```json
{
  "validUntil": "{{future}}",
  "lines": [
    { "itemId": "{{testItemId}}", "quantity": 100, "targetUnitPrice": 480 }
  ],
  "invitedSuppliers": [
    {
      "supplierId": "{{supplierId}}",
      "contactEmail": "offer-a@garments.example.test"
    },
    {
      "supplierId": "{{secondSupplierId}}",
      "contactEmail": "offer-b@garments.example.test"
    }
  ]
}
```

**Expected:** 201। `data.id` → **`newQuotationId`** save করুন। Existing `quotationId` আলাদা রাখুন। Collection folder 04 ব্যবহার করলে সেটি নিজস্ব `quotationId` overwrite করতে পারে; পরের request-এ আপনি কোন variable ব্যবহার করছেন মিলিয়ে নিন।

**Automatic:** দুই invitation email queue হবে, expiry check schedule হবে। Worker email process করলে `backend/.demo-data/mail`-এ নতুন `.eml` আসবে। Outlook/mail viewer দিয়ে দুই email খুলুন; quoted-printable encoding থাকলে raw text থেকে ভাঙা URL copy করবেন না।

প্রতিটি supplier-এর invitation URL থেকে আলাদা token নিয়ে environment-এ **`quoteTokenA`**, **`quoteTokenB`** রাখুন। Email-এর recipient ও RFQ number মিলিয়ে নিন। GET RFQ-তে secret token পাওয়া যাবে না।

**পরের ধাপে যাওয়ার শর্ত:** দুই supplier-এর সঠিক token হাতে আছে। Email না এলে নতুন RFQ বানাতে থাকবেন না; worker, SMTP ও worker log পরীক্ষা করুন।

## ৬. Supplier-এর public offer submit করুন

এটি supplier-এর কাজ: JWT লাগে না। Postman request-এর Authorization → **No Auth** দিন।

```http
POST /public/quotations/responses/{{quoteTokenA}}
```

```json
{
  "lines": [
    {
      "itemId": "{{testItemId}}",
      "unitPrice": 480,
      "currency": "BDT",
      "moq": 50,
      "leadTimeDays": 7,
      "validityDays": 14
    }
  ],
  "comments": "Supplier A: local yarn supply, delivery to Gazipur"
}
```

**Expected:** 200। তারপর দ্বিতীয় token-এর endpoint-এ নতুন request:

```http
POST /public/quotations/responses/{{quoteTokenB}}
```

```json
{
  "lines": [
    {
      "itemId": "{{testItemId}}",
      "unitPrice": 500,
      "currency": "BDT",
      "moq": 50,
      "leadTimeDays": 5,
      "validityDays": 14
    }
  ],
  "comments": "Supplier B: faster delivery option"
}
```

**Expected:** 200। আলাদা supplier token অবশ্যই আলাদা। একই token দিয়ে নতুন করে submit করলে 409 হতে পারে।

Manager Bearer auth দিয়ে `GET /quotations/{{newQuotationId}}` hit করুন। দুই response-এর item, price ও lead time যাচাই করুন। Offer submit করলে stock বা PO তৈরি হবে না।

## ৭. AI comparison দেখে supplier নির্বাচন করুন

**Role: manager; inherited Bearer auth ফিরিয়ে দিন।**

```http
GET /quotations/{{newQuotationId}}/compare
```

**Expected:** 200; numeric comparison-এ A-এর 100 × 480 = **48,000 BDT**, B-এর 100 × 500 = **50,000 BDT** এবং delivery trade-off দেখুন। AI summary থাকলে পড়ুন; এরপর `GET /ai/insights`-এ নতুন quotation comparison খুঁজুন। Provider/quota সমস্যা হলে numeric comparison পাওয়া গেলেও `aiSummary` null হতে পারে; তখন live AI success দাবি করবেন না।

AI recommendation দেখেই purchase সম্পন্ন হয় না। সিদ্ধান্ত কার্যকর করতে:

```http
POST /quotations/{{newQuotationId}}/accept
```

```json
{ "supplierId": "{{supplierId}}", "warehouseId": "{{warehouseId}}" }
```

**Expected:** 200। `data.quotation` accepted এবং `data.purchaseOrder` draft হবে। Post-response script:

```javascript
if (pm.response.code === 200) {
  const po = pm.response.json().data.purchaseOrder;
  pm.test("Draft PO created", () => pm.expect(po).to.be.an("object"));
  if (po) {
    pm.environment.set("poId", po.id);
    pm.environment.set("poLineId", po.lines[0].id);
  }
}
```

**Checkpoint:** `GET /purchase-orders/{{poId}}` দিয়ে draft, quantity 100, unit price 480, total 48,000 এবং নতুন `testItemId` মিলিয়ে নিন। Acceptance সফল হলেও `purchaseOrder=null` হতে পারে যদি draft creation ব্যর্থ হয়। সেক্ষেত্রে নিচের বিকল্প manual creation ব্যবহার করুন; accepted RFQ আবার accept করার চেষ্টা করবেন না।

### বিকল্প: RFQ বাদ দিয়ে সরাসরি PO তৈরি

এটি মূল flow-এর **বিকল্প**। RFQ থেকে PO ইতিমধ্যে পেলে এই request বাদ দিন।

```http
POST /purchase-orders
```

```json
{
  "supplierId": "{{supplierId}}",
  "warehouseId": "{{warehouseId}}",
  "currency": "BDT",
  "paymentTermsDays": 30,
  "expectedDeliveryAt": "{{future}}",
  "lines": [
    { "itemId": "{{testItemId}}", "quantityOrdered": 100, "unitPrice": 480 }
  ],
  "taxRate": 0
}
```

201 হলে `data.id` → `poId`, `data.lines[0].id` → `poLineId`। Folder 03-এর প্রথম request এই creation করে। **RFQ থেকে পাওয়া PO চালাতে folder 03-এর Create request skip করে Submit থেকে শুরু করবেন।** Generated receipt body-তে `itemId` থাকে; এই নতুন-item walkthrough-এ সেটি `{{testItemId}}` করতে হবে।

## ৮. PO submit, approval ও supplier dispatch

প্রতিটি response-এর পরে `GET /purchase-orders/{{poId}}` দিয়ে state যাচাই করুন। এই ধাপগুলোর কোনোটিতে stock বাড়বে না।

| ধাপ | কে / API / body                                                                              | Expected ও automatic কাজ                                                                                                                  | পরের ধাপের শর্ত                                                  |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| ৮.১ | Manager: `POST /purchase-orders/{{poId}}/submit`, `{}`                                       | 200; `pending_approval`; অন্য approver-দের notification/email শুরু                                                                        | Owner login করে state ও notification দেখুন                       |
| ৮.২ | Owner: `POST /purchase-orders/{{poId}}/approve`, `{}`                                        | 200; `approved`; background-এ PDF render/upload, requester notification/email                                                             | State approved; PDF পেতে কিছু সময় লাগতে পারে                     |
| ৮.৩ | Manager: `POST /purchase-orders/{{poId}}/send`, `{"sentTo":"offer-a@garments.example.test"}` | 200; `sent`; PDF generation/storage চেষ্টা, PDF URL পাওয়া গেলে supplier email queue; expected delivery-এর ৭ দিন পর overdue check schedule | PO sent, PDF URL download হয় ও captured supplier email পাওয়া যায় |

Approval-এর response-এ PDF না থাকলেই ব্যর্থ ধরে আবার approve করবেন না। `GET /purchase-orders/{{poId}}/pdf` থেকে fresh `data.url` নিয়ে browser-এ খুলুন। Send-এর পরেও `sent` state একা email delivery-এর প্রমাণ নয়; `.eml` ও download আলাদা যাচাই করুন।

`GET /notifications` বর্তমানে logged-in user-এর feed। Manager submit করায় owner approver notification পাবেন; owner approval দিলে requester manager-এর feed দেখুন। সব role একই notification পাবে এমন ধরে নেবেন না। Email worker লাগে; in-app record ও email transport আলাদা। Overdue alert ভবিষ্যতের scheduled কাজ; সঙ্গে সঙ্গে আসার কথা নয়।

## ৯. GRN: প্রথমে ৪০ kg receive করুন

**Role: warehouse staff login করুন।** Send সম্পন্ন, বাস্তবে goods এসেছে—এখন receipt API।

```http
POST /purchase-orders/{{poId}}/receipts
```

```json
{
  "warehouseId": "{{warehouseId}}",
  "lines": [
    {
      "poLineId": "{{poLineId}}",
      "itemId": "{{testItemId}}",
      "quantity": 40,
      "unitCost": 480,
      "qualityNotes": "First lot: yarn quality inspection passed"
    }
  ],
  "notes": "First delivery challan: 40 kg"
}
```

**Expected:** 201; `data.po.state=partially_received`, receipt/GRN তৈরি; selected warehouse stock **20 + 40 = 60 kg**। Receipt ID-ও সংরক্ষণ করতে পারেন।

যাচাই: `GET /purchase-orders/{{poId}}/receipts` → একটি receipt; item balances → 60; history → নতুন receipt movement +40। `poLineId` হবে এই PO-এর line ID; item ID বা পুরোনো PO-এর line ID নয়।

## ১০. বাকি ৬০ kg receive, তারপর close

একই receipt endpoint-এ **নতুন action/key** দিয়ে পাঠান; quantity এবার **60**, notes দ্বিতীয় delivery। আগের 100 আবার পাঠাবেন না।

```json
{
  "warehouseId": "{{warehouseId}}",
  "lines": [
    {
      "poLineId": "{{poLineId}}",
      "itemId": "{{testItemId}}",
      "quantity": 60,
      "unitCost": 480,
      "qualityNotes": "Second lot accepted"
    }
  ],
  "notes": "Final delivery challan: remaining 60 kg"
}
```

**Expected:** 201; `fully_received`; total received 100; stock **120 kg**; দুটি GRN।

**Receipt-এর automatic কাজ:** stock, ledger ও received quantity transaction-এ বদলায়। Commit-এর পরে reorder level অতিক্রম করলে active low-stock marker clear করার চেষ্টা হয়; affected item-এর recent 30-day forecast গত ৬ ঘণ্টায় না থাকলে forecast job queue হতে পারে। Recent forecast থাকলে skip হয়—প্রতিটি receipt-এ নতুন AI result আসা বাধ্যতামূলক নয়। Full receipt-এ confirmation notification/email শুরু হয়।

এখন manager/owner login করে:

```http
POST /purchase-orders/{{poId}}/close
```

Body `{}` → 200, `closed`। Close আর stock বাড়ায় না; এটি lifecycle শেষ করে।

Final reconciliation:

| কী মিলাবেন            | এই নতুন item-এর expected |
| --------------------- | ------------------------ |
| Opening               | +200 kg                  |
| Production issue      | -180 kg                  |
| GRN 1 / GRN 2         | +40 / +60 kg             |
| Warehouse balance     | **120 kg**               |
| PO ordered / received | **100 / 100 kg**         |
| PO total / state      | **48,000 BDT / closed**  |
| Receipt count         | **2**                    |

`GET /inventory/low-stock`-এ item আর থাকার কথা নয়। Stock purchase ও physical receipt আলাদা; PO total দেখেই stock বেড়েছে ভাববেন না।

## ১১. Live AI forecast এবং batch

**Role: owner/manager।** অর্থপূর্ণ history-সহ forecast দেখাতে environment-এর পুরোনো **`itemId`** ব্যবহার করুন। নতুন `testItemId`-তে মাত্র কয়েকটি movement, তাই তার forecast historical demo item-এর সমতুল্য নয়।

```http
POST /ai/forecasts
```

```json
{ "itemId": "{{itemId}}", "horizonDays": 60 }
```

200 হলে `data.id` → `newForecastId` save করুন। Quantity, confidence, reasoning, reorder suggestion এবং `provenance.provider/model/fallback` দেখুন। `fallback=true` recovery calculation বোঝায়; live LLM success নয়।

এরপর এই ক্রমে:

1. `GET /ai/forecasts/{{newForecastId}}` — saved response আবার পাওয়া যায়।
2. `GET /ai/forecasts/{{newForecastId}}/visualization` — chart data।
3. `GET /ai/forecasts/{{newForecastId}}/evaluation` — future horizon শেষ না হলে actual/error metric null হওয়া স্বাভাবিক।
4. `GET /ai/usage` — quota ও recorded usage।
5. চাইলে `POST /ai/forecasts/{{newForecastId}}/override` body `{"quantity":2500,"justification":"Production manager reviewed upcoming buyer order"}` — human override সংরক্ষণ। এটি PO নয়।

একই item/horizon successful result ২৪ ঘণ্টা cache হতে পারে; একই response মানেই নতুন provider call নয়। Concurrent/in-progress generation-এর lock-ও আছে। 429 হলে error detail দেখুন; minute rate limit হলে ৬১ সেকেন্ড অপেক্ষা করুন, quota/lock হলে সেই কারণ সমাধান করুন।

Batch চালাতে `POST /ai/forecasts/batch`:

```json
{ "itemIds": ["{{itemId}}", "{{secondItemId}}"] }
```

Job ID রাখা মানে job শেষ নয়। Worker চালু রেখে forecast list refresh করুন; completion summary/email ও individual result দেখুন। Socket.IO client থাকলে `/realtime` path, handshake auth `{token: accessToken}` দিয়ে `ai.forecast.batch.progress`, `ai.forecast.batch.completed`, `ai.forecast.completed` শুনতে পারেন। শুধু সাধারণ WebSocket client Socket.IO protocol-এর বিকল্প নয়।

**আরেকটি বিকল্প procurement entry:** `POST /purchase-orders/from-forecast` body `{"itemId":"{{itemId}}","warehouseId":"{{warehouseId}}","expectedDeliveryAt":"{{future}}"}`। Latest forecast, preferred supplier ও stock deficit থাকলে draft PO হয়। যথেষ্ট stock হলে reject হতে পারে। এটি আলাদা order; চালালে তার নতুন PO ID নিয়ে submit থেকে flow চালাতে হবে। আগের closed PO overwrite করে receipt পাঠাবেন না।

## ১২. Budget, numerical reports, AI PDF

**Role: owner।** আগে `GET /reports/budget` দিয়ে আগের budget দেখুন। পরিবর্তন করতে চাইলে:

```http
POST /reports/budget
```

```json
{
  "monthlyLimit": 5000000,
  "currency": "BDT",
  "warningThresholdPct": 80,
  "notes": "Manual garments procurement presentation"
}
```

আবার GET দিয়ে monthly limit/utilization দেখুন। এখন numerical report পড়ুন:

| API                                                                        | কী বোঝাবেন                                                  |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `GET /reports/inventory-turnover?from={{from}}&to={{to}}`                  | Production consumption ও inventory turnover                 |
| `GET /reports/spend-by-supplier?from={{from}}&to={{to}}`                   | Procurement spend by supplier                               |
| `GET /reports/supplier-cost-comparison?from={{from}}&to={{to}}`            | Recorded cost comparison                                    |
| `GET /reports/dead-stock?from={{from}}&to={{to}}`                          | Inactive/slow stock                                         |
| `GET /reports/abc-analysis?from={{from}}&to={{to}}`                        | Inventory classification                                    |
| `GET /reports/eoq?itemId={{itemId}}&orderingCost=1500&holdingCostRate=0.2` | EOQ calculation                                             |
| `GET /reports/cash-flow-projection`                                        | Open PO payable projection; closed PO আর open obligation নয় |

নতুন AI PDF-এর আগে `GET /reports/artifacts` দিয়ে latest ID/time নোট করুন। তারপর একবার:

```http
POST /reports/weekly-digest
```

```json
{ "from": "{{from}}", "to": "{{to}}" }
```

**Expected:** 202, queued। এটি PDF তৈরির শেষ response নয়; endpoint report job ID দেয় না।

**Trigger chain:** queue → worker aggregates data → AI narrative → saved insight → Chrome PDF → R2 upload → artifact ready → email delivery।

প্রতি ২–৫ সেকেন্ডে `GET /reports/artifacts` করুন। নতুন সময়ের artifact খুঁজুন; status `ready` হলে তার `_id` → `reportArtifactId`। Worker job চলার সময়ে record আসতে কিছুটা সময় লাগতে পারে। অপেক্ষার সময় বারবার POST করে report বাড়াবেন না।

```http
GET /reports/artifacts/{{reportArtifactId}}/download
```

Response-এর signed URL browser-এ খুলে PDF পড়ুন; `GET /ai/insights`-এ brief ও `.eml`-এ digest দেখুন। `failed` হলে error ও worker log পরীক্ষা করুন; missing Chrome/R2/provider/quota ঠিক করে তারপর নতুন attempt। URL expire হলে নতুন download URL নিন।

## ১৩. Additional features ও failure branch আলাদা করে পরীক্ষা

এগুলো মূল closed PO-তে চালাবেন না। প্রতিটি failure branch-এর জন্য নতুন temporary item/PO/user নিন। পূর্ণ endpoint তালিকা [API-ENDPOINT-CATALOG.md](API-ENDPOINT-CATALOG.md)-এ।

| Case                | কখন/কী করবেন                                                                                                                                                    | Expected                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| PO reject/revise    | নতুন draft → submit → `POST /purchase-orders/:id/reject`, `{"reason":"Price revision required"}` → `PATCH /purchase-orders/:id` revised lines → submit          | Rejected → edit করে draft → pending approval                        |
| PO cancel           | নতুন draft-এ owner: `POST /purchase-orders/:id/cancel`, `{"reason":"Buyer style cancelled"}`                                                                    | Cancelled; stock receipt নয়                                         |
| Premature close     | Partially received PO close চেষ্টা                                                                                                                              | 409; stock অপরিবর্তিত                                               |
| Overreceive         | Remaining-এর বেশি quantity receive                                                                                                                              | 400/409; extra stock হবে না                                         |
| Wrong line/item     | অন্য PO line বা mismatched item receipt                                                                                                                         | 400; GRN হবে না                                                     |
| Warehouse transfer  | Warehouse staff: `POST /inventory/items/{{testItemId}}/transfer`, `{"fromWarehouseId":"{{warehouseId}}","toWarehouseId":"{{secondWarehouseId}}","quantity":10}` | দুই warehouse-এ -10/+10; মোট120 থাকে; transfer production demand নয় |
| Negative stock      | Available balance-এর বেশি negative adjust                                                                                                                       | 400; balance অপরিবর্তিত                                             |
| Duplicate SKU       | একই SKU দিয়ে নতুন item                                                                                                                                          | 409                                                                 |
| Viewer write        | Viewer login → POST item create                                                                                                                                 | 403; viewer GET পড়তে পারে                                           |
| Missing/invalid JWT | Protected GET-তে No Auth/invalid token                                                                                                                          | 401                                                                 |
| Idempotency         | একই key/body-তে receipt retry; auto-new-key script বন্ধ রাখুন                                                                                                   | একবারের movement; body বদলালে409                                    |
| Atomic bulk import  | `POST /inventory/bulk-import`-এর schema দেখুন; atomic batch-এ একটি invalid row                                                                                  | সব row rollback                                                     |
| Upload              | `POST /uploads`, Body form-data: `kind=pdf`, `file` File type, actual PDF                                                                                       | Uploaded key/URL; download খুলবে                                    |
| Supplier document   | `POST /suppliers/{{supplierId}}/documents`, form-data `kind=cert`, PDF file                                                                                     | Supplier attachment সংরক্ষণ                                         |

Multipart-এ Content-Type নিজে `application/json` দেবেন না; Postman boundary তৈরি করবে। Receipt attachment হলে `file` এবং JSON text **`payload`** form field দিন।

নতুন warehouse/category/supplier পরীক্ষা করতে owner দিয়ে যথাক্রমে `POST /inventory/warehouses`, `/inventory/categories`, `/suppliers` চালান। তাদের নিজস্ব GET/PATCH/DELETE branches catalogue-এ আছে। Core walkthrough-এর ব্যবহৃত supplier/item archive করার আগে dependent test শেষ করুন।

## ১৪. User invitation, password ও notifications

Owner দিয়ে `POST /auth/invite` body `{"email":"manual-user-{{runSuffix}}@garments.example.test","fullName":"Manual Test Viewer","role":"viewer"}`। Captured invitation email-এর token নিয়ে **No Auth** `POST /auth/accept-invite` body `{"token":"<email token>","password":"GarmentsDemo!2026"}`। তারপর নতুন user login করে read access যাচাই করুন।

Forgot/reset test এই নতুন user-এ করুন: No Auth `POST /auth/forgot-password` body `{"email":"<new user email>"}` → captured reset token → `POST /auth/reset-password` body `{"token":"<reset token>","newPassword":"GarmentsDemo!2026New"}` → নতুন password-এ login। মূল owner-এর password বদলালে generated demo credentials আর মিলবে না।

Notification পড়তে `GET /notifications`, `/notifications/unread-count`। নির্দিষ্ট record পড়া হয়েছে করতে `POST /notifications/mark-read` body `{"ids":["<notification id>"]}`। Presentation-এর আগে `{all:true}` পাঠালে unread examples কমে যাবে।

## ১৫. Billing সবশেষে, আলাদা sandbox test

আগে owner login করে `GET /billing/plans`, `/billing/subscription`, `/billing/invoices`। বর্তমান Enterprise presentation configuration synthetic demo setup; real payment নয়।

Manual checkout: `POST /billing/checkout-session`-এ নিচের shape দিন; URL-গুলো আপনার configured return/callback URL দিয়ে বদলান:

```json
{
  "tier": "growth",
  "gateway": "sslcommerz",
  "successUrl": "https://YOUR-PUBLIC-HOST/api/v1/webhooks/sslcommerz",
  "cancelUrl": "https://YOUR-PUBLIC-HOST/api/v1/webhooks/sslcommerz",
  "failUrl": "https://YOUR-PUBLIC-HOST/api/v1/webhooks/sslcommerz",
  "ipnUrl": "https://YOUR-PUBLIC-HOST/api/v1/webhooks/sslcommerz"
}
```

এগুলো placeholder; public host ছাড়া automatic gateway callback আপনার localhost-এ পৌঁছাবে না। Response-এর redirect URL sandbox checkout-এ খুলুন → sandbox payment সম্পন্ন করুন → callback backend গ্রহণ করে gateway validation API দিয়ে যাচাই করবে → invoice/payment/subscription GET দিয়ে final status দেখুন। শুধু checkout URL তৈরি হওয়া payment success নয়; হাতে বানানো `status=VALID` payload-ও payment প্রমাণ নয়।

Local environment-এ ইতিমধ্যে ব্যবহৃত বাস্তব sandbox flow পুনরায় চালানোর নির্ভরযোগ্য পথ: `backend` থেকে `npm run test:payment:sandbox`। এটি sandbox return form local backend-এ forward করে validation করে; ফল `artifacts/sandbox-payment-results.json`। Safe validated payment হলে paid invoice/succeeded attempt দেখুন; gateway risk flag দিলে failure expected। Production settlement এই test নয়।

Billing test-এর পরে presentation plan ফিরিয়ে আনতে `npm run demo:ready`, তারপর owner **আবার login** করুন। এটি শুধু dedicated synthetic demo factory-র configuration; payment হিসেবে উপস্থাপন করবেন না।

## ১৬. Refresh ও logout একেবারে শেষে

Postman cookie jar-এ login-এর `scp_refresh` cookie থাকতে হবে। `POST /auth/refresh`, body `{}`, header `X-CSRF: presentation-csrf-token`। Success হলে নতুন access token save করুন। Refresh token JSON-এ নেই; cookie-তে rotate হয়। পুরোনো refresh reuse করলে session family revoke হতে পারে।

শেষে `POST /auth/logout-everywhere` দিয়ে সব session revoke করুন; আগের Bearer token-এ protected GET 401 হওয়া যাচাই করুন। শুধু `POST /auth/logout` বর্তমান refresh session শেষ করে; সব access token সঙ্গে সঙ্গে invalid হয়েছে ধরে নেবেন না।

## ১৭. কোথায় থামবেন এবং কী ঠিক করবেন

| সমস্যা           | প্রথমে যা দেখবেন                                                              |
| ---------------- | ----------------------------------------------------------------------------- |
| 401              | Token expired/overwritten? সঠিক role login; public supplier endpoint No Auth  |
| 403              | Role permission, CSRF header বা plan entitlement; owner দিয়ে `/auth/me` যাচাই |
| 400              | Response validation detail; ID, signed quantity, ISO date, body field type    |
| 404              | একই tenant-এর সঠিক ID? পুরোনো environment/line ID? report ready হয়েছে?        |
| 409              | GET করে current state; duplicate SKU/key/token বা ইতিমধ্যে সম্পন্ন action     |
| 429              | Error অনুযায়ী minute limit, forecast lock বা quota; অন্ধভাবে retry নয়         |
| Email নেই        | SMTP + worker + latest matching `.eml`; API success delivery completion নয়    |
| PDF নেই          | Chrome/R2/worker log; ready artifact ও fresh signed URL                       |
| AI fallback/null | Provider/quota/provenance; saved result এবং live call আলাদা করে দেখুন         |

শেষের success checklist: readiness OK; correct roles; RFQ দুই offer; AI summary/provenance যাচাই; একটিমাত্র accepted draft থেকে PO closed; দুটি GRN; stock120; downloadable PO ও report PDF; saved AI insight/forecast; expected notification/email; negative tests-এ data অপরিবর্তিত। Transfer optional test চালালে দুই warehouse মিলে মোট120 মিলাবেন।

আগের সংক্ষিপ্ত workflow ও test evidence: [MANUAL-TEST-WORKFLOW.bn.md](MANUAL-TEST-WORKFLOW.bn.md), [backend test report](../backend/TEST-REPORT.md)।
