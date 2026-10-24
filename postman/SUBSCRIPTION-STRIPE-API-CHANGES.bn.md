# Subscription ও Stripe: frontend এবং manual API workflow

Latest trial policy: **10 seats, all business features, no trial AI monthly quota**. New Owner-only `POST /billing/trial/restart` with `{}`. [Exact restart body, response and frontend steps](TRIAL-RESTART.bn.md).

আপডেট: 2026-10-24। Base URL: `http://localhost:4001/api/v1`। এটি বর্তমান subscription flow-এর নির্দেশিকা; inventory → RFQ → PO → receipt workflow-এর জন্য [মূল manual guide](START-TO-END-MANUAL.bn.md) দেখুন।

## Policy ও plan

Registration-এ company, প্রথম `owner` এবং **১৪ দিনের trial** একসঙ্গে তৈরি হয়। Trial registration-এর সময় শুরু; email verify করতে দেরি হলে trial আবার শুরু হয় না। Self-service onboarding: trade license/KYC/platform-admin approval নেই। Email verification product use ও checkout-এর জন্য বাধ্যতামূলক; verification করার জন্য আগে login করা যায়। Invite গ্রহণ করলে সেই email verified হয়।

| Plan | মাসিক মূল্য | মোট seats, Owner-সহ | Features |
|---|---:|---:|---|
| trial | $0, ১৪ দিন | 10 | Growth-এর feature preview |
| starter | USD 49 | 5 | Inventory, suppliers/RFQ, PO, basic reports |
| growth | USD 149 | 20 | Starter + AI forecast/AI RFQ comparison + advanced reports |
| enterprise | USD 499 | 100 | বর্তমানে বাস্তবায়িত Growth features, বেশি seats |

Active user এবং মেয়াদ আছে এমন pending invite seat দখল করে। Parallel invite-ও cap অতিক্রম করতে পারে না। Scheduled downgrade/pending lower-plan checkout থাকলে target plan-এর কম seat limit-ও প্রযোজ্য। Target-এর বেশি user থাকলে আগে Owner দিয়ে user disable করুন।

Trial expiry, paid expiry, failed renewal বা cancellation-এ **read_only**: নিজের role-এর অনুমতি অনুযায়ী existing data/report/PDF পড়া বা export করা যাবে। Inventory/PO write, invite, upload, AI generation ও নতুন weekly digest বন্ধ। নতুন export job API যোগ হয়নি; existing GET/report/download APIs ব্যবহার করবেন। Owner billing/renewal এবং user disable করতে পারেন; notification mark-read ও নিজের account maintenance চলে। Suspension business read-ও বন্ধ করে।

## Common headers

Public endpoint ছাড়া `Authorization: Bearer <accessToken>`। JSON body-তে `Content-Type: application/json`। Checkout, change ও cancel-এ unique `Idempotency-Key` দিন; একই action retry করলে একই key/body রাখুন। Secret key/frontend-এ পাঠাবেন না। Normal response-এর ফল `data`-তে; list invoice-এর `data` array ও pagination আলাদা।

## নতুন API

| Method ও path | কে | Body | কী করবেন |
|---|---|---|---|
| `GET /auth/access` | সব authenticated role; unverified/expired-ও | নেই | App bootstrap, verify, payment ও plan change-এর পরে call |
| `POST /auth/resend-verification` | নিজের unverified logged-in account | `{}` | Email পাঠায়; আগের token বাতিল; ৬০ সেকেন্ড cooldown |
| `POST /billing/portal-session` | verified Owner | `{"returnUrl":"http://localhost:3000/settings/billing"}` | `data.redirectUrl` browser-এ খুলে card update, invoices, cancellation |

`GET /auth/access`-এর `data` fields: `role`, `emailVerified`, `accessMode`, `canWrite`, `tier`, `features`, `capabilities`, `seats: {used, limit, planLimit}`, `subscriptionStatus`, `trialEndsAt`, `currentPeriodEnd`। `limit` বর্তমান effective seat cap; `planLimit` বর্তমান plan-এর cap। `canWrite` account eligibility; Viewer-এর write permission তৈরি করে না। Role/capability ও feature-ও মিলাতে হবে।

## Existing API-তে পরিবর্তন

| API | Request body পরিবর্তন | নতুন আচরণ |
|---|---|---|
| `GET /billing/plans` | body নেই | এখন public; `data.plans`, `data.trialDays:14`; canonical USD prices/seats/features |
| `POST /auth/register` | অপরিবর্তিত | Atomic company/Owner/trial creation; verification email queued |
| `POST /auth/login`, `/auth/refresh` | অপরিবর্তিত | Login onboarding-এর জন্য চলে; পরের request-এ DB থেকে current role/plan/expiry যাচাই |
| `POST /auth/verify-email` | `{"token":"<email-token>"}` অপরিবর্তিত | Expiring single-use token; নতুন token DB-তে hash হিসেবে থাকে |
| `GET /auth/me` | নেই | `accessMode`, `canWrite` এবং authoritative tier/features যোগ |
| `POST /auth/invite`, `/auth/accept-invite` | অপরিবর্তিত | Transactional seats, active subscription, single-use acceptance |
| `POST /billing/checkout-session` | নিচে নতুন body | শুধু Stripe; `gateway` optional, দিলে `stripe`; `failUrl`, `ipnUrl` সরানো, পাঠালে validation error |
| `POST /billing/subscription/change` | `{"tier":"growth"}` অপরিবর্তিত | Real Stripe upgrade/proration; downgrade next billing cycle; trial-এ ফেরত যাওয়া যায় না |
| `POST /billing/subscription/cancel` | `{"cancelImmediately":false}` অপরিবর্তিত | `false`: period end; `true`: এখনই paid writes বন্ধ |
| `GET /billing/subscription`, `/billing/invoices` | নেই | Provider-confirmed state, actual invoice/PDF; Owner-only |
| `GET /quotations/:id/compare` | body নেই; নতুন query `includeAi=true` | Default numeric comparison; AI চাইলে explicit query, Owner/Manager + eligible plan |
| `POST /reports/budget` | অপরিবর্তিত | Owner/Manager + advanced reports; Viewer বন্ধ |
| `POST /reports/weekly-digest` | অপরিবর্তিত | Owner/Manager + advanced reports; worker বর্তমান access আবার যাচাই করে |
| `POST /uploads` | multipart অপরিবর্তিত | Owner/Manager/Warehouse staff; Viewer বন্ধ |
| `POST /webhooks/stripe` | frontend request নয় | Raw JSON + valid `Stripe-Signature`; real provider callbacks |
| `POST /webhooks/sslcommerz` | **removed** | SSLCommerz checkout/callback/config সরানো হয়েছে |

Historical SSL-labelled invoices/payment records মুছে ফেলা হয়নি; নতুন payment Stripe-only। অন্য business API-র body এই subscription change-এ বদলায়নি।

Checkout body:

```json
{
  "tier": "starter",
  "gateway": "stripe",
  "successUrl": "http://localhost:3000/settings/billing?checkout=success",
  "cancelUrl": "http://localhost:3000/settings/billing?checkout=cancel"
}
```

`tier`: `starter|growth|enterprise`। Server নিজে price নির্বাচন করে; client থেকে amount/priceId/tenantId গ্রহণ করে না। তিনটি return URL-এর origin অবশ্যই configured `FRONTEND_BASE_URL`-এর সমান হতে হবে। Response `data.redirectUrl`, `data.sessionId`, `data.orderId`। Frontend redirect success-কে payment confirmation ধরবেন না; webhook-পরবর্তী subscription state authoritative।

## শুরু থেকে শেষ: কখন কী hit করবেন

1. **Backend প্রস্তুত:** MongoDB, Redis, API এবং worker চালু করুন। Local demo: backend থেকে `npm run demo:smtp`, `npm run demo:api`, `npm run demo:worker` আলাদা terminal-এ। Local SMTP mail `backend/.demo-data/mail/`-এ থাকে; বাস্তব inbox delivery নয়। Production-এ নিজের SMTP/Resend লাগবে।
2. **Stripe forwarding:** configured test key/signing secret থাকলে backend থেকে `npm run demo:stripe` চালান। প্রথম setup-এ একই test account দিয়ে Stripe CLI `listen --forward-to http://localhost:4001/api/v1/webhooks/stripe` চালিয়ে signing secret ignored `.env.presentation`-এর `STRIPE_WEBHOOK_SECRET`-এ দিন; বদলালে API restart করুন। `STRIPE_SECRET_KEY` backend-only। Hosted production webhook URL HTTPS হতে হবে।
3. **Plan দেখুন:** public `GET /billing/plans`। Price UI hardcode না করে response দেখান।
4. **Register:** `POST /auth/register`, নিচের body। Unique email ব্যবহার করুন। Response-এর factory/Owner ID রাখুন; login token এখানে নেই।

   ```json
   {"factory":{"name":"Dhaka Garments QA","businessType":"rmg","country":"BD","timeZone":"Asia/Dhaka"},"owner":{"fullName":"QA Owner","email":"owner-unique@example.test","password":"GarmentsQA!2026"}}
   ```

5. **Login:** `POST /auth/login` body `{"email":"owner-unique@example.test","password":"GarmentsQA!2026"}`। `data.accessToken` রাখুন। `GET /auth/access` → `verification_required`; inventory write/checkout এখন 403।
6. **Verify:** worker পাঠানো email link থেকে token নিয়ে public `POST /auth/verify-email` body `{"token":"<token>"}`। Mail না এলে authenticated `POST /auth/resend-verification` `{}`; latest link ব্যবহার করুন। `GET /auth/access` → `full`, tier `trial`, seats 10।
7. **Trial business flow:** Warehouse → category → item → opening stock → suppliers → RFQ → supplier response → numeric compare অথবা `?includeAi=true` → accept → PO submit/approve/send/receive/close। Exact bodies [মূল workflow](START-TO-END-MANUAL.bn.md)-এ। Manual forecast Owner/Manager hit করবেন; low-stock/receipt automation worker থেকে চলে, eligible plan/role/quota লাগে। Starter-এ AI হবে না।
8. **Staff:** Owner/Manager `POST /auth/invite` body `{"email":"manager-unique@example.test","fullName":"QA Manager","role":"manager"}`। Email token দিয়ে public `POST /auth/accept-invite` body `{"token":"<invite-token>","password":"GarmentsQA!2026"}`; নতুন user তারপর login করবেন। Trial-এ Owner+আর ৯ occupied seat; পরের invite 409। Owner `DELETE /auth/users/:userId` দিয়ে disable করে seat ছাড়াতে পারেন।
9. **Subscribe:** verified Owner দিয়ে checkout body পাঠান; Starter/Growth/Enterprise একেকটি **fresh company** দিয়ে test করুন। Existing paid subscription থাকলে নতুন checkout নয়, change endpoint ব্যবহার করুন। Response URL browser-এ খুলে Stripe test card `4242 4242 4242 4242`, future expiry, যেকোনো ৩-digit CVC দিন। শুধু test mode-এ এই card।
10. **Webhook checkpoint:** CLI-তে callbacks আসবে। `GET /billing/subscription` এবং `GET /auth/access` poll করুন (যেমন ২ সেকেন্ড interval, ৬০ সেকেন্ড পর্যন্ত)। Selected tier + `active` না হওয়া পর্যন্ত frontend paid success দেখাবে না। `GET /billing/invoices` → paid USD invoice; amount minor units, যেমন 4900 = USD 49। Invoice PDF link থাকতে পারে। একই webhook আবার এলে duplicate billing হয় না।
11. **Feature check:** Starter-এ `GET /ai/usage`/AI generation 403; Growth/Enterprise-এ Owner/Manager চলবে। Viewer generation/budget/upload 403। Same old JWT দিয়েই change দেখা যায়; token tier refresh-এর অপেক্ষা নেই।
12. **Upgrade:** Starter Owner → `POST /billing/subscription/change` `{"tier":"growth"}`। Stripe prorated invoice charge হয়; provider-confirmed payment-এর পর নতুন entitlement। Payment problem হলে portal-এ card ঠিক করে provider invoice pay করুন, তারপর access re-fetch।
13. **Downgrade:** Growth Owner → একই API `{"tier":"starter"}`। Current Growth period শেষ হওয়া পর্যন্ত Growth থাকে; `scheduledTier:starter` দেখায়; target cap এখন থেকেই invite-এ প্রযোজ্য। বেশি seat থাকলে 409; আগে disable করুন। Next renewal payment/webhook-এ Starter ও AI restriction কার্যকর।
14. **Self-service billing:** `POST /billing/portal-session` → URL খুলুন। Card update/invoice history/period-end cancel করুন। Return-এর পরে access/subscription/invoices re-fetch করুন।
15. **Cancel:** `POST /billing/subscription/cancel` `{"cancelImmediately":false}` → current paid period full, পরে read_only। এখনই শেষ করতে `true` দিন; irreversible provider cancellation, আবার subscribe করতে checkout লাগবে।
16. **Failure/expiry:** read_only হলে GET inventory/report/export role অনুযায়ী চলে; POST item/AI/invite/upload 403। Owner portal/payment recovery বা নতুন eligible checkout করতে পারেন। Failed renewal-এর existing Stripe subscription থাকলে portal/recovery ব্যবহার করুন। Payment recovery webhook-এ full ফিরে আসে।
17. **Automated real renewal test:** Local date/DB পাল্টাবেন না। `npm run test:payment:renewals` isolated QA company এবং real Stripe test clock দিয়ে monthly renewal → card failure → recovery → scheduled downgrade → period-end cancellation যাচাই করে। Test records একই configured Atlas-এ আলাদা tenants-এ থাকে।

## Frontend error handling

| Code | করণীয় |
|---|---|
| `EMAIL_VERIFICATION_REQUIRED` | Verify/resend screen |
| `SUBSCRIPTION_READ_ONLY` | Existing data দেখান; writes বন্ধ, Owner-কে renew/recover action |
| `PLAN_FEATURE_UNAVAILABLE` | Upgrade CTA; Viewer-কে Owner-only billing button দেবেন না |
| `SEAT_LIMIT_REACHED` | `details.used/limit` দেখান; Owner disable/upgrade |
| `VERIFICATION_RESEND_COOLDOWN` | Resend countdown |
| `RBAC_CAPABILITY_DENIED` | Role permission অনুযায়ী UI; API error authoritative |
| `SUBSCRIPTION_EXISTS` | Plan change/portal ব্যবহার করুন |
| `CHECKOUT_CONFIRMATION_PENDING` | Existing checkout webhook status অপেক্ষা করুন |
| `BILLING_BUSY` | একই billing action retry করুন |
| `INVALID_RETURN_URL` | Configured frontend origin-এর URL দিন |

## পরীক্ষার প্রমাণ ও সীমা

`backend/artifacts/stripe-subscription-test-results.json`: **73 checks passed**, তিন plan-এর real hosted test Checkout, provider webhooks, DB invoice/payment attempts, expired checkout, seats, verification, role/feature gate, replay ও cancellation। `stripe-renewal-test-results.json`: **22 checks passed**, real Stripe clock renewal/failure/recovery/downgrade/cancellation। `low-stock-test-results.json`: **58 checks passed**, live AI provider, local email capture, stock/RFQ/GRN flow। Updated backend-এর পূর্ণ business regression: **213 passed, 0 failed**। Unit tests: **117 passed**, 3 opt-in integration cases skipped; real suites উপরে আলাদাভাবে চালানো হয়েছে। Test subscriptions শেষে cancel করা হয়েছে; QA data evidence হিসেবে রাখা আছে।

আগের garments presentation company-এর Enterprise access একটি synthetic fixture; সেটিকে real Stripe purchase ধরে দেখাবেন না। Real payment পরীক্ষার company/session/subscription ID উপরের Stripe artifacts-এ আছে। নিজের নতুন company দিয়ে checkout flow চালানোই পরিষ্কার manual test। Database connection বদলানো হয়নি—configured Atlas-এর একই database-এ tenant isolation দিয়ে QA records রাখা হয়েছে।

এগুলো **Stripe test mode**, live-money settlement নয়। Production deployment-এ নিজের live account/key ও public HTTPS webhook configure করে smoke test লাগবে। কোনো secret repository/Postman export-এ রাখা হয়নি। [Stripe test cards](https://docs.stripe.com/testing), [test clocks](https://docs.stripe.com/billing/testing/test-clocks), [subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)।
