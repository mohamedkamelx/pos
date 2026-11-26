# POS Cleanup Plan — Records and Platform

Status: Planned, not implemented  
Created: 2026-11-26  
Last updated: 2026-11-26

This document has two parts:

- **Part I — Customer & Supplier Account Cleanup:** information organization and presentation only. No redesign, no new backend, no new sync lane.
- **Part II — Platform Cleanup and Simplification:** API namespace cleanup, dead-code removal, outbound email removal, payment-gateway removal, and cloud-connectivity removal. This part changes routes and removes features, so it is scheduled separately from Part I.

## Part I — Goal

Make the main records feel organized by giving each one a single, predictable story:

1. Who or what it is.
2. What the current balance is.
3. What was ordered or purchased.
4. What was paid.
5. Contact and record details.
6. The complete statement.

Every related name, number and payment row must lead to the record it belongs to.

This plan starts with the highest-impact area: **Customer and Supplier accounts**. Item history and menu/report consolidation come later.

## Guiding rule

One record page, one fixed sequence, one source of truth, and every row is a door to its document.

No new tabs. No duplicate links to the same place. No new visual language. Reuse the existing dossier, statement and table components.

## Current problems

### Customer page

- Summary, contact and recent sales are on the page.
- Payments and the running ledger are only inside the Statement modal.
- Order rows are not clickable.
- The header shows an outstanding pill while the summary repeats outstanding information.
- The page mixes a sales report query with a separate recent-sales query, so the numbers can diverge.

### Supplier page

- Summary, contact and recent purchases are on the page.
- Outstanding is loaded by a separate debt request.
- Payments are only inside the Statement modal.
- Purchase rows open an inline preview, but the full document is a separate step.
- The purchase table has fewer columns and a different structure from the customer table.

### Sale, purchase and item pages

- Customer and supplier names are plain text.
- Item lines are plain text.
- Supplier names on item details are plain text.
- The statement already links some rows to documents, but the rest of the app does not follow the same rule.

### Visual confusion

- Different stats are shown on customer and supplier records.
- Balance appears in more than one place.
- Some sections have a Statement link in the toolbar and another inside the body.
- Tables use different columns for the same kind of information.
- Payment information is visually buried under a modal instead of being part of the account page.
- Empty or one-sided sections still take up space and create the feeling of scattered options.

---

# Workstream 1 — Shared Customer/Supplier account layout

Estimate: **1–1.5 focused days**

## Data source

Use the existing party statement endpoint as the single source for the account:

```
GET debts/customers/:id/statement
GET debts/suppliers/:id/statement
```

It already returns:

- `summary` — invoiced, paid at sale, collected, outstanding, credit, invoice count, payment count, last document/payment
- `invoices` — document number, date, total, balance, payment status
- `payments` — date, amount, reference, note, allocations
- `ledger` — the complete account running balance

This removes the need for separate stats/order/debt requests on the party page. The Statement modal already uses the same endpoint, so the summary and the full statement will always agree.

Keep the existing party record request for name, phone, email, address, state, country and created/updated dates.

## Shared presenter

Add one shared presenter, for example:

```
PosnicPro.debts.renderPartyAccount(container, type, id, party, options)
```

Where `type` is `customer` or `supplier`.

Put it in `frontend/static/script/js/modules/js/debts.js` for this pass because that module already owns statement fetching, formatting, document links and pagination. If the presenter grows beyond account presentation later, move it into a small core helper.

Both `customers.js` and `suppliers.js` call the same presenter. Do not maintain two copies of the layout.

## Page sequence

Use the same order for both record types.

### 1. Header

- Party name.
- One primary action only:
  - Customer: Collect payment, only when outstanding is greater than zero.
  - Supplier: Pay supplier, only when outstanding is greater than zero.
- Secondary actions:
  - Edit
  - More (delete and other destructive actions)
  - Close
- Do not repeat the outstanding balance as a second pill if the summary already shows it. Choose one place for the number.

### 2. Account summary

Customer:

- Orders
- Invoiced
- Paid
- Outstanding

Supplier:

- Purchases
- Invoiced
- Paid
- Outstanding

Rules:

- Use the statement summary, not separate report numbers.
- Use tabular numerals and the shop currency.
- Hide a stat only when it has no meaning for that record.
- Do not show a zero-value stat row that adds noise. One clear empty state is enough.

### 3. Orders / Purchases

Show the latest five from `invoices`, newest first.

Columns:

- Document number
- Status
- Date
- Total
- Balance

Behaviour:

- The whole row opens the document:
  - Customer: `#/sales/<record_id>`
  - Supplier: `#/purchaseorders/<record_id>`
- Use the existing route for each document.
- If more than five exist, one quiet “View all” action opens the full statement’s invoice section.
- Do not create another list page.

### 4. Payments

Show the latest five from `payments`, newest first.

Columns:

- Date
- Method or reference
- Applied to
- Amount

Behaviour:

- If a payment has an allocation, link it to the applied order.
- If it is unapplied or has no allocation, open the statement payment section.
- Show the reference and note only when they exist.
- Do not render empty dashes in every unused cell.
- “View all” opens the statement’s payment section.

### 5. Contact and record details

Keep compact and secondary:

- Phone
- Email
- Address
- State/country
- Added/updated dates

Use the existing contact and record blocks. Do not add another card or a second header.

### 6. Full statement

- Keep the existing Statement modal and its complete ledger.
- There should be one clear Statement action, not the same link repeated in the toolbar and in the body.
- Add an optional section target so “View all payments” and “View all orders” open the relevant part of the same modal.

## Empty and edge states

- No invoices: show one quiet “No orders yet” or “No purchases yet” line, not an empty table with headers.
- No payments: show one quiet empty line.
- No outstanding: do not show Collect/Pay as the primary action.
- Walk-in customer: no customer record exists, so this page is not involved.
- Fully paid account: summary remains visible; no outstanding/payment action is shown.
- Restricted user: hide actions they cannot use; keep read-only statement access only where the server allows it.
- Long names, long references, RTL and narrow widths must wrap or truncate using existing patterns; no horizontal page overflow.

## Permissions

- Statement access follows the existing customer/supplier read permission path.
- Collect/Pay and Edit follow the existing write permissions.
- Delete stays in More and follows the delete permission.
- Re-apply the page’s ACL scan after rendering the dossier, as the current modules already do.

## Workstream 2 — Cross-links

Estimate: **2–4 hours**

Add links only through existing routes.

| Location | Link target |
|---|---|
| Customer name on a sale document | `#/customers/<id>` |
| Supplier name on a purchase document | `#/suppliers/<id>` |
| Item name on a sale or purchase line | `#/items/<item_id>` where the existing response carries the id |
| Supplier name on an item dossier | `#/suppliers/<id>` where the item carries a supplier id |
| Order/purchase row on a party page | Existing sale/purchase route |
| Payment row with allocation | Applied order route |
| Statement document row | Existing statement link behaviour |
| Party name in the statement | Back to the party dossier if the id is available |

Rules:

- Use the IDs already present in the detail responses.
- If an item or supplier ID is missing from a response that already stores it, expose that stored ID in the response. Do not match records by name.
- Use normal hash navigation. No new routing layer.
- Do not add a custom back stack in this pass. Keep the existing hash/history behaviour.
- Preserve the current permission gates on every link.

## Workstream 3 — Presentation and visual cleanup

Estimate: **0.5–1 focused day**

The goal is less visual noise, not a new design.

### One hierarchy

- One page title.
- One summary strip.
- One orders section.
- One payments section.
- One details grid.
- One full-statement action.

### One balance

- Show outstanding once in the main visual flow.
- Do not repeat it in a header pill and a stat card unless the owner explicitly wants both.
- Recommendation: header carries identity and actions; summary carries the numbers.

### One table language

- Use the same column order for both customer and supplier.
- Right-align money and numeric values.
- Use the same date formatting and shop timezone.
- Use one row height and one hover treatment.
- Do not use zebra banding; keep the existing hairline/hover style.
- Make clickable rows visibly clickable through the existing row hover/link treatment.

### One action area

- Primary: Collect payment or Pay supplier, only when there is something to pay.
- Secondary: Edit.
- Quiet group: More.
- Last: Close.
- Remove duplicate Statement links.
- Remove duplicate or contradictory labels such as two different outstanding figures.

### Cleaner details

- Keep contact and record metadata compact.
- Do not let helper text explain the obvious.
- Do not add a second card frame inside the existing sheet.
- Use the existing section spacing rhythm; no one-off 6px, 10px or 13px gaps.
- Keep the sheet as the single outer surface.

### Responsive and RTL

- Stats may wrap in pairs on narrow widths.
- Tables may scroll horizontally, but the page itself must not.
- Verify long Arabic names, long references and RTL alignment.
- Confirm the toolbar actions wrap without overlapping the title.

### Style boundary

- Reuse existing classes: `p-doc-toolbar`, `s-doc-stats`, `s-doc-grid`, `q-block`, `q-items`, `q-sheet`, `rs-pill`, `debts-statement-*`.
- Only add CSS if an existing class cannot express the correct layout. No new colors, shadows, decorative frames or one-off components.
- Do not change the sidebar, page shell or global theme as part of this work.

---

# Implementation order

1. Add the shared party-account presenter in `debts.js`.
2. Switch the customer dossier to the shared presenter and the statement source.
3. Switch the supplier dossier to the same presenter.
4. Apply the presentation cleanup to both pages together.
5. Add the cross-links.
6. Add focused regression tests and run the existing relevant tests.
7. Review both pages at normal, narrow and RTL widths.

# File map

Likely implementation files:

- `frontend/static/script/js/modules/js/customers.js`
- `frontend/static/script/js/modules/js/suppliers.js`
- `frontend/static/script/js/modules/js/debts.js`
- `frontend/static/script/js/modules/js/sales.js` — customer and item links
- `frontend/static/script/js/modules/js/receiving_add.js` — supplier and item links
- `frontend/static/script/js/modules/js/items.js` — supplier link
- `frontend/static/style/css/custom.css` — only if existing dossier classes are insufficient
- `frontend/static/style/css/modules/debts.css` — only if statement section targeting needs a small adjustment
- `tests/` — add focused coverage for the account page and links

No new files should be needed in `frontend/pages_html_map.json` or `frontend/pages_css_js_map.json` because no new page module is being introduced.

# Acceptance criteria

- Customer and supplier dossiers follow the same sequence.
- Account numbers come from one statement response.
- Latest orders/purchases and latest payments are visible without opening the Statement modal.
- The full statement remains available and unchanged in purpose.
- Every order/purchase row opens its document.
- Every party/item name that has an ID is a link to its record.
- There is one clear statement action, not duplicate links.
- Outstanding is not duplicated in confusing ways.
- Paid, partially paid, unpaid, no-orders and no-payments states are clean.
- Restricted users do not see actions they cannot use.
- Long names, RTL and narrow layouts do not overflow.
- No new API, collection, migration or sync change.
- No new routes or renames. If routes or menu labels change later, universal search must be updated in the same change.

# Testing and verification

Run locally:

- `tests/debts-statement-layout.test.js`
- Sales document/payment tests that touch customer links
- Purchase/payment tests that touch supplier links
- The relevant customer/supplier or record-workspace tests
- Any new focused test covering:
  - statement summary rendering
  - order/purchase row links
  - payment-to-order links
  - empty account
  - fully paid account
  - restricted user
  - long RTL content

Manual review:

- Customer with open dues and payments.
- Customer with no invoices.
- Supplier with received purchases and later payments.
- Supplier with no purchases.
- A sale detail and a purchase detail with linked names.
- Narrow layout and RTL.
- Browser back after following a cross-link.

# Later phases

## Part I follow-up — Item workspace

Estimate: **0.5–1 day**

- Product summary.
- Supplier and category links.
- Recent sales, purchases, returns and stock movements in one sequence.
- Full stock history link.
- No new tab bar.

## Part I follow-up — Menu and report consolidation

Estimate: **0.5–1 day**

- One main destination per object: Items, Customers, Suppliers, Sales, Purchases.
- Reports remain for cross-entity analysis, not duplicated record history.
- Keep old routes as redirects.
- Update the universal search catalog and menu labels in the same change.

## Explicitly out of scope for Part I

- Rebuilding the sales or purchase screen.
- Redesigning the statement modal.
- Consolidating every report tab.
- New backend aggregation or schema changes.
- Changing sync collections or transport.

# Sync and data notes for Part I

This is a read-only presentation change. It introduces no new persisted field, write path, deletion path or collection. The statement endpoint already reads the existing sales, receivings, party payment and debt data. No `api/src/sync/collections.json`, Gateway or sync-agent change is required.

The page must not replay payments or create account entries. Collect/Pay continues to use the existing action and its existing authorization.

# Universal search notes for Part I

No new routes are added in this pass, so the search catalog does not need a new destination. Cross-links use existing routes that are already registered.

If a later phase renames or removes a menu item, route or report, update `command-palette.js`, the route aliases and `docs/UNIVERSAL_SEARCH.md` in that same change.

# Part I decisions to confirm before implementation

1. **Balance placement:** recommendation is one outstanding figure in the summary strip, with the header reserved for identity and actions.
2. **Supplier scope:** this page is the account/history of received purchases. Open purchase orders remain in the Purchases surface.
3. **“View all” behaviour:** recommendation is to open the relevant section of the existing statement rather than inventing a new filtered list.
4. **Payment row destination:** first allocated order where available; otherwise the statement payment section.

# Part I effort summary

| Work | Estimate |
|---|---:|
| Shared account layout and statement-backed summary | 1–1.5 days |
| Cross-links | 2–4 hours |
| Presentation and visual cleanup | 0.5–1 day |
| Tests and review | included above |

Expected total for the first complete slice: **2–3 focused days**, with a usable review point after the customer/supplier layout is applied and before menu/report cleanup begins.

---

# Part II — Platform Cleanup and Simplification

Status: Scope added 2026-11-26; not implemented  
Relationship to Part I: Independent. Part I can ship first. Part II changes routes and removes features, so it must be scheduled and reviewed separately.

## Objective

Move the product to a clean, local-first shape:

- One canonical API namespace: `/api`.
- No duplicate route mounts or stale aliases.
- No outbound email stack.
- No external payment gateway.
- Local uploads by default, with remote storage removed.
- No cloud pairing, sync agent, remote licensing, automatic updates, remote branding, analytics injection, Expo push, or cloud reporting/notification workers.
- Keep the local POS, local multi-branch catalogue sharing, local sessions, license scoping, PDF/print, cash/card/split payments, reconciliation, receipts, API tokens, and the recently added Groq-backed AI feature with all its tools.

This is not a UI redesign. It is a removal and simplification program.

## Current-state findings included in this plan

- **Cloud pairing is already partly dead.** The desktop shell no longer starts a sync agent, but stale flags, paths, health routes, build resources, and packaging remain.
- **Email is entirely outbound email.** Welcome mail, password-reset mail, daily sales mail, sale-bill mail, report mail, SMTP settings, and the Microsoft, Brevo, SendGrid, Postmark and Resend provider paths are all in scope for removal.
- **Payment-gateway removal is narrow.** Dojo is the only real gateway implementation and it lives inside the extension payment stack. Cash, card, split payments, reconciliation, receipts and standard payment records are core and stay.
- **Remote storage is optional.** S3 is selected by `STORAGE_TYPE`; local uploads are already the default.
- **The API is mounted twice.** `apiRouter` is mounted at both `/api` and `/`, `suppliersRoutes` is mounted twice, and `/setting`, `/stocklogs`, `/customercategory`, `/pair`, `/events`, push, webhooks and API tokens all have duplicate spellings.
- **`routes/index.js` is not actually generated anymore.** It says it is auto-generated, but no generator exists in the repo. The API docs generator still regex-scrapes it, so it must be updated whenever mounts change.

## Keep list — do not remove

- API tokens. Keep the feature; remove only duplicate root mounts or stale spellings. Canonical API-token access stays under `/api`.
- The recently added AI feature that uses Groq, including all of its tools.
- Cash, card, split payments, reconciliation, receipts, sale accounting and standard payment records.
- Local uploads.
- Local install credentials, tenant license scoping and local sessions.
- Version display and manual installer installation.
- Local multi-branch catalogue sharing, with its sync nudge removed.
- Local business decision, receipt and metrics code only where it has local route callers and no outbound calls.
- PDF and print output.
- Customer email as contact data, unless a later explicit request changes that.
- Local administrator reset/recovery through `recover-access.js` and the existing local admin path.

## Data-safety rules

- Do not drop collections.
- Do not delete historical `dojo_payment_operations` documents.
- Do not replay or delete stored `sync_outbox` data.
- Do not silently delete stored SMTP credentials. Stop reading them; a one-time credential scrub is a separate, explicitly approved migration.
- Do not delete existing S3 files. Existing absolute S3 URLs remain readable only if the bucket still permits it; downloading or migrating them is a separate explicit-data operation.
- Do not delete the 65 `business-*` services as a block. That requires a separate dependency audit.
- Do not remove API tokens or the Groq AI feature.
- Do not deploy, publish, build a customer installer, or touch a live service as part of this plan without fresh explicit permission.

## Sequencing

1. Part I — Customer/supplier account cleanup.
2. Part II Phase 1 — Split `api/app.js` with no behavior change.
3. Part II Phase 2 — Canonical `/api` namespace and duplicate removal.
4. Part II Phase 3 — Dead code and safe duplicates.
5. Part II Phase 6 — Outbound email removal.
6. Part II Phase 7 — Payment-gateway removal.
7. Part II Phase 8 — Cloud connectivity removal, one sub-phase at a time.

The numbering from the source scope is preserved. **Phases 4–5 are not defined in this instruction** and are intentionally not invented here. Add them only when their scope is explicitly provided.

Each phase should be independently reviewable and reversible. Do not combine a route change with a feature removal unless the caller updates require it.

---

# Phase 1 — Split `api/app.js` with no behavior change

## Work

Extract the app composition into focused modules while preserving the exact middleware order.

### `api/src/app/security.js`

- Compression
- CORS headers
- Rate limits
- Sanitizers
- Body parsers
- CSRF
- Session handling
- Cookie handling

### `api/src/app/static.js`

- Frontend static roots
- Uploads
- Brand JSON
- Print page
- SPA fallback

### `api/src/app/infra.js`

- Health
- Readiness
- Runtime info
- SSE
- Push
- Webhooks
- API tokens

### `api/src/app/routes.js`

- Single route composition point.
- This replaces the current split composition responsibility. Do not change route behavior in this phase.

### `api/src/app/lifecycle.js`

- Database attach
- Change events
- Not-found handler
- Error handler

## Files to update

- `api/server.js`
- `api/scripts/generate-api-docs.js`
- `api/tests/api/route-coverage.test.js`
- The misleading `api/src/routes/index.js` header
- Related tests that import the composition modules directly

## Rules

- Preserve exact middleware order.
- Preserve every current route and response.
- Do not remove or rename a route in this phase.
- Change the `routes/index.js` header to state that it is manually maintained, not auto-generated, unless a real generator is restored.
- The API docs generator still regex-scrapes `routes/index.js`; keep that behavior working in this phase.

## Acceptance criteria

- API starts and serves the same routes as before.
- Middleware order is unchanged.
- Auth, CSRF, sessions, rate limits, uploads, SPA fallback and error handling behave the same.
- Route coverage passes.
- API docs generation still works.
- No feature removal in this phase.

---

# Phase 2 — Canonical API namespace and duplicate removal

## Canonical namespace

Use **`/api` only** for API routes.

Keep bare paths for non-API resources:

- HTML pages
- Static assets
- `/uploads`
- `/brand.json`
- `/print/:token`

## Frontend base URL

Change `API_URL` from `origin + '/'` in the six source HTML pages:

- `login.html`
- `dashboard.html`
- `forgotpassword.html`
- `ssoauth.html`
- `customersearch.html`
- `customersMailPrint.html`

Also update their generated `frontend/public` copies and rebuild with:

```bash
npm run prepare:frontend
```

Point the frontend base at the canonical `/api` namespace and update callsites in the same phase.

## Route cleanup

- Pilot first with `/setting` → `/settings`:
  - 54 call sites use the old spelling.
  - 12 already use `settings/`.
  - Update all callers and keep one canonical route.
- Change `/stocklogs` → `/stock-logs`:
  - 4 call sites in `PosnicPro.js`, `stocklog.js` and `items.js`.
- Remove the `/customercategory` alias and the unused `api/src/controllers/customerCategory.controller.js` plus its unit test.
- Remove the duplicate `suppliersRoutes` mount.
- Remove `apiRouter` from the root mount; API routes must be reachable only under `/api`.
- Remove root mounts for `events`, `push`, `webhooks`, `API tokens`, `mobile`, `extensions`, and `pair` as each feature is removed.
  - API tokens are kept as a feature. Remove only their duplicate root mount and keep the canonical `/api` path.
- Remove remaining duplicate route spellings.
- Update health, readiness and runtime callers if those routes move under the canonical API namespace. Keep a non-API liveness path only if the desktop shell genuinely requires one.

### Replacement rule

Before removing any duplicate API route or alias, identify the surviving canonical path and update it and every caller so it performs the same job. Do not remove a duplicate until the survivor is verified to cover the same request, response, authorization and branch-scoping behavior.

## Tests and docs

- `tests/settings-group-cutover.test.js`
- `api/tests/api/route-coverage.test.js`
- `docs/API.md`
- `docs/openapi.json`
- Any frontend tests that build an API URL or assert a route spelling
- API docs generator output after mounts change

## Acceptance criteria

- No frontend request reaches a root-mounted API route.
- `/api` is the only API namespace.
- Only one `suppliersRoutes` mount exists.
- `/setting`, `/stocklogs`, `/customercategory` and the removed root aliases no longer resolve.
- API tokens still work through the canonical `/api` path.
- HTML, static assets, uploads, brand JSON and print pages still work at their bare paths.
- Route coverage and API docs match the live composition.
- No stale duplicate spelling survives in docs, tests or frontend callsites.

---

# Phase 3 — Dead code and safe duplicates

## Work

- Remove unused imports.
- Remove the duplicate suppliers mount if it still exists after Phase 2.
- Remove stale route aliases.
- Confirm `business-access.routes.js` is unmounted.
- Remove `business-access.routes.js` only after a caller search proves it is unreferenced.
- Remove any other definitely unreferenced controllers or services found by the route/import report.
- Do not delete the 65 `business-*` services as a block. That is a separate dependency audit.
- Do not remove API tokens or the Groq AI feature while cleaning unused imports.

## Required evidence

- Caller search results for every removed file.
- Route/import report showing no live references.
- Route coverage after removal.
- No removal based only on a filename or a stale code comment.

## Acceptance criteria

- The app starts and all covered routes still pass.
- Removed files are genuinely unreferenced.
- The `business-*` service family is untouched unless separately approved.
- No working local feature is removed as collateral cleanup.

---

# Phase 6 — Outbound email

## Scope

Email is entirely outbound email. Remove the outbound stack and keep local contact data.

Remove:

- `api/src/utils/email.js`
- `api/src/services/shop-email.js`
- Welcome mail
- Password-reset mail
- Daily sales mail
- Sale-bill email
- `/reports/email`
- `salesMailPdf`
- SMTP fields and SMTP settings UI
- Microsoft, Brevo, SendGrid, Postmark and Resend provider paths
- Email-composition UI
- `mailto:` email actions
- Related tests, docs, environment examples and stale settings translations

Keep:

- Customer email as displayed contact data.
- PDF output.
- Print output.
- Local administrator reset/recovery.
- The existing local admin path.

## Password recovery

Replace self-service forgot-password with:

- Local administrator reset/recovery.
- `recover-access.js` and the existing local administrator path as the supported route.

The reset flow must not depend on an outbound email provider.

## Credentials

- Do not silently delete stored SMTP credentials.
- Stop reading them.
- A one-time credential scrub is a separate, explicitly approved migration.
- Remove provider API keys from configuration examples and settings surfaces.

## Acceptance criteria

- No application path reads SMTP settings or sends outbound email.
- No welcome, reset, daily-sales, sale-bill or report email can be triggered from the UI or API.
- The local administrator reset path works.
- PDF and print still work.
- Customer email remains visible as contact data, without a mailto composer.
- Historical data and stored credentials are not silently deleted.
- Related tests and documentation no longer describe removed email features.

---

# Phase 7 — Payment gateways

## Scope

Dojo is the only real gateway implementation and it lives inside the extension payment stack. Remove only the gateway path.

Remove:

- `extension-payments.js`
- `dojo-client.js`
- `dojo-payment-journal.js`
- Dojo routes and tests
- Dojo CSP entries
- Dojo payment-operations handling
- Dojo-specific UI, settings and provider configuration

Keep:

- Cash
- Card
- Split payments
- Reconciliation
- Receipts
- Sale accounting
- Standard payment records
- Refunds and returns that do not depend on the Dojo gateway

Do not drop the `dojo_payment_operations` collection or delete historical documents.

## Acceptance criteria

- No Dojo code, route, CSP entry or payment operation is reachable.
- Cash, card, split payments, reconciliation, receipts and sale accounting still pass their tests.
- Historical Dojo records remain untouched.
- The extension payment stack no longer advertises a gateway that does not exist.
- Standard payment records continue to behave as before.

---

# Phase 8 — Cloud connectivity

Split into independently reviewable sub-phases. Do not combine them into one removal branch.

## 8.1 — Sync, outbox and agent

Remove:

- `api/src/sync/outbox.js`
- `api/src/sync/nudge.js`
- `api/src/sync/collections.json`
- Sync/outbox call sites in sales, items, stock, spoilage, mobile inventory and catalogue sharing
- `builds/sync-agent`
- `scripts/prepare-sync-agent.js`
- `prepare:sync-agent`
- Extra resources and installer entries that package the agent
- `SYNC_AGENT_PORT`
- Stale sync-agent flags, paths, health routes, validation and packaging checks
- Sync-specific tests

Keep:

- Local multi-branch catalogue sharing, but strip its sync nudge.
- Existing stored data.

Rules:

- Leave stored `sync_outbox` data untouched.
- Do not replay it.
- Do not delete the collection.
- The desktop shell must not start or expect a sync agent.
- Remove stale agent packaging from public builds and verify no private agent source is copied into the installer.

## 8.2 — Remote storage

Remove:

- `api/src/utils/s3.js`
- S3 branches in item, category, user and report-document upload code
- `STORAGE_TYPE` S3 selection and related settings/keys where they are only used for remote storage
- S3-specific tests, docs and CSP entries

Keep:

- Local uploads as the default and only supported path.
- Existing stored files.
- Existing absolute S3 URLs readable only if the bucket still permits it.

Rules:

- Do not migrate or delete remote files as part of this phase.
- A download/migration operation is a separate, explicit-data task.
- Verify local uploads for items, categories, users and report documents after removing the S3 branch.

## 8.3 — Analytics

Remove:

- Analytics configuration
- Google Analytics injection
- Analytics CSP domains
- Settings UI and keys for remote analytics
- Remote analytics tests and docs

Keep local business metrics only where they have local route callers and no outbound calls.

## 8.4 — Remote account and licensing

Remove:

- SSO login and token handling
- `ssoauth.html`
- Shadow login
- Plan update calls
- Account and upgrade UI
- Remote account routes and callers

Keep:

- Local install credentials.
- Tenant license scoping.
- Local sessions.
- Local permissions and branch access.

## 8.5 — Remote updates and branding

Remove:

- `src/update-service.js`
- `electron-updater`
- Automatic update checks
- Update publish configuration
- Update-specific IPC, UI and tests
- Cloud-fetched white-label branding

Keep:

- Version display.
- Manual installer installation.
- A locally cached or seeded brand, including the local `brand.json` path.

Rules:

- Do not remove the ability to see the installed version.
- Do not make startup depend on an update check.
- Do not break installer packaging validation.

## 8.6 — Cloud business services

Remove:

- Cloud pairing transport
- Expo push
- Cloud reporting workers
- Cloud notification workers
- Cloud access paths, but only after an import/egress audit
- Remaining duplicate route spellings and stale API docs

Keep:

- Local business decision, receipt and metrics code only if it has local route callers and no outbound calls.
- Local multi-branch catalogue sharing without the sync nudge.
- API tokens under the canonical `/api` namespace.
- The Groq-backed AI feature and all its tools.

Rules:

- Audit `/pair`: keep only a local-LAN mobile-inventory pairing path if it is still used and has no cloud dependency; otherwise remove it with cloud pairing.
- Audit every worker and service before removal for local callers.
- Do not remove local functionality merely because it shares a file name with a cloud feature.
- Update universal search, menus, translations and docs when a user-facing feature is removed.

---

# Cross-cutting verification

Apply this checklist to every phase and to every removed or renamed list, report or feature.

## Table and report integrity

For every affected list or report, verify:

- Table search
- Primary party/item filter
- Business date range
- Supported sorts
- Branch visibility
- Count
- Totals
- Export
- Narrow layout

A removed report must not leave a dead menu item, route, translation key or universal-search result.

A renamed list or report must keep its query, permissions, filters, count, totals, export and narrow layout working through the new route.

## Universal search and navigation

For every removed, renamed or moved route, report, setting, feature or extension:

- Update universal search in the same change.
- Update the translated menu label and aliases.
- Remove stale destinations from **All**.
- Keep permission and feature gates attached to the surviving destination.
- Verify discovery from All with an authorized user and a restricted user.
- Update `docs/UNIVERSAL_SEARCH.md` if the route or wording rules change.

## API and documentation

- Update `docs/API.md`.
- Update `docs/openapi.json`.
- Update the API docs generator if mounts or route composition changed.
- Update `api/tests/api/route-coverage.test.js`.
- Search for stale route spellings in tests, docs, HTML, JS and settings.
- Confirm no generated frontend copy still uses the old API base.

## Data and sync

- No new sync lane is introduced by a removal.
- Do not replay `sync_outbox`.
- Do not delete historical Dojo, payment, sync or remote-storage data.
- Do not silently delete stored credentials.
- Verify branch isolation and tenant license scoping remain intact.
- Verify local multi-branch catalogue sharing still works after the sync nudge is removed.
- State clearly which data becomes local-only and which existing records remain readable.

## Packaging and distribution

- Verify the desktop shell starts without a sync agent.
- Verify the installer contains no stale sync-agent files or extra resources.
- Verify no private Gateway or agent source is copied into POS source, build resources, archives or release assets.
- Use the documented public-build path.
- Inspect the actual installer contents before any later upload; do not rely on an exclusion list alone.
- Keep version display and manual installer installation.
- Do not publish or distribute anything as part of this plan without fresh explicit permission.

## Local verification

- Run the relevant unit, API, route-coverage, packaging and attribution checks locally.
- Do not add GitHub Actions jobs or expand CI for this cleanup.
- Batch changes and push only after local checks pass.
- Keep regression tests in the repository even when a workflow is removed.

## Effort

Part II is a multi-phase cleanup and should not be estimated as one block until the route/import/egress audit is complete. Phase 1 and Phase 2 are the first candidates because they simplify everything that follows. Phase 6, 7 and 8 are separate review units.

## Open decisions for Part II

1. **Health/readiness path:** keep it under `/api` only, or retain one non-API liveness path if the desktop shell needs it.
2. **API-token path:** keep the feature and canonicalize it under `/api`; confirm the exact surviving route name.
3. **Local mobile-inventory pairing:** keep only if it is local-LAN and independent of cloud pairing.
4. **Business metrics:** keep local metrics only where a local route actually needs them; otherwise remove with the cloud workers.
5. **Remote-storage migration:** deletion or download of existing S3 files is out of scope and requires separate approval.
6. **SMTP credentials:** stopping reads is in scope; deleting stored credentials is a separate migration.
