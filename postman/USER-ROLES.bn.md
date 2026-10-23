# User role: কীভাবে তৈরি হয় ও কার কী কাজ

এই backend-এ চারটি role আছে: `owner`, `manager`, `warehouse_staff`, `viewer`। প্রত্যেক user একটি factory/tenant-এর অধীনে কাজ করে। সব API path-এর আগে আপনার `baseUrl` বসাবেন, যেমন `http://localhost:4001/api/v1`।

## Role কীভাবে তৈরি হয়

**১. প্রথম Owner:** `POST /auth/register` করলে নতুন factory এবং তার প্রথম `owner` একসঙ্গে তৈরি হয়। Registration body-তে role দিতে হয় না; backend নিজে owner নির্ধারণ করে।

```json
{
  "factory": {
    "name": "Example Garments Ltd",
    "businessType": "rmg",
    "country": "BD",
    "timeZone": "Asia/Dhaka"
  },
  "owner": {
    "fullName": "Factory Owner",
    "email": "owner@example.com",
    "password": "ExampleOwner!2026"
  }
}
```

Register-এর পরে `POST /auth/login` করতে হবে। Existing factory-তে নতুন staff যোগ করতে আবার register করবেন না; invitation ব্যবহার করবেন।

**২. অন্য user:** Owner বা Manager login করে Bearer token দিয়ে `POST /auth/invite` করবেন:

```json
{
  "email": "store@example.com",
  "fullName": "Store Officer",
  "role": "warehouse_staff"
}
```

- **Owner** চারটি role-এই invite করতে পারেন; অতিরিক্ত Owner-ও তৈরি করতে পারেন।
- **Manager** শুধু `manager`, `warehouse_staff`, `viewer` invite করতে পারেন।
- Warehouse staff ও Viewer কাউকে invite করতে পারেন না।

**৩. Invitation গ্রহণ:** নতুন user প্রথমে `invited` অবস্থায় থাকে। Email-এর token নিয়ে **Bearer token ছাড়া** `POST /auth/accept-invite` করবেন:

```json
{ "token": "<invitation email-এর token>", "password": "ExampleStaff!2026" }
```

এতে user active হয় এবং নিজের password সেট করে। এরপর `/auth/login` দিয়ে কাজ করতে পারবেন। Presentation setup-এ invitation email `backend/.demo-data/mail/*.eml`-এ পাওয়া যায়; email পাঠাতে worker ও SMTP চালু থাকতে হবে।

## কোন role-এর কী কাজ

| Role                | করতে পারেন                                                                                                                                                                                           | প্রধান সীমাবদ্ধতা                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Owner**           | Inventory, warehouse, supplier ও RFQ manage; PO create/edit/submit/approve/reject/send/receive/cancel; AI forecast ও override; reports; user invite/role change/disable; billing/subscription manage | কাজ নিজের factory-র মধ্যে; PO state, validation ও plan/quota-এর নিয়ম প্রযোজ্য                                                  |
| **Manager**         | Item ও supplier manage; stock adjustment/transfer; RFQ; PO create/edit/submit/approve/reject/send/receive; AI forecast/override; reports; staff invite                                               | PO cancel, warehouse manage, existing user-এর role change/disable এবং billing manage করতে পারেন না; Owner invite করতে পারেন না |
| **Warehouse staff** | Inventory, supplier ও PO দেখতে পারেন; stock adjustment/transfer এবং PO goods receive/GRN করতে পারেন                                                                                                  | Item master create/edit, PO create/approve/send/cancel, AI forecast, reports ও user management করতে পারেন না                   |
| **Viewer**          | Inventory, supplier, PO ও reports দেখতে পারেন; অনুমোদিত report export করতে পারেন                                                                                                                     | Stock বা procurement data বদলাতে, goods receive করতে, AI forecast চালাতে বা user manage করতে পারেন না                          |

এগুলো বর্তমান backend-এর permission। যেমন Manager-এর approval permission আছে; শুধু Owner-ই approve করতে পারবেন—এমন বাধ্যবাধকতা নেই। Permission থাকলেও invalid PO state-এ action করা যাবে না।

## পরে role বদলানো বা account বন্ধ করা

**শুধু Owner**, Bearer token দিয়ে:

- Role change: `PATCH /auth/users/:userId/role`, body `{"role":"manager"}`।
- Account disable: `DELETE /auth/users/:userId`। এটি account disable করে।

নিজের role বদলানো বা নিজের account disable করা যায় না। Factory-র শেষ Owner-কে demote/disable করা যায় না। Role বদলালে পুরোনো access token বাতিল হয়; নতুন role পেতে আবার login করবেন।

## Garments factory-তে সাধারণ কাজের ক্রম

**Owner setup ও staff invite → Manager RFQ/PO তৈরি ও submit → Owner বা Manager approve → Manager supplier-কে send → Warehouse staff goods receive → Manager/Owner PO close → Viewer reports দেখে।**

Source: [permission matrix](../backend/src/shared/auth/rbac.ts), [auth routes](../backend/src/modules/auth/auth.routes.ts), [user creation ও role rules](../backend/src/modules/auth/auth.service.ts)।
