# Contributing to Posnic

Posnic is an offline-first point of sale. Small, focused changes are easier to
review, test, and support than broad rewrites.

## Start here

1. Read [CONTRIBUTOR_QUICKSTART.md](../docs/CONTRIBUTOR_QUICKSTART.md) for the
   first-run setup and the checks that match your change.
2. Read [DEVELOPMENT.md](../docs/DEVELOPMENT.md) for the architecture, test
   commands, and local database setup.
3. Read [GOVERNANCE.md](../docs/GOVERNANCE.md) for how decisions and releases
   are made.

By participating you agree to the [code of conduct](CODE_OF_CONDUCT.md). Before
a pull request can be merged, you must sign the [contributor licence
agreement](CLA.md).

## Report a problem

Use a normal issue for a defect, a question, or a feature request. Include the
version, platform, steps, and the log. The log paths are:

| System  | Log                                            |
| ------- | ---------------------------------------------- |
| Windows | `%APPDATA%\posnic\app.log`                     |
| macOS   | `~/Library/Application Support/posnic/app.log` |
| Linux   | `~/.config/posnic/app.log`                     |

Do not put customer records, card or bank data, credentials, tax identifiers,
production database files, or private logs in a public issue. Security problems
go through [SECURITY.md](SECURITY.md), privately.

If you are reporting what happened in a real shop, deployment, pilot, or
evaluation, read [ADOPTION_EVIDENCE.md](../docs/ADOPTION_EVIDENCE.md) first. The
repository's deployment evidence issue form asks for identity, scope, failures,
evidence, and limits, and keeps a public report public unless its author gives
separate permission.

## Make a change

- Branch from `main` and keep the change to one purpose.
- Match the surrounding code and add a regression test for a bug fix.
- Do not add a generated-by footer or a tool, bot, or assistant as a
  contributor. Commits and project metadata name the human contributor.
- Keep customer branding, private build files, and credentials out of this
  repository.
- For a user-facing route, setting, report, or extension, update universal
  search in the same change. The rules are in
  [UNIVERSAL_SEARCH.md](../docs/UNIVERSAL_SEARCH.md).

## Run the checks

Install each workspace once:

```bash
npm ci
npm ci --prefix api
npm ci --prefix frontend
```

Then run the same fast checks the pull request runs:

```bash
npm run check
```

The API package also exposes the slower and unfiltered suites:

```bash
cd api
npm run test:all
npm run test:known-failures
npm run test:local
```

Before opening a pull request, confirm that the commit is attributable to its
human author:

```bash
npm run check:attribution
```

## Pull requests

Include:

- the problem and the smallest change that fixes it;
- what you tested, on which platform, and what you could not test;
- the sync decision when the change reads or writes shared business data; and
- the user-visible effect, including any permission, feature-gate, branch, or
  offline behaviour.

A pull request that changes a release, signing, update, or provenance path must
keep the release documentation and the verification guide in step with it.
