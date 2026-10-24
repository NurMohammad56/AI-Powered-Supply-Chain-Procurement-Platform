# Free trial: সব feature, ১০ seats ও restart API

১৪ দিন trial-এ সব implemented business feature চালু: inventory, supplier/RFQ, PO/GRN, manual ও automatic AI, basic/advanced reports। Owner-সহ **১০টি occupied seat**। Trial-এ platform-এর monthly AI token/forecast/report quota নেই; usage হিসাব রাখা হয়। সাধারণ request rate limit, provider availability, email verification, role permission ও tenant isolation বহাল। Viewer Owner-এর write API ব্যবহার করবেন না।

নতুন registration এবং আগে থেকে থাকা trial—দুটিতেই current policy প্রযোজ্য। পুরোনো trial-এর মেয়াদ নিজে থেকে বাড়বে না; restart API ব্যবহার করলে নতুন ১৪ দিন শুরু হবে। Paid plan-এর price/seats/AI quota বদলায়নি।

## নতুন API

```http
POST /api/v1/billing/trial/restart
Authorization: Bearer <verified-owner-access-token>
Content-Type: application/json
Idempotency-Key: <unique-action-id>
```

Body:

```json
{}
```

নিজের company-এর **verified Owner** এই API ব্যবহার করবেন। কোনো `tenantId`, `days`, `tier` বা date পাঠাবেন না; extra field দিলে 400। Manager/warehouse_staff/viewer পারবেন না। Expired/cancelled account-ও login করে Owner হিসেবে hit করতে পারেন। Suspended company পারবেন না।

Response `data`-র গুরুত্বপূর্ণ fields:

```json
{
  "tier": "trial",
  "status": "trialing",
  "seats": 10,
  "accessMode": "full",
  "trialEndsAt": "<request time + 14 days>",
  "currentPeriodStart": "<request time>",
  "currentPeriodEnd": "<request time + 14 days>",
  "cancelAtPeriodEnd": false,
  "scheduledTier": null,
  "trialRestartCount": 1,
  "lastTrialRestartedAt": "<request time>"
}
```

Request-এর সময় থেকে নতুন ১৪ দিন গণনা হয়, আগের expiry-এর সঙ্গে ১৪ দিন যোগ হয় না। Active trial-ও আবার শুরু করা যায়; আলাদা maximum restart count নেই। একই action retry-তে একই idempotency key/body রাখুন; নতুন key মানে নতুন restart। এটি Owner-কে বারবার free trial নেওয়ার সুবিধা দেয়—এটাই এই API-র বর্তমান policy।

API existing business data, users, invoices, payment history বা recorded AI usage delete করে না। Pending open checkout expire করে; completed checkout confirmation pending থাকলে restart আটকায়। চলমান paid subscription বা provider billing থাকলে **409 `PAID_SUBSCRIPTION_EXISTS`**; আগে প্রয়োজনমতো Stripe subscription cancel করুন। Restart API নিজে provider charge/cancellation করে না। Cancelled paid subscription থেকে restart করা যায়; ১০টির বেশি occupied seat হলে আগে Owner দিয়ে users disable করুন, না হলে **409 `SEAT_LIMIT_REACHED`**।

## Frontend/manual ক্রম

1. Owner login → `GET /auth/access`। Unverified হলে email verify করুন।
2. Owner-এর জন্য “Restart 14-day free trial” action দিন। API request পাঠান `{}` body ও unique idempotency key দিয়ে।
3. Response-এর পরে `GET /auth/access` ও `GET /billing/subscription` re-fetch করুন। Existing JWT-তেই `full`, tier `trial`, seats limit 10 ও নতুন expiry আসবে।
4. `GET /ai/usage` → `unlimited:true`, `cap:{"tokens":null,"forecastCalls":null,"reportCalls":null}`। `null` unlimited বোঝায়; শূন্য হিসেবে দেখাবেন না। Paid plan-এ numeric cap ও `unlimited:false`।
5. Role অনুযায়ী inventory/PO/AI/report workflow চালান। Owner-সহ দশ occupied seat হলে পরের invite 409। Active user ও unexpired pending invite—দুটিই occupied।
6. নতুন ১৪ দিন শেষ হলে read/export mode; Owner আবার restart করতে পারবেন অথবা paid subscription নিতে পারবেন। Starter নিতে চাইলে occupied seats পাঁচের মধ্যে নামাতে হবে।

## Existing API response পরিবর্তন

- `GET /billing/plans`: trial `seatLimit` এখন 10; সব business feature অন্তর্ভুক্ত।
- `GET /auth/access`, `GET /auth/me`: current trial entitlement/seat policy এখন 10।
- `GET /billing/subscription` ও billing mutation responses-এ `trialRestartCount`, `lastTrialRestartedAt` যোগ হয়েছে।
- `GET /ai/usage`: নতুন `unlimited` boolean; trial-এর `cap` values এখন `null`, paid values numeric। Request body বদলায়নি।

Postman-এর generic collection-এ `Restart free trial - Owner` এবং subscription collection-এর optional restart request যোগ আছে। [মূল subscription guide](SUBSCRIPTION-STRIPE-API-CHANGES.bn.md), [frontend authorization](FRONTEND-AUTHORIZATION.bn.md)।

পরীক্ষা: updated real Stripe/API suite **73 checks passed**, unit **117 passed**। Existing trial records-এর raw seats Atlas-এ 10 করা হয়েছে; [migration script](../backend/scripts/migrate-trial-seats.ts) মেয়াদ বাড়ায় না বা paid data বদলায় না। Updated runtime-এ stale cancelled-provider event নতুন trial/expiry অক্ষত রাখার check-ও পাশ করেছে; evidence `backend/artifacts/trial-restart-runtime-results.json`।
