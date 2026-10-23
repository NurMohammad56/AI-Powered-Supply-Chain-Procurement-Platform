# AI-Powered Supply Chain & Procurement Platform

Express/TypeScript backend with MongoDB tenancy, Redis/BullMQ, garments inventory, supplier RFQs, PO/GRN workflows, AI forecasting, reporting, R2 file storage and SSLCommerz billing.

Requires Node.js 22.12 or newer; verified on Node.js 22.17.

For the prepared Bangladesh garments presentation, follow [the Bengali manual API workflow](postman/MANUAL-TEST-WORKFLOW.bn.md). Import the generated [Postman collection](postman/garments-demo.collection.json) and [environment](postman/garments-demo.environment.json).

From `backend`, `npm run demo:setup` derives `.env.presentation` from the configured `.env`. Run `npm run demo:smtp`, `npm run demo:api` and `npm run demo:worker` in separate terminals. The presentation API runs on port 4001. Atlas data persists; captured email is in `.demo-data/mail`.

`npm run seed:garments` creates a fresh isolated demo factory with a garments catalogue, historical inventory, supplier offers, every PO state and actual AI responses. Run once when new demo data is required. `npm run test:integration` validates the prepared tenant with real HTTP/database/external service calls. `npm run demo:postman` refreshes presentation credentials and IDs.

Build and checks: `npm run typecheck`, `npm run build`, `npm run lint`, `npm test`. Full results and presentation metadata are saved in `backend/artifacts`. Unit-only coverage and instrumented real API coverage are separate checks; see the test report for their actual results and remaining limitations.
