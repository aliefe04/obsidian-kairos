# Kairos — Reminder Syntax Spec

Status: **frozen for v0.1** · Owner: maintainers · Supersedes: nothing

Design rule: **the plugin must never require you to learn a syntax to get an alert.**
Writing must stay valid Markdown, stay valid for the Tasks and Reminder plugins, and stay readable
if Kairos is uninstalled tomorrow. Everything Kairos writes must be understandable in five years
without the plugin.

---

## 1. Write side — what a human types

Four forms, ordered by how often we expect them. Forms A and B are the differentiator: no other
plugin resolves a reminder from the *note's own date*.

| # | Form | Example | Alert time |
|---|------|---------|-----------|
| A | **Bare time, end of line** inside a date-scoped note (§2) | `- [ ] msg to dentist 09:00` | note date + `09:00` |
| B | **Bare time, start of line** | `- [ ] 09:00 standup with the team` | note date + `09:00` |
| C | **Explicit absolute**, `@`-prefixed or emoji-prefixed | `- [ ] call the bank @ 2026-09-11 09:00`<br>`- [ ] call the bank ⏰ 2026-09-11 09:00` | the date/time given |
| D | **Interop forms** already used by other plugins (read-only, see §4) | `- [ ] pay rent (@2026-10-01 08:30)`<br>`- [ ] report 📅 2026-09-11 ⏰ 2026-09-11 09:00` | per §4 precedence |

Time token grammar (`T`): `H:mm` or `HH:mm` (24h), optional `am`/`pm` suffix, optional `.` separator
(`9.30`). Accepts `9:00`, `09:00`, `9:00am`, `09:00 PM`.

Date token grammar (`D`): ISO `YYYY-MM-DD`; local `DD-MM-YYYY` and `DD.MM.YYYY` and `DD/MM/YYYY`;
month names `11 Sep 2026`, `Sep 11 2026`, month names in the vault's UI language; relative
`today`, `tomorrow`, `yesterday`, `tonight` (locale packs, §6).

Date-only explicit form (`@ 2026-09-11`) means *that day at the configured default reminder time*
(default `09:00`).

### Boundary rules (false-positive guards)

A **bare** time (forms A/B) counts only when the token is:

1. the last token of the line (trailing `#tags`, `^block-id`, and closing punctuation ignored), **or**
2. the first token after the checkbox, **or**
3. immediately preceded by `at ` or `@`.

Anything else is prose and is ignored: `- [-] discuss whether 09:00 works for the call` sets no
reminder. An optional "aggressive mode" setting relaxes rule 1–3 to any mid-line time; it ships
**off** and is documented as noisy.

A bare time inside a **time range** (`09:00-10:00`, `09:00 – 10:00`, `09:00 to 10:00`) is a block:
the alert fires at the **start**, and the end is recorded for the agenda view.

Rejected contexts (never parsed): lines inside fenced code blocks, YAML/TOML frontmatter, HTML
blocks, tables, or inline code spans; URLs (`https://host/9:00`); lines that are not list items;
list items in notes that are not date-scoped unless they carry an explicit date (form C/D).

## 2. Date-scoped notes

A note is *date-scoped* if exactly one of these resolves, in this order:

1. **Frontmatter** — `date`, `day`, `created`, or `journal-date`, parsed as a date.
2. **H1** — first heading whose text parses as a date (`# Fri, Sep 11`).
3. **Nearest preceding heading** that parses as a date — this is the key case for one-note-per-month
   journals (`## 2026-09-11` followed by the day's tasks).
4. **File name** matched against the configured formats, in order. Defaults:
   `YYYY-MM-DD`, `DD-MM-YYYY`, `YYYY/MM/DD-MM-YYYY-dddd`, `YYYY/MMMM/DD-MM-YYYY-dddd`,
   `DD.MM.YYYY`, `YYYYMMDD`. Parent folder names are also tried, which is what makes
   `04 - Journal/2026/08/24-08-2026-Monday.md` resolve (folder `2026`, file `24-08-2026-Monday`).
5. **Configured Daily Notes folder + format** (`YYYY/MM/DD-MM-YYYY-dddd`) used as a cross-check to
   disambiguate `DD-MM` vs `MM-DD` (a file inside the daily-notes folder with `24-08-2026` is
   unambiguously day-first because the note's own year/month folders corroborate it).

Ambiguity is resolved by corroboration, never guessed silently: if `08-09-2026` cannot be
disambiguated, the note is treated as *not* date-scoped and the ambiguity is surfaced once in the
inbox view ("3 notes could not be date-resolved").

Notes with a date in the **future** are the "day ahead" workflow: opening tomorrow's daily note
today and writing `- [ ] msg to dentist 09:00` schedules tomorrow 09:00.

## 3. Checkbox semantics

- `- [ ]`, `- [/]`, `- [?]` (any status character other than a completing one) → reminder is **live**.
- Completing characters (`x`, `X`, `-`) → reminder is **cancelled**; no alert, and a pending
  scheduled push is cleared.
- Custom statuses (e.g. `- [>]` for forwarded) are live by default; the completing set is
  configurable.
- The reminder follows the line, not the offset: editing, indenting, moving, or reordering the line
  re-keys it. Only the block id (when the user writes `^block-id`) makes identity stable across
  renames and duplicates.

## 4. Interop contract (non-negotiable)

Verified behaviour of the incumbents — Kairos must not break it:

- `⏰` is **not** a Tasks emoji field; it is the Reminder plugin's extension. Tasks has no time
  field at all.
- Reminder's rule: **nothing but the date/time may sit between `⏰` and `📅`.** Kairos preserves
  adjacency whenever it edits a line that contains both.
- Precedence when several fields exist: `⏰` > `📅` > `⏳` > `🛫`.
- Kairos **writes only `⏰`** (plus our own bookkeeping, §5). It never writes, rewrites, or advances
  `📅`, `⏳`, `🛫`, `🔁`, `➕`, `✅`, or Dataview inline fields — those belong to Tasks or Reminder,
  and two plugins advancing one line is how users get double-advanced or duplicated tasks.
- Reminder's own form `(@YYYY-MM-DD HH:mm)` is read and, when Kairos snoozes, updated in place.
- Dataview `[reminder:: 2026-09-11 09:00]` and Kanban `@{2026-09-11}` are read.

## 5. Bookkeeping Kairos writes (optional, off by default)

Under sync, a checkbox flip on the phone and a snooze on the laptop genuinely conflict, and Obsidian
Sync merges `.md` files with `diff-match-patch`, which can duplicate text. To keep that rare:

- Default: **no bookkeeping written into user notes.** All state lives in the plugin's state files
  (`docs/spec/state-model.md`).
- Optional "annotate in note": on snooze, Kairos rewrites the existing time token in place
  (`09:00` → `09:50`) rather than adding a second token. Only if no writable token exists does it
  append `⏰ <new time>`.
- Never written: creation timestamps, fire counters, device names, sync markers.

## 6. Locale packs

Relative-date words, weekday names, month names and the `am`/`pm` equivalents come from a
**locale pack** (`src/parse/locales/<tag>.ts`), not from a dependency. Rationale: `chrono-node`
ships no Turkish support, bundle size matters on mobile, and a 20-line dictionary is something a
user can contribute in one PR — which is exactly the contribution lane we want open.

Packs shipped in v0.1: `en`, `tr`. Community packs land as data-only PRs with a fixture test.

## 7. What we do not parse (and say so)

- Recurrence phrasing in v0.1 (`every monday`, `🔁`) is **read for display, never advanced**;
  advancing a `🔁` line is Tasks' or Reminder's job. Recurrence support is Phase 2 and will be
  explicitly opted in per line.
- No dependencies in notes (`- [ ] x 09:00 after #food`) — a later phase, and read-only.
- No reminders in canvas files, PDFs, or non-Markdown files.

## 8. Test matrix (each line is a required test)

Inline forms: bare end-of-line · bare start-of-line · `at 09:00` · trailing `#tag` · trailing
`^block-id` · time range · `9am`/`9:00 PM` · `9.30` · two times on one line · mid-line time ignored ·
`https://x/9:00` ignored · inline code span ignored.

Note-date cascade: frontmatter date · H1 date · nearest preceding date heading · filename
`DD-MM-YYYY` · folder-corroborated day-first · ambiguous `08-09-2026` → refused · monthly-journal
headings · file with no date and no explicit token → ignored.

Checkbox/identity: custom status char · completing char cancels · `>`-prefixed callout list ·
numbered list · nested indentation · duplicate titles in two files · rename (re-key) · move between
folders · delete · line edited while a push is pending · block id stable.

Time: DST spring forward · DST fall back · device timezone change · `00:00` and `23:59` ·
snooze across midnight · leap day · `Feb 30` invalid → refused · clock skew between devices.
