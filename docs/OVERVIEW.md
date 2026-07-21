# What this system is, and why it exists

> A plain-language overview for understanding the **purpose** of the platform: what
> problem it solves, who it's for, and why each part is needed.

If you want to know _how_ the code is built, read [ARCHITECTURE.md](./ARCHITECTURE.md).
This document answers the question **"what is this and why does it need to exist?"**
before any code.

---

## 1. The one-sentence answer

**This is a software platform that helps a factory manage everything it buys and
stocks — and uses AI to predict what it will need next, so it never runs out of
materials and never wastes money over-ordering.**

The full name spells out the three pillars:

- **Supply Chain** — tracking the materials/goods a factory holds (inventory).
- **Procurement** — the process of buying those goods from suppliers (quotes →
  purchase orders → delivery).
- **AI-Powered** — instead of a human guessing how much to order, the system
  forecasts demand and writes plain-English business reports automatically.

---

## 2. The real-world problem it solves

Imagine a mid-sized factory — say, a textile manufacturer.

### Before a system like this (the pain)

A factory like this runs procurement on **spreadsheets, email, WhatsApp, and gut
feeling**. The day-to-day reality:

1. **They don't know how much stock they really have.** Numbers live in different
   spreadsheets that don't agree. Someone has to walk the warehouse to be sure.
2. **They run out of materials at the worst time.** Nobody noticed cotton was running
   low until the production line stopped. Now they pay rush shipping and lose a day.
3. **They over-order "just to be safe."** Cash gets tied up in shelves full of stock
   that sits for months. That's money they can't use elsewhere.
4. **Buying from suppliers is chaotic.** Quotes arrive by email, get compared by hand,
   and there's no record of who approved a $50,000 purchase order or why.
5. **Nobody can answer "how are we doing?"** Putting together a weekly summary means a
   manager spending hours pulling numbers from five places.
6. **No memory.** When something goes wrong, there's no reliable trail of who did what
   and when.

Each of these is a real cost: stopped production, wasted cash, slow decisions, and no
accountability.

### What the platform does about it

The system replaces all of that with **one source of truth plus AI assistance**:

| The old pain                | What the platform gives instead                               |
| --------------------------- | ------------------------------------------------------------- |
| Stock numbers nobody trusts | A single, live, accurate inventory ledger                     |
| Surprise st-outs            | AI demand forecasts + automatic low-stock alerts              |
| Over-ordering / dead cash   | Predicted reorder points, so you buy _enough_, not _too much_ |
| Messy supplier buying       | Structured quotes → comparison → purchase orders → receipts   |
| Hours spent on reports      | A weekly AI-written executive briefing, emailed automatically |
| No accountability           | Every important action recorded in an audit trail             |

---

## 3. Who uses it

It's a **multi-tenant SaaS** — meaning many separate factories ("tenants") use the
same software, but each one's data is completely walled off from the others. A factory
signs up, gets its own private workspace, and invites its team.

Inside one factory, people have **roles** with different permissions:

- **Owner** — full control; sees the money, approves big decisions.
- **Manager** — runs day-to-day procurement; approves purchase orders.
- **Staff / Operator** — records stock movements, raises requests.

The system enforces these roles so, for example, a warehouse operator can record a
delivery but can't approve a $100,000 purchase order.

---

## 4. What the system actually does — the eight building blocks

The platform is organized into business areas (the code calls them "modules"). Here's
what each one is _for_, in plain terms:

### 4.1 Auth — "who are you and what are you allowed to do"

Sign-up, login, passwords, sessions, and the role/permission system. This is the front
door and the security guard. It's what guarantees Factory A can never see Factory B's
data.

### 4.2 Inventory — "what do we have, and where"

The live record of every material/product, how much is in stock, in which warehouse,
and every movement in and out. This is the **source of truth** the whole rest of the
system relies on. When stock drops too low, it raises an alert.

### 4.3 Supplier — "who do we buy from, and who's offering the best deal"

Supplier records, and the **Request-for-Quote** flow: ask several suppliers for prices,
collect their responses, and compare them. The system ranks the offers by real numbers
(total cost, lead time) and the AI writes a short summary explaining the trade-offs —
**but a human still chooses.**

### 4.4 PO (Purchase Orders) — "the actual buying"

The formal buying process with a strict lifecycle: draft → submitted → approved → sent
to supplier → goods received → closed. Each step has the right checks (e.g. approval
required) and side effects (e.g. a PDF order is generated and emailed to the supplier;
when goods arrive, inventory is automatically updated).

### 4.5 AI — "the prediction and narration brain"

The differentiating feature. It does demand **forecasting** (how much of each item
you'll need over the next 30/60/90 days, plus a suggested reorder point) and
**narration** (writing plain-English summaries of quotes and weekly performance). It's
careful about cost — every factory has an AI usage quota tied to its subscription.

### 4.6 Reports (rpt) — "how are we doing"

Analytics: inventory turnover, spend, cash flow, on-time delivery rates. Plus the
flagship **weekly digest** — a PDF executive briefing the AI writes and emails to the
owner every week.

### 4.7 Notification — "tell me when something matters"

Alerts and messages: low stock, a PO needs approval, a delivery is overdue. Delivered
in the app and by email.

### 4.8 Billing — "subscriptions and limits"

Which plan a factory is on (trial / paid tiers), how many seats they have, and the AI
usage caps that come with each tier. This is what makes it a real product, not just a
tool.

---

## 5. Why the AI is the point (not just a feature)

You could build inventory + procurement software without AI. Plenty exist. The reason
AI is at the center here:

- **Forecasting is a genuinely hard human task.** Predicting "how much cotton will we
  use next month" requires spotting trends, seasonality, and volatility in months of
  data. People do it badly and slowly. The AI does it in seconds, per item, across the
  whole catalogue.
- **It turns data into decisions.** A reorder-point suggestion tells you _what to do_,
  not just _what happened_. That's the leap from a record-keeping tool to a
  decision-support tool.
- **It removes busywork.** The weekly report that took a manager half a day now writes
  itself.

Crucially, the system is **honest about AI's role**. For decisions involving money
(like choosing a supplier), the AI explains the options but the _numbers_ are
deterministic and a _human_ decides. The AI advises; it doesn't quietly take over.

There are also serious guardrails because LLMs are slow, flaky, and cost money:

- If the primary AI provider fails, it falls back to a second, then to a plain
  mathematical baseline — so a forecast always comes back.
- Results are cached and rate-limited, so the same forecast isn't paid for twice.
- Every factory has a monthly AI budget tied to its plan.

---

## 6. Why it's built the way it is (the "why it needs that" part)

A few design choices exist purely to make the product _trustworthy_ and _reliable_ —
worth understanding because they're the difference between a demo and something a real
business depends on:

- **Two separate programs running (an API and a background "worker").** Slow jobs —
  sending email, running AI, building PDF reports — happen in the background so the
  app stays fast and responsive for users. (See [BULL.md](./BULL.md).)
- **A fast shared memory layer (Redis).** Powers instant caching, the background job
  queue, rate limits that stop abuse, and live updates pushed to the dashboard. (See
  [REDIS.md](./REDIS.md).)
- **Strict data isolation between factories.** Three independent safeguards make it
  effectively impossible for one tenant's data to leak into another's. For a SaaS
  holding many companies' commercial data, this is non-negotiable.
- **A full audit trail.** Every important action (who approved this PO, who changed
  this price) is recorded. Businesses need this for accountability and disputes.
- **Graceful failure.** If recording a delivery succeeds but the follow-up email fails,
  the delivery still counts. The system degrades gently instead of breaking entirely.
- **Live updates.** Dashboards update themselves in real time (a forecast finishing, a
  PO status changing) instead of making users hit refresh.

---

## 7. A day in the life — one concrete story

To tie it all together, here's the system doing its job end-to-end:

1. A warehouse operator records that **500 kg of cotton arrived** against a purchase
   order.
2. **Inventory updates instantly**, and the earlier "low stock" warning clears.
3. Because stock changed, the system **quietly asks the AI to re-forecast** demand for
   cotton in the background. Moments later the dashboard's chart updates itself.
4. Weeks of data accumulate. Demand starts trending up. The next forecast flags that
   cotton will run low sooner than expected and **suggests reordering now**.
5. A manager sends a **request for quotes** to three suppliers, the responses come back,
   and the system **ranks them and the AI explains the trade-offs** ("Supplier B is
   cheaper but two days slower").
6. The manager picks one; the system **drafts a purchase order**, the owner approves it,
   and a **PDF order is emailed to the supplier** automatically.
7. On Monday morning, the owner opens their inbox to a **PDF weekly briefing** — written
   by the AI — summarizing spend, stock health, supplier performance, and what to watch.

No spreadsheets. No guessing. No surprise stock-outs. That's the whole point of the
system.

---

## 8. In one paragraph (for a recruiter or customer)

> This is a multi-tenant SaaS platform that gives factories a single, trustworthy
> system for managing inventory and buying from suppliers — and layers AI on top to
> predict demand, suggest when and how much to reorder, compare supplier quotes, and
> write weekly executive reports automatically. It solves the everyday pain of
> spreadsheet-driven procurement: stock-outs that halt production, cash wasted on
> over-ordering, slow and undocumented buying decisions, and the hours lost compiling
> reports. It replaces all of that with one live source of truth, AI-driven
> decision support, and the security, accountability, and reliability a real business
> needs to depend on it.
> </content>
