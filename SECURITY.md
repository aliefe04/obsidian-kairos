# Security Policy

## What this plugin can touch

Kairos reads your notes, writes at most one time token into a note when you snooze with "annotate in
note" enabled, and writes its own state under `.obsidian/plugins/kairos/state/`. It can send a
delivery payload to a channel that you configure. There is no server component, no telemetry, and no
account.

## Reporting a vulnerability

Do not open a public issue.

Use GitHub's private reporting for this repository:
<https://github.com/aliefe04/obsidian-kairos/security/advisories/new>

Please include:

- the plugin version and your platform,
- what an attacker gains,
- the smallest reproduction you have,
- whether the problem also affects Obsidian itself.

We aim to acknowledge within 72 hours, and to publish a fixed release with a security note once a fix
exists. If you want credit in the advisory, say so.

## Scope

In scope:

- Reading or writing files outside the vault.
- Sending vault content to a channel the user did not configure, or more content than the settings
  say will be sent.
- Escaping the configured payload rules (the default payload is the task title alone).
- Code execution from note content.

Out of scope:

- The absence of background delivery on Obsidian mobile. This is a platform limit, documented in
  `docs/delivery.md`.
- Channel tokens stored as plaintext in `data.json`. Obsidian exposes no secret storage API; this is
  documented in the README and in the settings tab.
- Vulnerabilities in Obsidian, in a push provider (ntfy, Bark, Pushover, Telegram), or in the user's
  sync provider.

## Secrets

There is no secret in this repository. If you believe a credential was committed, report it privately
as above and rotate the credential.
