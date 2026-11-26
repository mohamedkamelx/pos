# Agent rules

Posnic credits people, not software tools. Never add an AI assistant, agent, model, bot, automation, coding tool or generated-by footer as an author, contributor, co-author, reviewer, maintainer, sign-off, changelog/release/README credit, package identity, issue or PR attribution. Remove assistant footers before committing. Describe tool use in a PR body as implementation context only. Run `npm run check:attribution` before a PR.

## Universal search

Every added, renamed or removed user-facing route, feature, report, setting or extension must update universal search in the same change. Register every navigable destination in **All** - list, detail and create - with the translated menu label, common operator terms, stable route or record resolver, module filter, and the destination's own permissions and feature gates. Settings link to the exact section or control. Extensions register eligible pages, actions and record providers and remove them on disable/uninstall. Parameterized record routes must resolve authorized records in the current shop and branch. Create actions open the existing entry form with its write permission and never submit it. Verify discovery from All with authorized and restricted users. See `docs/UNIVERSAL_SEARCH.md`.

Use the action phrase index in `command-palette.js`. Register primary lists under the entity name and add actions under the create destination. Attach alternate wording to the exact link or control with pipe-separated `data-search-aliases`. Extension manifests declare label, action and keywords. Test View and Add through the header and the destination Enter opens.

## Tables

Declare row type, searchable identifiers, primary party or item filter, business date and supported sorts. Use the shared list toolbar or the report's query adapter. A changed selection must feed the authorized local query, count, totals and export before pagination. Show Branch only for multiple accessible outlets. Verify the normal route, a match beyond page one, clearing filters and the narrow layout.

## Settings

The Features list is only switches. Never put a dropdown, text field or Save button in a Features card. Every setting belongs on its own module page (Tax, Marketing, Messaging, Kiosk, Captain App, etc.); add a tab there. A module without a page needs a page, not an exception. File a setting by the thing it belongs to, not by how it is built. Integrations is only for outward-facing API tokens, webhooks, signed connectors and the shop's own analytics property.

## Verification and CI

Prefer local tests, lint, packaging and attribution checks before pushing. Report commands, results and anything unverified. Do not add or expand GitHub Actions workflows, jobs, matrices, schedules, runners or triggers without an explicit user request. Keep regression tests in the repo and run Windows printer checks on Windows. Batch changes and push after local checks pass; do not push repeatedly to experiment. Preserve required checks and branch protection.

## Optional features

Default optional workflows and behaviors off and require explicit opt-in in their module settings. Server capability alone is not consent. Preserve saved settings on upgrade. Do not add automatic workflow transitions such as table cleaning. Keep duplicate prevention, durable order recovery, payment integrity, authentication and access checks automatic. Test unset and explicitly enabled settings.

## Sync

For every new or changed collection, persisted field, setting or write/delete path, review sync before calling it complete. State what users see on the web, the originating till and another authorized till, including offline operation and reconnection. Update POS `api/src/sync/collections.json`, Gateway `apps/sync-gateway/src/collections.js` and agent `apps/sync-agent/sync-config.json` together; verify names, scopes, transport and the installed agent. Check stable ids, tenant/branch access, timestamps/checkpoints, conflicts, tombstones and referenced files. Never leave business data `undecided`. Local-only data needs a concrete reason and a defined UX. Credentials, sessions, execution leases, printer queues and payment/stock journals must not be replicated; provide a read-only shared view or authenticated request instead. Test cloud to till, till to cloud and other authorized tills: create/update/delete, reconnect/retry, duplicates, branch isolation and migration. Check files separately. Include the sync decision, rollout order and evidence in the PR. Do not claim deployment before the required Gateway/API/agent and installer are available together.

## Private components

A request to build, sign, publish or send an installer is not permission to copy or distribute private repository contents. Public and customer builds use the documented public-build path. Never copy Gateway/Intranet source, including the private sync agent, into POS source, build resources, archives or release assets. Do not set `SYNC_AGENT_DIR` to a private checkout or rely on sibling auto-discovery. Check `builds/sync-agent` and output resources for stale private files. Any exception needs explicit authorization naming the component, contents, recipients and channel. Before uploading, inspect the actual installer/archive, including unpacked resources and nested archives, for private source, credentials, customer data, logs and unapproved components. Verify repository visibility and audience; a prerelease on a public repo is public. If an unauthorized artifact is found, stop distribution, preserve evidence without republishing sensitive content, and report the exact release, contents and known downloads. Withdrawal does not retract downloaded copies.
