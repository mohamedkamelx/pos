# Privacy

What Posnic does with your data, in plain terms. This covers the desktop
application and the self-hosted server in this repository.

**Last updated:** 24 November 2026

## The short version

Installed and left alone, the desktop application stores everything on your own
computer and sends nothing anywhere. There is no account, no signup, no
analytics and no telemetry. We cannot see your sales, your customers or your
stock, because they never reach us.

Posnic also ships integrations you can switch on — emailing a receipt, taking
an online payment. Those exist because shops asked for them, and
each one sends data to a provider **you** choose and configure. None is on by
default; none involves us. [What you can switch
on](#what-you-can-switch-on-and-what-it-sends) lists every one of them and what
it sends where.

## What the application stores, and where

Everything lives in a database on your own computer, in your user profile:

| System  | Location                                |
| ------- | --------------------------------------- |
| Windows | `%APPDATA%\Posnic\`                     |
| macOS   | `~/Library/Application Support/Posnic/` |
| Linux   | `~/.config/Posnic/`                     |

That includes your items, sales, customers, suppliers, staff accounts, settings
and logs. Nobody else has a copy unless you make one.

**This cuts both ways.** If that computer dies and you have no backup, the data
is gone — we cannot recover it for you, because we never had it. Copy your
backups somewhere else. See the
[user guide](USER_GUIDE.md#backups).

## What leaves your computer on its own

One thing, on a stock install where you have configured nothing:

**The bundled database, on first run.** A one-time download of MongoDB from
`mongodb.com` if the installer did not include it.

Automatic update checks and asset bundle checks are not configured in this
build. The app does not contact an update server, and no update feed is baked
in.

**Nothing else runs by itself.** No analytics library, no crash reporter, no
usage statistics, no "anonymous" beacons. This is verifiable rather than a
promise: the project has no analytics dependency, does not enable Electron's
crash reporter, and its Content-Security-Policy does not allow a script from any
analytics or error-reporting host — so one could not load even if something
tried. If you find otherwise, that is a bug — please [report it](../.github/SECURITY.md).

## What you can switch on, and what it sends

Everything below is **off until you configure it**, and each sends data to a
provider you pick and hold the account with. We are not in the path and we never
see it. Configuring one makes that provider your processor, not ours — their
terms and their privacy policy apply to what they receive. That includes
analytics: if you switch Google Analytics on, you are the controller of what
it collects about your visitors, and until you do, the page's own security
policy refuses Google's domains outright.

| Feature                    | Off by default | What it sends                                                                     | To whom                                                                    | Turn it off by                                                 |
| -------------------------- | -------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Email receipts and reports | Yes            | Customer email, invoice PDF, sale total, payment mode                             | The SMTP or email API provider you configure                               | Clearing the email settings                                    |
| Google Analytics           | Yes            | Page views and usage events from this shop's pages, under Google's own collection | Google, into the Analytics account whose measurement id you enter          | Switching the toggle off (Settings → Integrations → Analytics) |
| S3 file storage            | Yes            | Item and user images you upload                                                   | The S3 bucket you own                                                      | Leaving storage set to local                                   |
| Browser push notifications | Yes            | A low-stock count and a link to the low-stock page                                | The push service your browser uses, with keys stored in your shop database | Removing the subscription or the reorder level                 |
| Outbound webhooks          | Yes            | A change event naming the entity and time; no business record                     | The HTTPS endpoint you register                                            | Deleting the webhook subscription                              |
| Extension payments         | Yes            | Payment amount and reference for the provider the extension uses                  | The provider configured in an installed extension, for example Dojo        | Removing the extension or its provider settings                |

If none of these is configured — which is how the app installs — then apart from
the database download above, nothing your shop does reaches the network at all.
Pull the cable and keep selling; that is the design.

**Your customers did not choose these providers, you did.** If you switch one
on, telling your customers about it is your job, not ours. See [your customers'
data](#your-customers-data).

## When you ask for help

The desktop support window prepares a report locally: your message, reply
address, shop and branch name, account reference, app version, a short log tail
and any attachments you choose. It copies that report so you can send it
through your own support channel. Nothing is uploaded by the app.

Remote diagnostics are not configured in this build. No pairing service or
upload endpoint is baked in, and no diagnostic session starts automatically.

## What we will never add

- Telemetry that reports on your business — what you sell, how much, or how often
- Anything that requires an account to use the free application
- Advertising, or sharing data with advertisers
- Any feature that stops the app working when it cannot reach us

These are commitments, not current defaults. They are part of
[GOVERNANCE.md](GOVERNANCE.md#things-that-are-not-up-for-debate) and changing
them would need the same public process as any other decision.

## Your customers' data

If you record customer names, phone numbers or addresses, that data is yours and
your responsibility. Posnic is the tool; you are the one holding the
information.

Depending on where you trade you may have obligations to those customers — in
India, the Digital Personal Data Protection Act; in the EU, the GDPR. The app
gives you what you need to meet them:

- Every customer record can be edited or deleted outright
- Reports and customer data can be exported
- Nothing is transmitted to us, so there is no third party to account for

We are not your data processor for the offline application, because we never
receive the data.

One thing that does change this: if you switch on any of the integrations in
[what you can switch on](#what-you-can-switch-on-and-what-it-sends), that
provider becomes a third party you are accountable for. Sending a receipt by
email gives your customer's address to the provider you configured. That may be
entirely proper — it is usually why the customer gave it to you — but it is your
disclosure to make, and the provider's terms are between you and them.

## Questions

- **Privacy questions or a deletion request:** use the privacy contact supplied with your distribution.
- **A security problem:** [SECURITY.md](../.github/SECURITY.md), privately
- **Anything else:** Discussions

## Changes

Material changes to this document are announced in release notes, and the
history is in this repository — you can read exactly what changed and when.
