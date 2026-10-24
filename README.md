# AI-Powered Supply Chain & Procurement Platform

Express/TypeScript backend with MongoDB tenancy, Redis/BullMQ, garments inventory, supplier RFQs, PO/GRN workflows, AI forecasting, reporting, R2 file storage and Stripe subscriptions.

Subscription integration: [14-day trial, self-service onboarding, new/changed API bodies and manual Stripe workflow](postman/SUBSCRIPTION-STRIPE-API-CHANGES.bn.md). Import [the subscription Postman collection](postman/stripe-subscription.collection.json) with [its environment](postman/stripe-subscription.environment.json). `npm run demo:stripe` forwards real test webhooks to the presentation API; `npm run test:subscriptions` tests all paid plans, and `npm run test:payment:renewals` verifies renewal/failure/recovery using real Stripe test clocks.

Requires Node.js 22.12 or newer; verified on Node.js 22.17.

Free trial: all implemented business features for 14 days, 10 seats, unlimited monthly trial AI quota. Verified Owners can restart using `POST /api/v1/billing/trial/restart` with `{}`; [API and frontend instructions](postman/TRIAL-RESTART.bn.md).

Frontend integration: [role-wise API authorization guide](postman/FRONTEND-AUTHORIZATION.bn.md) covers public endpoints, role permissions, token refresh and action/state checks.

For the prepared Bangladesh garments presentation, follow [the Bengali manual API workflow](postman/MANUAL-TEST-WORKFLOW.bn.md). Import the generated [Postman collection](postman/garments-demo.collection.json) and [environment](postman/garments-demo.environment.json).

From `backend`, `npm run demo:setup` derives `.env.presentation` from the configured `.env`. Run `npm run demo:smtp`, `npm run demo:api` and `npm run demo:worker` in separate terminals. The presentation API runs on port 4001. Atlas data persists; captured email is in `.demo-data/mail`.

`npm run seed:garments` creates a fresh isolated demo factory with a garments catalogue, historical inventory, supplier offers, every PO state and actual AI responses. Run once when new demo data is required. `npm run test:integration` validates the prepared tenant with real HTTP/database/external service calls. `npm run demo:postman` refreshes presentation credentials and IDs.

Build and checks: `npm run typecheck`, `npm run build`, `npm run lint`, `npm test`. Full results and presentation metadata are saved in `backend/artifacts`. Unit-only coverage and instrumented real API coverage are separate checks; see the test report for their actual results and remaining limitations.
