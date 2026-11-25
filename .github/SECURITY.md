# Security policy

Posnic runs on the shop's own computer. This page says what that protects, what
it does not, and how to report a problem without putting a shop at risk.

## What the application protects

- The bundled MongoDB process listens on `127.0.0.1` only. It is not reachable
  from the shop's local network or from the internet.
- Local database credentials and signing secrets are generated on the
  installation, not shared between shops or baked into the source.
- The application does not require a vendor account or a hosted service to
  open the till.
- Updates carry checksums and, for published releases, artifact-bound SBOMs and
  provenance. The release verification procedure is in
  [VERIFY_RELEASE.md](../docs/VERIFY_RELEASE.md).

## What it cannot protect

These limits are part of the design, not a bug list:

- Anyone with **administrator rights** on the machine can reach the data,
  change the application, or disable its protections. That is true of every
  program on that computer.
- **Malware running as the user** the till runs as can read the database and
  the local logs. A standard account reduces the reach of that malware; it does
  not make it harmless.
- A person who can physically take the computer can take the disk. Use device
  encryption and keep the recovery key somewhere safe.
- A third-party extension or script that the shop installs runs with the
  shop's data. Review what it does before installing it.

The practical steps that make the biggest difference are in
[Keeping your till secure](../docs/USER_GUIDE.md#keeping-your-till-secure).

## Reporting a vulnerability

Do **not** open a public issue with exploit details, customer data, credentials,
or a working proof of concept. Use the private security contact supplied with
your distribution, or ask the maintainer who supplied your build for a private
channel.

Include:

- the Posnic version and platform;
- what an attacker can reach or change;
- the steps you took, with secrets and customer records removed; and
- whether the issue is already being exploited.

We acknowledge a report within three working days and will say what we know,
what we do not know, and what we intend to do next. Reports about the current
release are prioritised. See [SUPPORT_LIFECYCLE.md](../docs/SUPPORT_LIFECYCLE.md)
for the supported-version window.

This policy is not a promise that the software is vulnerability-free. It is a
statement of the boundary we test and the boundary a shop must still defend.
