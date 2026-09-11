# Kairos

Turns dated journal checkboxes into real alerts. An Obsidian plugin; the only runtime
dependency is the Obsidian API itself.

## What it does

A checkbox line inside a date-scoped note can carry an alert time. Kairos resolves the note's
own date — frontmatter `date`/`day`/`created`/`journal-date`, the first H1 that parses as a date,
the nearest preceding date heading, the file name, or the Daily Notes folder — and schedules the
alert for that date at that time. A note dated tomorrow schedules tomorrow.

The alert fires at the due time. Catch-up runs at startup for alarms missed while Obsidian was
closed, quiet hours move a reminder into a digest window, and cross-device firing is decided by a
lease file rather than by a setting.

## Write forms

| Form | Example | Alert time |
|---|---|---|
| Bare time, end of line | `- [ ] msg to dentist 09:00` | note date + `09:00` |
| Bare time, start of line | `- [ ] 09:00 standup` | note date + `09:00` |
| Explicit | `- [ ] call bank @ 2026-09-11 09:00` | the date and time given |

Times are `H:mm` or `HH:mm`, optionally with `am`/`pm` (`9:00am`) or a `.` separator (`9.30`).
Dates are ISO, day-first local forms (`11-09-2026`, `11.09.2026`, `11/09/2026`), month names, or
the relative words `today`, `tomorrow`, `yesterday`, `tonight`. An explicit date with no time uses
the configured default reminder time.

A bare time counts only as the last token of the line (trailing tags, block ids and punctuation
ignored), as the first token after the checkbox, or right after `at`/`@`. Anything else is prose.
A time range (`09:00-10:00`, `09:00 to 10:00`) alerts at its start. Lines inside fenced code
blocks, frontmatter, tables, inline code spans and URLs are never parsed, and neither is a line in
a note that has no date and no explicit date token.

Interoperability, all read-only except where noted:

- `- [ ] report 📅 2026-09-11 ⏰ 2026-09-11 09:00` — Reminder's `⏰` field, with the precedence
  `⏰` > `📅` > `⏳` > `🛫`. Kairos writes only `⏰`, and never writes, rewrites or advances `📅`,
  `⏳`, `🛫`, `🔁`, `➕`, `✅` or Dataview fields.
- `- [ ] pay rent (@2026-10-01 08:30)` — Reminder's own form, read and, on snooze, updated in place.
- `- [ ] pay rent [reminder:: 2026-10-01 08:30]` (Dataview) and `@{2026-10-01}` (Kanban) are read.
- Recurrence (`🔁`) is read for display and never advanced.
- With "annotate in note" off (the default) nothing is written into notes. With it on, a snooze
  rewrites the existing time token in place (`09:00` → `09:50`) instead of adding a second token.

## Install

With **BRAT** (recommended — it also updates itself):

1. Install and enable **BRAT** from Obsidian's community plugin list.
2. In BRAT: **Add Beta plugin** → `aliefe04/obsidian-kairos`.
3. Enable **Kairos** in Settings → Community plugins.

Manually, from a release (`kairos.zip`, or the loose `main.js` and `manifest.json`):

1. Copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/kairos/`.
2. Enable Kairos in Settings → Community plugins.

A manual copy does not update itself; copy the files again after a new release. The release packaging
step also copies `styles.css` when the repository has one; Kairos currently ships none, and
`npm run build` emits `main.js` only.

It is not in the community plugin directory yet.

Requires Obsidian 1.13.0. Desktop and mobile bundles are the same; the mobile app has no OS
notification API available to plugins, so the desktop channel degrades to an in-app notice there.

## Delivery

| Tier | Channel mode | Behaviour |
|---|---|---|
| Desktop OS notification | `local` | Electron notification plus the alert window with Done, Snooze and Open note. Without Electron (mobile, or a failed notification) it raises an in-app notice. |
| ntfy push | `server-scheduled` | `POST` to `<server>/<topic>` with `X-At` so the server holds the push until the due time and delivers it with Obsidian closed. The publish response's message id is remembered; cancel deletes it (`DELETE /<topic>/<id>`), and an unchanged reminder is not published twice. The payload is the task title alone unless "include note name" is enabled. |
| `.ics` export | `local` | Writes an RFC 5545 file (default `kairos.ics`) with `DTSTART;TZID=…` and a display `VALARM`. |

Channel tokens live in `data.json` as plaintext, because Obsidian exposes no secret API and
Electron's `safeStorage` is desktop-only. An ntfy topic name is the secret: treat it as one.

Settings: quiet hours, digest windows, lead time, grace time and the catch-up policy
(`fire_now_with_age`, `fold_into_digest`, `skip_and_mark_missed`), locale, and where state is kept
(plugin folder, or `.kairos/` in the vault when you want other sync tools to carry it).

## Differences from Reminder and Tasks

- The alert time can come from the note's own date (the bare-time forms). Neither Reminder nor
  Tasks resolves a reminder from the note's date.
- Kairos writes only `⏰`, and only when "annotate in note" is enabled; the other plugins' fields
  are left byte-for-byte alone.
- Recurrence is not advanced: a `🔁` line is parsed for display only.
- Identity is derived from vault id, note path, block id when present, and the due wall clock
  (`sha256` over those fields). Editing a title therefore keeps the fired history, while moving the
  time creates a new instance — which is what makes a snooze a new reminder rather than a flag.
- Reminder state lives in per-device files under the plugin directory, not in a shared JSON list,
  and not in the note.
- Catch-up, quiet hours and digest windows are part of the alarm path rather than separate
  commands.

## Development

```
npm install
npm run dev        # esbuild watch, writes main.js
npm run build      # typecheck, then the production bundle
npm test           # vitest run (tests/**)
npm run lint       # eslint
npm run smoke      # real Obsidian against .testvault over CDP (macOS: /Applications/Obsidian.app)
```

The specs are in `docs/spec/syntax.md` (what is written in a note) and `docs/spec/state-model.md`
(instances, scheduling, storage and sync). Recorded design decisions are in `docs/decisions.md`.

## Documentation

| Document | Content |
|---|---|
| `docs/setup.md` | **Configure delivery**: desktop, ntfy on the phone, calendar file. Start here as a user. |
| `docs/faq.md` | **User questions**: the locked phone, a missed alert, a double alert, privacy |
| `CONTEXT.md` | The words this project uses, and the words it avoids. Start here as a contributor. |
| `CONTRIBUTING.md` | Build, test, and the four contribution lanes (channel, locale, recipe, test) |
| `CHANGELOG.md` | What changed, and what is known to be limited |
| `SECURITY.md` | Private reporting, and what counts as in scope |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 |
| `docs/PLAN.md` | The plan: the job, the advantage, the roadmap, the metrics |
| `docs/market.md` | The competing plugins, and the defects they report |
| `docs/delivery.md` | How an alert reaches a person, and what each tier requires |
| `docs/architecture.md` | Modules, invariants, testing, and the rejected dependencies |
| `docs/risks.md` | The risk register, and the questions that are still open |
| `docs/spec/` | The two frozen contracts |
