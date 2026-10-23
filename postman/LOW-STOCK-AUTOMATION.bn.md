# Low-stock alert ও automatic AI

## কখন low stock

প্রতিটি item-এর `reorderLevel` আলাদা। Warehouse balance-এ override থাকলে সেটি অগ্রাধিকার পায়। **Quantity < threshold** হলে low stock; সমান বা বেশি হলে healthy। Threshold **0** হলে সেই balance-এর low-stock alert বন্ধ। Reserved quantity বাদ দিয়ে নয়, বর্তমান physical `quantity` দিয়ে এই তুলনা হয়।

Stock adjustment, production consumption, transfer-এর দুই warehouse, goods receipt এবং bulk opening balance-এ marker update হয়। Item-এর reorder level edit করলেও balance পুনরায় যাচাই হয়। Archived item-এর active alert clear হয়।

## কী automatic হয়

1. Stock change-এর transaction-এই `lowStockSince` set হয়; low-stock API-তে সঙ্গে সঙ্গে দেখা যায়।
2. Worker সাধারণত প্রতি **৬০ সেকেন্ডে** pending alert ও পুরোনো balance reconcile করে।
3. Active **Owner, Manager ও Warehouse staff**-কে preference অনুযায়ী in-app notification/email দেওয়া হয়; Viewer-কে দেওয়া হয় না।
4. একই item/warehouse low অবস্থায় থাকলে এক episode-এ একবার alert; repeated consumption/worker retry নতুন alert তৈরি করে না।
5. Stock threshold-এ ফিরলে episode clear এবং আগের notification-এর `metadata.resolvedAt` set হয়। পরে আবার কমলে নতুন episode ও alert হয়।
6. Low item-এর 30-day forecast queue হয়; recent ৬ ঘণ্টার forecast থাকলে নতুন job skip হয়। Low থাকা অবস্থায় automatic recheck default **২৪ ঘণ্টা** পরে; provider cache ও quota বহাল থাকে।
7. Quota না থাকলেও stock alert যায়; AI attempt ৬ ঘণ্টা পিছোয়। Automatic forecast queue সর্বোচ্চ ১০টি item job/minute/tenant।

Forecast job বা low-stock email পাঠানোর আগে episode ইতিমধ্যে resolve হয়ে থাকলে পুরোনো queued কাজ skip হয়। Redis/API/worker বন্ধের সময় pending marker DB-তে থাকে; worker আবার চালু হলে retry করে। এটি SMTP provider-এর প্রতিটি crash অবস্থায় exactly-once delivery-এর নিশ্চয়তা নয়।

Single automatic forecast-এর আলাদা completion email নেই; **low-stock alert email** আছে। Batch forecast-এর summary email এবং weekly report-এর email আলাদা। Automatic forecast থেকে নিজে PO approve/send হয় না।

## Postman-এ পরীক্ষা

Existing demo item না বদলে নতুন item নিন; `reorderLevel=100` রাখুন। Owner setup করবেন; warehouse staff movement করতে পারবেন।

| ধাপ | API / action                                                                                                | Expected                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| ১   | `POST /inventory/items/:id/adjust`, `{ "warehouseId":"<id>", "quantityDelta":200, "reasonCode":"opening" }` | Stock200, healthy                                                        |
| ২   | একই API, নতুন idempotency key; delta `-180`, reason `production_consume`                                    | Stock20, low                                                             |
| ৩   | `GET /inventory/low-stock`                                                                                  | Item সঙ্গে সঙ্গে দেখা যায়                                                |
| ৪   | Worker চালু রেখে এক monitor interval অপেক্ষা; Owner login → `GET /notifications?category=low_stock`         | Low-stock notification; SMTP capture-এ email                             |
| ৫   | `GET /ai/forecasts?itemId=<id>`                                                                             | Background result তৈরি হলে দেখা যায়; `provenance.fallback` যাচাই করুন    |
| ৬   | আরেকবার delta `-1`; interval অপেক্ষা                                                                        | Stock19; একই episode-এ নতুন email/notification নয়                        |
| ৭   | Delta `+81`, reason `count_correction` অথবা বাস্তব PO GRN                                                   | Stock100; marker clear, আগের notification resolved                       |
| ৮   | Delta `-1`, reason `production_consume`                                                                     | Stock99; নতুন episode, নতুন alert; recent AI থাকলে নতুন provider call নয় |

প্রতিটি নতুন movement-এ নতুন idempotency key; timeout retry-তে আগের একই key ও body রাখবেন। API, worker, MongoDB, Redis এবং SMTP প্রয়োজন। Live AI-এর জন্য configured provider key ও quota লাগবে। Presentation email external inbox-এ না গিয়ে `backend/.demo-data/mail/*.eml`-এ জমে।

## Configuration

```dotenv
LOW_STOCK_MONITOR_ENABLED=true
LOW_STOCK_MONITOR_INTERVAL_MS=60000
LOW_STOCK_AI_ENABLED=true
LOW_STOCK_AI_INTERVAL_HOURS=24
LOW_STOCK_MONITOR_TENANT_IDS=
```

Empty tenant list হলে active/trial factory-গুলো monitor হয়। Dedicated presentation worker-এ শুধু demo tenant ID দেওয়া যায়। AI interval minimum৬ ঘণ্টা। Configuration বদলালে worker restart করুন। Fresh worker deployment পুরোনো inconsistent marker-ও repair করে; schema change additive, data delete করে না।

Real test command: `npm run test:low-stock` (`backend` directory)। এটি নতুন synthetic QA factory, আলাদা Redis queue prefix, actual Atlas, localhost SMTP, provider AI এবং PO/GRN ব্যবহার করে। SMTP port2525 খালি রাখতে হবে; existing demo SMTP process বন্ধ থাকলে test চালান। ফল: `backend/artifacts/low-stock-test-results.json`।
