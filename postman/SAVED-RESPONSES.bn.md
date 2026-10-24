# Garments Postman: import করলেই response examples

[garments-demo.collection.json](garments-demo.collection.json)-এর **৫৭টি request-এর প্রতিটিতে real response saved example** যোগ করা হয়েছে। Capture: ২৪ অক্টোবর ২০২৬, সকাল ১১:০৭ থেকে, বাংলাদেশ সময়। HTTP status, headers ও পূর্ণ JSON body collection-এর মধ্যেই আছে। এগুলো local presentation API-তে actual request চালিয়ে পাওয়া response; synthetic garments dataset ব্যবহৃত হয়েছে।

## কীভাবে দেখবেন

1. Postman → **Import** → `garments-demo.collection.json` নির্বাচন করুন।
   **Files** দিয়ে file নির্বাচন বা drag-and-drop করুন। Raw text mode-এ দিলে JSON file-এর সম্পূর্ণ content দিন; শুধু Windows file path paste করবেন না। আগে থেকে একই collection থাকলে নিজের প্রয়োজন অনুযায়ী replace/update বেছে নিন।
2. Collection expand করে যেকোনো request-এর নিচের saved example খুলুন। Example-এর নাম `200 OK - real capture ...`, `201 Created ...` বা `202 Accepted ...` ধরনের হবে।
3. Saved example-এ request, response status, headers ও JSON body দেখবেন। দেখতে **API/worker চালু বা Login/Send করার প্রয়োজন নেই**। Saved response নিজে থেকে live response pane-এ execute হয় না—request-এর example নির্বাচন করুন।

এই collection-এ folder অনুযায়ী examples:

- **01 — Login:** login response structure; access token placeholder হিসেবে আছে।
- **02 — Presentation:** inventory, stock, suppliers, PO states, saved AI, reports, notifications, plans ও invoice data।
- **03 — PO workflow:** draft → submit → approve → send → partial/full receive → close, GRN ও PDF URL।
- **04 — RFQ:** create → supplier response → AI comparison → accept/create PO। Supplier token local SMTP invitation থেকে নেওয়া হয়েছিল।
- **05 — AI:** single forecast/cache, batch queue acknowledgement, override ও forecast থেকে PO।
- **06 — Reports:** budget, weekly report queue acknowledgement, ready artifacts ও download URL।

## Live request চালাতে চাইলে

Collection-এর মধ্যে base URL ও demo variables আছে। শুধু collection import করেও Owner Login চালানো যাবে; login ও create requests-এর scripts collection variables update করে। পুরোনো environment নির্বাচন করা থাকলে তার conflicting values সরান অথবা [updated environment](garments-demo.environment.json) import করুন।

Live API base URL `http://localhost:4001/api/v1`। API, worker, Redis, Atlas এবং local SMTP চালু থাকতে হবে। Login → প্রয়োজনের folder ক্রমানুসারে চালান। Mutating folders নতুন PO/RFQ/receipt তৈরি করে; শুধুমাত্র examples দেখতে Collection Runner চালাবেন না।

Saved snapshots-এর ID/date আর এখনকার live data একই থাকবে—এমন নিশ্চয়তা নেই। `Send` দিলে নতুন response আসবে। `202`/batch response কাজ queue হওয়ার acknowledgement; background generation সম্পন্ন হওয়ার response নয়। Live ready PDF পেতে artifacts poll করে download endpoint আবার hit করুন।

## Credentials ও signed URLs

Export-এ active access/refresh token, session cookie এবং supplier invitation token রাখা হয়নি; placeholder ব্যবহার করা হয়েছে। Signed storage URL-এর credentials/signature ঢেকে দেওয়া হয়েছে। Saved URL copy করে download না করে live download endpoint থেকে নতুন URL নিন। Demo login credentials synthetic presentation company-এর; provider secret keys collection-এ নেই।

## আবার capture বা regenerate

Backend থেকে:

```powershell
npm run demo:postman
npm run demo:postman:responses
```

প্রথম command collection regenerate করে এবং existing examples অক্ষত রাখে। দ্বিতীয় command ৫৭টি workflow request নতুন করে চালিয়ে real examples replace করে; এটি demo tenant-এ data লিখবে ও local SMTP/AI/report jobs চালাবে। Capture script শুধু local presentation API, presentation queue prefix এবং local SMTP configuration গ্রহণ করে। ফলাফল [capture report](../backend/artifacts/garments-postman-capture-results.json)-এ আছে।

এই export-এর coverage ওই garments workflow-এর ৫৭টি request। Generic `api.collection.json` ও Stripe subscription collection-এর সব endpoint এতে নতুন করে অন্তর্ভুক্ত করা হয়নি।

Import compatibility: response-এ শুধু saved example-এর প্রয়োজনীয় fields রাখা হয়েছে; optional runtime timing/cookie/preview metadata বাদ দেওয়া হয়েছে। Fix-এর পরে installed Postman Desktop **12.32.3**-এ actual import সফল হয়েছে; ৫৭টি saved body অক্ষত আছে।

[Postman-এর saved examples নির্দেশনা](https://learning.postman.com/docs/use/send-requests/response-data/examples/) · [Manual business workflow](START-TO-END-MANUAL.bn.md)
