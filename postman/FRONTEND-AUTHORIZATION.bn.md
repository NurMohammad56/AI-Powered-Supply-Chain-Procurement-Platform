# Frontend authorization — role অনুযায়ী সহজ API list

আপডেট: **২৪ অক্টোবর ২০২৬**। নিজের role-এর section দেখলেই কোন API ব্যবহার করা যাবে বোঝা যাবে। প্রতিটি role-এর সঙ্গে নিচের **সবার common API**-ও প্রযোজ্য।

- [Owner](#1-owner): company, users, warehouse, business operations ও billing পরিচালনা।
- [Manager](#2-manager): inventory, supplier, PO, AI/report ও staff invitation পরিচালনা।
- [Warehouse Staff](#3-warehouse-staff): stock movement, goods receipt ও file upload।
- [Viewer](#4-viewer): business data ও reports দেখা/download।
- [সবার common API](#5-common-api): নিজের account ও notifications।
- [Public API](#6-public-api): registration, login, verification ও public plans।
- [Trial/plan ও access rules](#7-access-rules): role permission-এর সঙ্গে যেসব শর্ত মিলবে।
- [Frontend integration](#8-frontend-integration): login, errors, PO states ও request headers।

**Base URL:** `http://localhost:4001/api/v1`। নিচের প্রতিটি path-এর আগে এটি বসবে। `:id`/`:userId`-এর জায়গায় actual response ID দিন। Public API ছাড়া header: `Authorization: Bearer <accessToken>`।

এই তালিকা নিজের company-এর data-র জন্য। Role permission থাকলেও verified email, current subscription/feature এবং resource state-এর শর্ত প্রযোজ্য।

## 1. Owner

Exact role value: `owner`।

Company-র প্রধান account। নিচের সব business API ছাড়াও users, warehouse settings, subscription/payment এবং trial restart পরিচালনা করেন।

Registration প্রথম Owner তৈরি করে। Owner অন্য Owner/Manager/Staff/Viewer invite করতে পারেন। নিজের role বদলানো বা নিজেকে disable করা যায় না; শেষ Owner-কে demote/disable করাও যায় না।

**User management**

```http
GET /auth/users
POST /auth/invite
PATCH /auth/users/:userId/role
DELETE /auth/users/:userId
```

**Inventory ও stock**

```http
GET /inventory/warehouses
POST /inventory/warehouses
GET /inventory/warehouses/:id
PATCH /inventory/warehouses/:id
DELETE /inventory/warehouses/:id
GET /inventory/categories
POST /inventory/categories
GET /inventory/categories/:id
PATCH /inventory/categories/:id
DELETE /inventory/categories/:id
GET /inventory/low-stock
POST /inventory/bulk-import
GET /inventory/items
POST /inventory/items
GET /inventory/items/:id
PATCH /inventory/items/:id
DELETE /inventory/items/:id
POST /inventory/items/:id/adjust
POST /inventory/items/:id/transfer
GET /inventory/items/:id/history
GET /inventory/items/:id/balances
```

**Suppliers, contacts ও documents**

```http
GET /suppliers/compare
GET /suppliers
POST /suppliers
GET /suppliers/:id
PATCH /suppliers/:id
DELETE /suppliers/:id
GET /suppliers/:id/performance
POST /suppliers/:id/contacts
PATCH /suppliers/:id/contacts/:contactIndex
DELETE /suppliers/:id/contacts/:contactIndex
POST /suppliers/:id/documents
DELETE /suppliers/:id/documents/:documentIndex
```

**RFQ / quotations**

```http
GET /quotations
POST /quotations
GET /quotations/:id
POST /quotations/:id/cancel
POST /quotations/:id/accept
GET /quotations/:id/compare
```

AI comparison চাইলে `GET /quotations/:id/compare?includeAi=true` ব্যবহার করুন; default comparison শুধু numeric। AI-এর জন্য eligible plan ও full access লাগবে।

**Purchase orders ও GRN**

```http
GET /purchase-orders
POST /purchase-orders
GET /purchase-orders/:id
PATCH /purchase-orders/:id
POST /purchase-orders/:id/submit
POST /purchase-orders/:id/approve
POST /purchase-orders/:id/reject
POST /purchase-orders/:id/dispatch
POST /purchase-orders/:id/cancel
POST /purchase-orders/:id/close
POST /purchase-orders/:id/receipts
GET /purchase-orders/:id/receipts
POST /purchase-orders/from-forecast
POST /purchase-orders/:id/send
GET /purchase-orders/:id/pdf
```

**AI forecasts ও insights**

```http
GET /ai/insights
GET /ai/forecasts
POST /ai/forecasts
GET /ai/forecasts/:id
GET /ai/forecasts/:id/evaluation
GET /ai/forecasts/:id/visualization
POST /ai/forecasts/:id/override
POST /ai/forecasts/batch
GET /ai/usage
```

এই AI APIs trial/Growth/Enterprise-এ চালু; Starter-এ বন্ধ।

**Reports, budget ও download**

```http
POST /reports/weekly-digest
GET /reports/artifacts
GET /reports/artifacts/:id/download
GET /reports/inventory-turnover
GET /reports/spend-by-supplier
GET /reports/supplier-cost-comparison
GET /reports/cash-flow-projection
GET /reports/dead-stock
GET /reports/abc-analysis
GET /reports/eoq
GET /reports/budget
POST /reports/budget
```

**Billing ও subscription**

```http
GET /billing/subscription
POST /billing/checkout-session
POST /billing/subscription/change
POST /billing/subscription/cancel
GET /billing/invoices
POST /billing/trial/restart
POST /billing/portal-session
```

Billing mutations verified Owner-only। Trial restart-এর body `{}`; active paid subscription থাকলে আগে cancel করতে হবে। [Restart API](TRIAL-RESTART.bn.md) · [Stripe bodies ও workflow](SUBSCRIPTION-STRIPE-API-CHANGES.bn.md)।

**File upload**

```http
POST /uploads
```

## 2. Manager

Exact role value: `manager`।

দৈনন্দিন procurement ও inventory operations পরিচালনা করেন। নিচের API দিয়ে item/category/supplier, RFQ, PO approval, AI, reports ও budget কাজ করবেন।

Manager, Warehouse Staff ও Viewer invite করতে পারেন। **Warehouse create/edit/delete, Owner invite, existing user-এর role change/disable, PO cancel এবং billing/trial restart করতে পারেন না।**

**User management**

```http
GET /auth/users
POST /auth/invite
```

**Inventory ও stock**

```http
GET /inventory/warehouses
GET /inventory/warehouses/:id
GET /inventory/categories
POST /inventory/categories
GET /inventory/categories/:id
PATCH /inventory/categories/:id
DELETE /inventory/categories/:id
GET /inventory/low-stock
POST /inventory/bulk-import
GET /inventory/items
POST /inventory/items
GET /inventory/items/:id
PATCH /inventory/items/:id
DELETE /inventory/items/:id
POST /inventory/items/:id/adjust
POST /inventory/items/:id/transfer
GET /inventory/items/:id/history
GET /inventory/items/:id/balances
```

**Suppliers, contacts ও documents**

```http
GET /suppliers/compare
GET /suppliers
POST /suppliers
GET /suppliers/:id
PATCH /suppliers/:id
DELETE /suppliers/:id
GET /suppliers/:id/performance
POST /suppliers/:id/contacts
PATCH /suppliers/:id/contacts/:contactIndex
DELETE /suppliers/:id/contacts/:contactIndex
POST /suppliers/:id/documents
DELETE /suppliers/:id/documents/:documentIndex
```

**RFQ / quotations**

```http
GET /quotations
POST /quotations
GET /quotations/:id
POST /quotations/:id/cancel
POST /quotations/:id/accept
GET /quotations/:id/compare
```

AI comparison চাইলে `GET /quotations/:id/compare?includeAi=true` ব্যবহার করুন; default comparison শুধু numeric। AI-এর জন্য eligible plan ও full access লাগবে।

**Purchase orders ও GRN**

```http
GET /purchase-orders
POST /purchase-orders
GET /purchase-orders/:id
PATCH /purchase-orders/:id
POST /purchase-orders/:id/submit
POST /purchase-orders/:id/approve
POST /purchase-orders/:id/reject
POST /purchase-orders/:id/dispatch
POST /purchase-orders/:id/close
POST /purchase-orders/:id/receipts
GET /purchase-orders/:id/receipts
POST /purchase-orders/from-forecast
POST /purchase-orders/:id/send
GET /purchase-orders/:id/pdf
```

**AI forecasts ও insights**

```http
GET /ai/insights
GET /ai/forecasts
POST /ai/forecasts
GET /ai/forecasts/:id
GET /ai/forecasts/:id/evaluation
GET /ai/forecasts/:id/visualization
POST /ai/forecasts/:id/override
POST /ai/forecasts/batch
GET /ai/usage
```

এই AI APIs trial/Growth/Enterprise-এ চালু; Starter-এ বন্ধ।

**Reports, budget ও download**

```http
POST /reports/weekly-digest
GET /reports/artifacts
GET /reports/artifacts/:id/download
GET /reports/inventory-turnover
GET /reports/spend-by-supplier
GET /reports/supplier-cost-comparison
GET /reports/cash-flow-projection
GET /reports/dead-stock
GET /reports/abc-analysis
GET /reports/eoq
GET /reports/budget
POST /reports/budget
```

**File upload**

```http
POST /uploads
```

## 3. Warehouse Staff

Exact role value: `warehouse_staff`।

Stock দেখা, stock adjust/transfer, PO-র goods receive/GRN এবং file upload করেন। Supplier ও quotation-এর তথ্য পড়তে পারেন।

**Item/category/supplier create/edit, RFQ send/accept, PO create/approve/cancel, manual AI, report API, user management ও billing করতে পারেন না।** Receipt-এর পরে eligible automatic AI job চললে সেটি system worker-এর কাজ; Staff-কে manual AI permission দেয় না।

**Inventory ও stock**

```http
GET /inventory/warehouses
GET /inventory/warehouses/:id
GET /inventory/categories
GET /inventory/categories/:id
GET /inventory/low-stock
GET /inventory/items
GET /inventory/items/:id
POST /inventory/items/:id/adjust
POST /inventory/items/:id/transfer
GET /inventory/items/:id/history
GET /inventory/items/:id/balances
```

**Suppliers, contacts ও documents**

```http
GET /suppliers/compare
GET /suppliers
GET /suppliers/:id
GET /suppliers/:id/performance
```

**RFQ / quotations**

```http
GET /quotations
GET /quotations/:id
GET /quotations/:id/compare
```

Comparison শুধু numeric; `includeAi=true` পাঠাবেন না।

**Purchase orders ও GRN**

```http
GET /purchase-orders
GET /purchase-orders/:id
POST /purchase-orders/:id/receipts
GET /purchase-orders/:id/receipts
GET /purchase-orders/:id/pdf
```

**File upload**

```http
POST /uploads
```

## 4. Viewer

Exact role value: `viewer`।

Inventory, supplier, quotation, PO এবং report দেখেন। PO PDF ও ready report download করতে পারেন।

**Business data create/edit/delete, stock movement, goods receive, upload, AI generation, budget update, digest trigger, user management ও billing করতে পারেন না।** নিজের profile/password ও notification read status common API দিয়ে বদলাতে পারেন।

**Inventory ও stock**

```http
GET /inventory/warehouses
GET /inventory/warehouses/:id
GET /inventory/categories
GET /inventory/categories/:id
GET /inventory/low-stock
GET /inventory/items
GET /inventory/items/:id
GET /inventory/items/:id/history
GET /inventory/items/:id/balances
```

**Suppliers, contacts ও documents**

```http
GET /suppliers/compare
GET /suppliers
GET /suppliers/:id
GET /suppliers/:id/performance
```

**RFQ / quotations**

```http
GET /quotations
GET /quotations/:id
GET /quotations/:id/compare
```

Comparison শুধু numeric; `includeAi=true` পাঠাবেন না।

**Purchase orders ও GRN**

```http
GET /purchase-orders
GET /purchase-orders/:id
GET /purchase-orders/:id/receipts
GET /purchase-orders/:id/pdf
```

**Reports, budget ও download**

```http
GET /reports/artifacts
GET /reports/artifacts/:id/download
GET /reports/inventory-turnover
GET /reports/spend-by-supplier
GET /reports/supplier-cost-comparison
GET /reports/cash-flow-projection
GET /reports/dead-stock
GET /reports/abc-analysis
GET /reports/eoq
GET /reports/budget
```

## 5. Common API

**Owner, Manager, Warehouse Staff ও Viewer—চার role-ই ব্যবহার করবেন।** এগুলো প্রত্যেক role-এর উপরের list-এর অতিরিক্ত।

**নিজের account**

```http
GET   /auth/me
GET   /auth/access
PATCH /auth/me
POST  /auth/change-password
POST  /auth/resend-verification
POST  /auth/logout-everywhere
```

`/auth/me` নিজের profile; `/auth/access` বর্তমান role, feature, access mode ও seat information দেয়। Resend verification-এর body `{}`; ৬০ সেকেন্ড cooldown আছে।

**নিজের notifications**

```http
GET  /notifications
GET  /notifications/unread-count
POST /notifications/mark-read
```

Unverified account-এ profile/access/password/verification/session management চলে; business ও notifications-এর আগে email verify করুন। Expired subscription-এও account maintenance ও notification mark-read করা যায়।

## 6. Public API

Bearer token লাগে না। Refresh-এর জন্য cookie, verification/invite-এর জন্য email token এবং supplier response-এর জন্য invitation token লাগে।

**Registration, login ও account recovery**

```http
POST /auth/register
POST /auth/login
POST /auth/refresh
POST /auth/logout
POST /auth/forgot-password
POST /auth/reset-password
POST /auth/verify-email
POST /auth/accept-invite
```

Registration response-এ login token নেই; পরে login করুন। Invite acceptance-এ user নতুন role বেছে নেন না—inviter-এর দেওয়া role পান।

**Public plans ও supplier response**

```http
GET  /billing/plans
POST /public/quotations/responses/:token
```

Supplier response দিতে platform user account লাগে না; valid unused/unexpired response token এবং company-র active subscription লাগে।

**Stripe callback—frontend থেকে hit করবেন না**

```http
POST /webhooks/stripe
```

এটি raw body ও valid `Stripe-Signature` দিয়ে Stripe call করে। Checkout success page-কে payment confirmation ধরবেন না; subscription/access re-fetch করুন।

Health endpoints API base-এর বাইরে: `GET http://localhost:4001/healthz`, `GET http://localhost:4001/readyz`।

## 7. Access rules

### Frontend প্রথমে কী দেখবে

Login-এর পরে `GET /auth/access` করুন। Backend current database role/subscription যাচাই করে; পুরোনো JWT-এর tier ধরে UI চালাবেন না।

- `verification_required`: verify/resend screen দেখান; business access ও checkout বন্ধ।
- `full`: উপরের role list এবং plan feature মিলে action চালু করুন। `canWrite:true` একা Viewer-কে business write permission দেয় না।
- `read_only`: নিজের role-এর existing GET data/report/PDF/export চলবে; stock/PO write, invite, upload, AI generation ও নতুন digest বন্ধ। Owner billing/renew/trial restart এবং user disable করতে পারেন। Account maintenance/mark-read চলে।
- `suspended`: business access বন্ধ; account/support state দেখান। Trial restart দিয়ে suspension সরানো যায় না।

Verification, payment, plan change ও trial restart-এর পরে `/auth/access` এবং সংশ্লিষ্ট subscription data আবার fetch করুন। Backend নতুন entitlement একই JWT-তেই দেখতে পায়।

### Trial ও paid plan

- **Trial:** ১৪ দিন, Owner-সহ ১০ seats, সব implemented business feature; monthly AI quota নেই। Rate limits, role permission ও provider availability বহাল।
- **Starter:** USD49/month, ৫ seats; inventory, suppliers/RFQ, PO ও basic reports।
- **Growth:** USD149/month, ২০ seats; Starter-এর সঙ্গে AI ও advanced reports।
- **Enterprise:** USD499/month, ১০০ seats; বর্তমানে Growth-এর implemented features, বেশি seats ও AI quota।

Trial/Growth/Enterprise-এ advanced report APIs: cash-flow projection, ABC analysis, EOQ, budget ও weekly digest। Basic report APIs: inventory turnover, spend by supplier, supplier cost comparison, dead stock ও ready report artifacts/download। Report পড়ার role permission Warehouse Staff-এর নেই।

Active users এবং মেয়াদ আছে এমন pending invites seat দখল করে। UI-তে `seats.used` ও `seats.limit` দেখান; scheduled downgrade/pending checkout-এ effective limit কমতে পারে।

`GET /ai/usage`-এ trial-এর `unlimited:true` ও `cap`-এর values `null`; UI-তে Unlimited দেখাবেন। Paid plan-এ numeric cap ও `unlimited:false`।

### User management-এর body

Owner/Manager invite:

```http
POST /auth/invite
```

```json
{"email":"staff@example.com","fullName":"Store Officer","role":"warehouse_staff"}
```

শুধু Owner role change:

```http
PATCH /auth/users/:userId/role
```

```json
{"role":"manager"}
```

`DELETE /auth/users/:userId` user disable করে। Role change/disable-এর পরে target-এর পুরোনো access token revoke হয়; role change-এর পরে নতুন session/token নিতে হবে।

## 8. Frontend integration

### Login ও refresh

1. Login-এ `credentials:'include'` দিন। `data.accessToken` রাখুন; role জানতে `data.user.role` এবং বর্তমান permissions জানতে `/auth/access` পড়ুন।
2. Refresh token HttpOnly `scp_refresh` cookie-তে থাকে; JSON response বা JavaScript দিয়ে খুঁজবেন না।
3. Reload-এ refresh → নতুন access token → `/auth/me` ও `/auth/access` দিয়ে session bootstrap করুন।
4. Refresh-এ `credentials:'include'`, `X-CSRF` header দিন; readable `scp_csrf` cookie-এর value ব্যবহার করুন। বর্তমান middleware header-এর presence/কমপক্ষে ৮ character দেখে; cookie equality যাচাই করে না।
5. একসঙ্গে কয়েকটি 401 হলে একটি shared refresh request চালান। সফল হলে original request একবার retry; ব্যর্থ হলে login-এ নিন। Login-এর invalid password-এ refresh loop করবেন না।
6. Logout-এ token/user ও tenant cache clear করুন। `/auth/logout` current session; `/auth/logout-everywhere` সব session শেষ করে।

Login ও refresh—দুটিতেই নতুন access token `data.accessToken`। Refresh response-এ user/factory নেই। Deployed frontend-এ CORS, HTTPS এবং cookie domain/SameSite-ও ঠিক থাকতে হবে।

### PO button কখন দেখাবেন

- **Edit:** Owner/Manager; `draft` বা `rejected`। Rejected PO edit করলে draft হয়।
- **Submit:** Owner/Manager; `draft`।
- **Approve/Reject:** Owner/Manager; `pending_approval`।
- **Send:** Owner/Manager; `approved`; canonical endpoint `POST /purchase-orders/:id/send`। `/dispatch` route-ও আছে।
- **Receive/GRN:** Owner/Manager/Warehouse Staff; `sent` বা `partially_received`; remaining quantity-এর মধ্যে।
- **Close:** Owner/Manager; `fully_received`।
- **Cancel:** শুধু Owner; `draft`, `pending_approval`, `approved`, `sent` বা `partially_received`।

সব mutation-এ full account access-ও লাগবে। Backend আলাদা requester/approver বাধ্যতামূলক করে না। RFQ accept-এর response-এ `data.purchaseOrder` থাকলে সেই PO চালান; আবার create করে duplicate order করবেন না।

### Error হলে কী করবেন

- **400:** body/query/business validation দেখান।
- **401:** protected request-এ একবার refresh; ব্যর্থ হলে login।
- **403:** response code দেখুন—verification screen, read-only state, upgrade CTA বা role restriction দেখান। Refresh loop নয়।
- **409:** seat limit, paid subscription, duplicate action বা changed state-এর message দেখান; প্রয়োজনমতো latest data reload করুন।
- **413/415:** body/file size বা content type ঠিক করুন।
- **429:** retry timing মেনে অপেক্ষা করুন।

### Idempotency-Key

নিচের mutation-এ একটি logical action-এর জন্য unique `Idempotency-Key` পাঠান। Timeout retry-তে একই key ও body রাখুন; নতুন action-এ নতুন key।

```http
POST /inventory/warehouses
POST /inventory/categories
POST /inventory/bulk-import
POST /inventory/items
POST /inventory/items/:id/adjust
POST /inventory/items/:id/transfer
POST /suppliers
POST /quotations
POST /quotations/:id/accept
POST /purchase-orders
POST /purchase-orders/:id/submit
POST /purchase-orders/:id/approve
POST /purchase-orders/:id/reject
POST /purchase-orders/:id/dispatch
POST /purchase-orders/:id/cancel
POST /purchase-orders/:id/close
POST /purchase-orders/:id/receipts
POST /purchase-orders/from-forecast
POST /purchase-orders/:id/send
POST /ai/forecasts
POST /ai/forecasts/batch
POST /billing/checkout-session
POST /billing/subscription/change
POST /billing/subscription/cancel
POST /billing/trial/restart
```

### আরও নির্দেশিকা

- [Trial restart: exact body/response ও manual flow](TRIAL-RESTART.bn.md)
- [Stripe onboarding ও নতুন/পরিবর্তিত API bodies](SUBSCRIPTION-STRIPE-API-CHANGES.bn.md)
- [Start-to-end business workflow](START-TO-END-MANUAL.bn.md)
- [সব mounted API](API-ENDPOINT-CATALOG.md)
- [Backend role permissions](../backend/src/shared/auth/rbac.ts)
- [Current account/plan gate](../backend/src/shared/middleware/accountAccess.ts)

UI button hide করা server authorization-এর বিকল্প নয়। Backend response authoritative। সব request নিজের token-এর tenant ব্যবহার করে; body দিয়ে অন্য company বেছে নেওয়া যায় না।
