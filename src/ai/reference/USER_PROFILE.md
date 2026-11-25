# Posnic assistant local user notes

The assistant keeps a small Markdown file for each signed-in user on the
computer. It records how that person likes to work and what they ask for
repeatedly, so later conversations fit their style. The notes are not shop
records and are never synced.

## Where the file lives

The file is in the Posnic user-data folder, under:

```
ai/opencode/profiles/user-profile-<hash>.md
```

The hash is derived from the signed-in username. Different accounts on the
same computer get different files. The file is created on the first note; the
assistant can read an empty template before that.

The file is local only. It is not part of the shop database, not included in a
backup of shop data and not sent to another branch or till.

## What the file contains

The file has three sections:

- **Preferences** — lasting choices such as reply length, formatting, or the
  order in which the user likes information.
- **Recurring requests** — tasks the user asks for repeatedly, such as
  checking low stock before a delivery.
- **Language and wording** — the language mix, dialect words, and the terms
  the user uses for products, categories and screens.

Example:

```markdown
# Posnic assistant notes

These notes are kept on this computer for this user. They describe how the
user likes to work and what they ask for repeatedly. They are not shop
records and are never synced.

## Preferences

- Prefers a short answer first, then the details.
- Likes prices and stock on the same line.

## Recurring requests

- Often asks for the closest product match before confirming a price.

## Language and wording

- Uses "صنف" for product and "جرد" for stock count.
- Writes in Egyptian Arabic and keeps product names in Latin script.
```

## Tools

### `posnic_user_profile`

Reads the current user's local notes.

Input: none.

Output:

```json
{
  "kind": "user_profile",
  "exists": true,
  "counts": {
    "preferences": 2,
    "recurring": 1,
    "language": 2
  },
  "text": "# Posnic assistant notes\n..."
}
```

The assistant calls it once at the start of a new conversation. If the file
does not exist, the tool says so and the assistant continues without notes.

### `posnic_update_user_profile`

Adds one short note to the current user's file.

Input:

```json
{
  "section": "preferences",
  "note": "Prefers a short answer first, then the details."
}
```

- `section` is required. It is `preferences`, `recurring` or `language`.
- `note` is required. It is one line, at most 240 characters.

Output:

```json
{
  "kind": "profile_saved",
  "section": "preferences",
  "note": "Prefers a short answer first, then the details.",
  "added": true,
  "duplicate": false,
  "counts": {
    "preferences": 3,
    "recurring": 1,
    "language": 2
  }
}
```

A duplicate note returns `added: false` and `duplicate: true`. The file keeps
at most 20 notes per section and at most 16 KB. Older notes in a full section
are removed first.

## What must never be written

The assistant must not write:

- customer, staff or supplier names;
- phone numbers, emails, addresses or ID numbers;
- prices, costs, stock counts, barcodes or SKUs;
- tokens, passwords, API keys or other credentials;
- one-off requests that are not a lasting pattern;
- anything that changes a shop record.

The main process also rejects notes that look like an email address, an API
key, a bearer token, a password or a long number. The note is rejected, not
silently changed.

## What the notes may be used for

The assistant may use the notes to:

- choose the reply language and the Arabic/Latin mix;
- keep answers short or detailed in the way the user prefers;
- use the user's words for products, categories and screens;
- remember a repeated workflow and offer it sooner.

The assistant must not use the notes as shop facts. A note never proves a
price, a stock count, a category, a permission or a branch. Those answers come
only from the live shop tools.

## Privacy and reset

The note text is sent to the selected model provider as part of the
conversation when the assistant reads it. It is not sent to Groq Whisper and
it is not synced.

To forget everything for one account, close Posnic and delete that account's
`user-profile-<hash>.md` file. A new file is created on the next note.
