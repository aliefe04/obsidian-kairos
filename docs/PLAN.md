# Kairos — Product and Engineering Plan

A reminder engine for Obsidian that turns ordinary journal checkboxes into alerts that actually arrive.

```
- [ ] msg to dentist 09:00
```

Written in tomorrow's daily note today, that line alerts at 09:00 — on the desktop, on the phone, and
in the calendar app. No new syntax to learn, no emoji to insert, no companion app to install before
the first alert works.

Status: **Phase 0 complete and verified** (engine + channels + tests + real-app smoke test, §9).
Owner: this repo. Decisions: `docs/decisions.md`. Specifications: `docs/spec/syntax.md`,
`docs/spec/state-model.md`.

---

## 1. The job, and why the existing plugins miss it

The job is small and specific: *I plan tomorrow in today's journal, and I want to be interrupted at
the right minute.* Today's ecosystem splits that job across at least six plugins and apps, each with
its own syntax, and none of them solves it end to end:

| What the user needs | What exists | Where it breaks |
|---|---|---|
| Plain checkbox + time in a dated note | Reminder needs `(@2026-09-11 09:00)`; Tasks has no time field at all; the ntfy plugins need `⏰`/`@remind()`/`#remind` | The syntax is the product's front door, and it is a wall |
| Note date resolved from the journal itself | No plugin resolves a reminder's date from the note it is written in | Users must retype the date inside a file already named after the date |
| Alert while Obsidian is closed, on a phone | Reminder's ntfy mode registers only 24 h ahead ("if Obsidian isn't opened for more than a day… won't notify you"); Remindian is a separate macOS app; Notelert needs a companion app | Missing the alert is the whole failure mode |
| Exactly one alert across laptop + phone | Reminder has an open issue from 2022 asking for reminder state to sync before firing (#85); duplicates are a documented complaint | Silent duplicates train users to ignore alerts |
| Settings that behave the same on both devices | Reminder has no timezone setting at all; wall-clock strings only | A travelling user gets the wrong hour |

The most-repeated complaint in this market is not "the syntax is awkward", it is **"the reminder
never fired"** — and the second is **"it fired twice"**. Both are engineering problems, and both are
solvable. Details and sources: `docs/market.md`.

## 2. Principles

1. **The note is the source of truth.** State files may be deleted without losing a single reminder.
   Only "already fired" and "snoozed" history lives outside the note.
2. **No alert may be silently dropped.** An alert that was due while the app was closed is delivered
   late, with its age stated, or folded into a digest by explicit user choice — never discarded
   quietly.
3. **Degrade, never go silent.** If the cross-device lease is unreadable, fire locally. If the push
   channel is down, show the toast. If a note cannot be date-resolved, say so once instead of guessing.
4. **Interoperate; never own the line.** Kairos reads Tasks, Reminder, Dataview and Kanban syntax and
   writes only `⏰`, so installing it cannot corrupt another plugin's task state.
5. **The platform limits are documented, not hidden.** Where Obsidian makes something impossible, the
   UI says so and offers the nearest honest alternative (`docs/delivery.md`).

## 3. The moat

Five properties the incumbents do not have together. Each is implemented (not planned) unless marked.

| # | Property | Why it is defensible |
|---|---|---|
| 1 | **Zero-ceremony syntax**: bare `HH:mm` in a dated note, plus explicit `@`, `⏰`, `(@…)` forms | The date cascade (§`spec/syntax.md` §2) is the hard part — filename formats, month folders, frontmatter, H1, nearest date heading, and a refusal to guess when `08-09-2026` is ambiguous. A competitor can copy the regex; the cascade and its ambiguity handling are a design commitment |
| 2 | **Four delivery tiers, including one that needs no account, no server and no network** | Desktop OS notification, `.ics` written into the vault for the user's own calendar app, ntfy/Bark/Pushover webhooks, and an optional self-hosted relay. No other plugin in the registry exports reminders *to* ICS ("ICS Calendar" only reads it) |
| 3 | **Alarm-grade reliability semantics**: deterministic instance identity, create-only per-device state files, a lease with fencing, a 60-second dedupe window, and per-reminder catch-up policy | This is where "never fired" and "fired twice" die. Sync-safe file layout is dictated by Obsidian Sync's actual rules (`docs/spec/state-model.md` §4) |
| 4 | **Two severities, grounded in interruption research** | Alarms interrupt; digests batch at a chosen hour. Shipping only alarms is how reminder plugins get uninstalled in week two |
| 5 | **Contribution lanes built into the design**: a channel SDK, locale packs as data-only PRs, and a recipes gallery | Users add LINE/Matrix/Home Assistant/webhook channels and their own language without touching the engine — the ecosystem grows the product while the maintainers sleep |

## 4. Non-goals

- Not a task manager. No projects, priorities, or Gantt views; existing plugins own that.
- Not a calendar UI. Kairos emits `.ics`; it does not render a month grid.
- Not a sync service. Vault data stays in the vault; the only outbound payloads are the ones a user
  configures, and the default payload is a task title.
- No recurrence advancement in v0.1 (`🔁` lines are displayed, never advanced — that stays Tasks' or
  Reminder's job until the ownership question is settled).
- No telemetry, no accounts, no closed-source component.

## 5. Architecture

| Layer | Module | Responsibility |
|---|---|---|
| Parse | `src/parse/{timeTokens,noteDate,parseNote,locales}` | Token grammar, the date cascade, `metadataCache` list items → `ParsedReminder[]` |
| Index | `src/index/indexer.ts` | Incremental vault scan, debounced per-file reparse, ambiguity reporting |
| Schedule | `src/schedule/{engine,time,stateStore}` | Due plan, single next-wake timer, lease, dedupe, catch-up, snooze, durability |
| Deliver | `src/channels/{desktop,ntfy,ics}`, `src/ui/*` | Channel SDK with `local` and `server-scheduled` modes; modal with done/snooze; agenda view |
| Surface | `src/settings.ts`, `src/main.ts` | Declarative settings (searchable), commands, wiring |

Invariants and failure modes: `docs/architecture.md`. Measured limits: §9.

## 6. Delivery

Four tiers, each with an honest statement of what it can and cannot do, and which platform limit
forces it: `docs/delivery.md`. The short version:

| Tier | Covers | Requires |
|---|---|---|
| Desktop OS notification | Obsidian open, focused or not | Nothing |
| `.ics` in the vault | Obsidian **fully closed**, offline, both platforms, native OS alarms | A calendar app the user already has |
| Webhook push (ntfy, Bark, Pushover, …) | Phone alert with Obsidian closed, up to the provider's horizon | A topic/key the user pastes once |
| Self-hosted relay (Phase 3) | Multi-day horizons, no third-party account | Docker or a free-tier worker |

## 7. Community and sustainability

The repo is structured to outlive its author from day one: an organisation rather than a personal
account, CODEOWNERS, an RFC path for changes to the syntax or state model, issue templates, a
contribution lane per channel and per locale, and a release pipeline with provenance attestation.
The distribution path changed in 2026 — submissions now go through the developer dashboard and the
automated review inspects **every** release, not just the first. Full plan: `docs/community.md`.

## 8. Roadmap

Phase 0 (verified, this repo) → Phase 1 (public v0.1: settings polish, agenda view, ICS, ntfy, BRAT
beta, dashboard submission) → Phase 2 (recurrence opt-in, locale packs, digest, more channels,
mobile foreground alerts, iOS Shortcuts recipe) → Phase 3 (self-hosted relay, encryption, calendar
round-trip) → Phase 4 (ecosystem: channel contributions, recipes gallery, integrations).
Acceptance criteria per phase: `docs/roadmap.md`.

## 9. What is verified today

Machine-checked, on this machine, Obsidian 1.13.7:

| Check | Command | Result |
|---|---|---|
| Bundle builds | `npm run build` | pass (`main.js`, 63 KB) |
| Review-guideline lint | `npm run lint` | 0 errors, 0 warnings (`eslint-plugin-obsidianmd`) |
| Type checking | `tsc -noEmit -skipLibCheck` | pass |
| Behaviour | `npx vitest run` | 11 files, **94 tests**, pass |
| Harness contract | `verify_work` | PASS — 4 checks, re-run against the current tree |
| **Real app, end to end** | `npm run smoke` | pass — plugin loads; the note `journal/2026/10-09-2026-Thursday.md` is resolved **from its filename** (daily-note format + folder cross-check) to `dueLocal: 2026-09-10T21:24`; the alert fires **exactly once** through the catch-up path; exactly one delivery notice exists; the rendered notice reads `smoke test · 21:24 · 2 min late · 10-09-2026-Thursday` |

The smoke harness (`scripts/smoke.mjs`) launches a real Obsidian with an isolated profile against a
throwaway vault, creates the note through the vault API, waits for it to appear in the metadata cache,
then drives the app over the Chrome DevTools Protocol and asserts the parsed schedule, the
exact-once guarantee and the rendered alert text. It is dependency-free and is the regression gate for
anything that touches parsing, scheduling or delivery.

The invariant tests were validated by mutation rather than by assertion count: nine deliberate
mutations of the engine in a throwaway clone (arming moved to `due`, lease renewal removed, a refused
claim marked notified, tick-join disabled, a re-created superseded instance forced back to
`scheduled`, `snoozed` no longer skipped, the supersede marker ignored, the prune removed, the title
returned to `messageSummary`) each fail exactly the intended test.

## 10. Defects found before anything was called done

The test suite and the real-app harness found these; each is fixed and pinned by a test or an
assertion. They matter more than the feature list, because "it never fired" and "it fired twice" are
the market's top two complaints and these were all instances of those two failures.

| Defect | How it would have shown up for a user |
|---|---|
| Alerts fired `leadMinutes` early (arming window treated as an early alert) | Every reminder arrives 10 minutes before the time written in the note |
| A snoozed instance could fire again from catch-up | Two alerts for one snooze |
| DST gap/overlap resolved wrongly outside US zones | A 02:30 reminder on a European transition night lands an hour off |
| Snooze rewrite sliced a fixed 5 characters | `9:00am` becomes `09:50m` — the note is corrupted |
| Notes with an unresolvable date were dropped silently | Reminders vanish with no explanation instead of an "N notes could not be date-resolved" notice |
| A snooze was cancelled by the next vault rescan | Snoozing did nothing at all |
| **One reminder delivered three times** in the first real-app run (overlapping ticks, with the instance marked only after the channel was awaited) | Three notifications for one task — and the original `fired.lines > 0` assertion could not see it, so the assertion itself was replaced by `exactly once` |
| The alert text never said *what* the reminder was (`HH:mm · age · note name`), and the desktop fallback path duplicated the title | A 09:00 buzz that does not tell you what to do |

Two of these — the triple delivery and the contentless alert text — were found only by reading the
real app's output, not by unit tests. That is the argument for keeping the smoke harness as a release
gate rather than a convenience script.

A second review pass, after the harness was trustworthy, found five more before release:

| Defect | How it would have shown up for a user |
|---|---|
| The title went *into* `messageSummary` while three surfaces already render it separately | The task name printed twice in the OS notification, the alert window, and the mobile fallback |
| A refused cross-device claim was recorded as `armed` — one state meaning both "we own it" and "we lost it" | Nothing observable broke, but no test could assert either meaning, and the agenda showed a device as armed while another device fired |
| The arming window (10 min) outran the lease TTL (5 min), so the claim lapsed before the due time | Two devices could both fire: the reserved alert was not actually reserved |
| A snooze across midnight wrote the new time into the previous day's note | `23:50 + 30 min` became `00:20` under yesterday's date, re-parsed as a different already-past instance, and alerted a second time |
| A superseded instance deleted from state was re-created by the next rescan and fired at its old time | A snoozed reminder comes back and alerts at the time you snoozed away from |

A third pass over the alert surfaces, after the review above, found three more:

| Defect | How it would have shown up for a user |
|---|---|
| The title-free summary was also used as the *whole* text of the in-app notice after the revert, and three tests pinned that | On mobile — where the notice is the only alert surface — the alert read `21:22 · 3 min late · 10-09-2026-Thursday` with no task name |
| The alert window was gated on `actions`, which is always true, so it opened for digests too | A batched digest delivery popped a window and stole keyboard focus, contradicting the whole point of digests |
| The window setting's copy promised a window for "due alarms" while the code opened one for any delivery with actions | The setting described behaviour the code did not have |

A fourth pass, on the push path, found two more:

| Defect | How it would have shown up for a user |
|---|---|
| The scheduling horizon was seven days while `ntfy.sh` refuses a delay beyond three, so every registration in the 3–7 day window was an HTTP 400 | Far-off reminders never reached the phone, and the README's "with Obsidian closed" claim was really a three-day claim |
| A refused registration was retried on **every** pass, and passes run on every index change, ack, snooze, rescan and start | A quota burn against the provider, with a rate limit as the likely second-order effect — and the doomed requests could crowd out the registrations that would have succeeded |

The fixes are in `docs/decisions.md` §12. Both are now pinned by `tests/schedule.horizon.test.ts`,
which asserts the default, the refusal to register beyond it, the raised-horizon path for a
self-hosted server, the backoff ladder, its ceiling, and that an instance leaving the index stops
being tracked.

The lesson recorded from four rounds: the alert *surfaces* were the least-tested part of a plugin
whose whole purpose is alerting, and the provider *contracts* were the least-checked part of the
delivery path. That is why `tests/channels.desktop.test.ts` asserts the delivery matrix explicitly
(alarm → notification + window; digest → notification only; mobile and fallback → a notice that names
the task) and why `tests/schedule.horizon.test.ts` asserts agreement with the provider's documented
limits, not only with our own behaviour.

## 11. Success metrics

| Metric | Target for v0.1 + 90 days | How measured |
|---|---|---|
| Install base | 2,000 installs in the dashboard | Dashboard analytics |
| Retention proxy | ≥ 60% of installs still enabled at 30 days | Dashboard |
| Reliability | **zero** open issues titled "did not fire" / "fired twice" | Issue labels + triage |
| Mobile delivery adoption | ≥ 25% of installs configure a push or ICS tier | Opt-in diagnostic counter, user-initiated only |
| Community | ≥ 3 external channel or locale contributions merged | Git history |
| Review | Clean automated review on every release | Dashboard |

No telemetry is collected; all six are measurable from the public dashboard, GitHub, or data the
user chooses to share in a report.
