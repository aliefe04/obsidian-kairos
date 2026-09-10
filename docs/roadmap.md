# Roadmap

Each phase has an exit criterion that can be checked by someone other than the author. Phases do not
overlap: a phase is done when its criterion is met on the released version.

---

## Phase 0 — Engine spike ✅ done and verified

**Delivered:** token grammar, date cascade, engine with lease/dedupe/catch-up, desktop + ntfy + ICS
channels, declarative settings tab, alert modal, agenda view, commands, CI workflows, 75 tests, and a
real-app smoke harness.

**Exit criterion (met):** `npm run build`, `npm run lint` (zero warnings), `tsc --noEmit`,
`npx vitest run` (75 tests) all pass; `npm run smoke` drives real Obsidian 1.13.7 to load the plugin,
parse `- [ ] smoke test 21:07` from a dated note, fire the alert through the catch-up path
(`ageMinutes: 3`), write the fired record with `dueLocal: 2026-09-10T21:07`, and render an in-app
notice.

**Defects found and fixed on the way** (each pinned by a test): an alert firing `leadMinutes` early; a
snoozed instance able to fire twice; DST gap/overlap resolved wrongly outside US zones; a time rewrite
truncating `9:00am` to `09:50m`; ambiguous notes silently discarded; a snooze cancelled by the next
rescan. This is the evidence that the reliability thesis is testable rather than aspirational.

## Phase 1 — Public v0.1

The smallest release that a stranger can install and trust.

| Deliverable | Acceptance |
|---|---|
| Performance benchmark script + published numbers in `docs/perf.md` | 10k notes / 50k items cold < 1.5 s, and an incremental edit affects only its file |
| Agenda view polish (Today / Tomorrow / Next 7 days / Overdue, click to open, snooze inline) | A user can see every upcoming alert in one place without a query language |
| ICS tier end-to-end | An imported/subscribed `kairos.ics` fires a native calendar alarm on iOS and Android with Obsidian closed; documented refresh caveats |
| ntfy tier end-to-end on a real phone | A reminder set for tomorrow morning arrives with Obsidian closed overnight |
| Snooze writes through to the note (default) | Snoozing on one device is visible on another after sync |
| Diagnostics command + redacted report template | Issue reports contain version, platform, index size, last 50 state transitions, no vault content |
| README comparison table vs Reminder/Tasks | Contains only shipped behaviour |
| BRAT beta + dashboard submission | Automated review passes on the first submission; plugin installable from the directory |
| Docs site skeleton (VitePress) with syntax, tiers, FAQ | A user can answer "will it alert with my phone locked?" without reading source |

**Exit criterion:** v0.1 installed from the community directory, and 14 days with no open issue
reported as "did not fire" or "fired twice".

## Phase 2 — Depth

| Deliverable | Acceptance |
|---|---|
| Opt-in recurrence on individual lines (rrule text, "when done" semantics) | A recurring task advances without ever double-advancing a Tasks-owned `🔁` line; explicit warning when both plugins target the same line |
| Locale packs: `en`, `tr` shipped; community PRs for `de`, `es`, `fr`, `pt` | A locale pack is a data-only diff plus fixtures; no parser edit |
| Digest mode with quiet hours | A day of reminders can arrive as one 08:00 digest; quiet hours always defer |
| Channels: Bark, Pushover, Telegram, generic webhook | Each with a Test button, title-only default, and its constraint stated in the UI |
| Mobile foreground alerts + catch-up on resume | Opening Obsidian on a phone shows missed alerts as a digest, never as a burst |
| iOS Shortcuts recipe (zero-server path) | Documented automation that reads a Kairos-generated agenda file from the vault and posts a local notification; **field-validated on a device before it is documented as working** |
| Channel SDK documentation + template repo | An external contributor adds a channel without maintainer help |

**Exit criterion:** ≥ 3 external contributions merged (channel or locale), and mobile delivery
configured by ≥ 25% of installs.

## Phase 3 — Guaranteed delivery, still accountless where possible

| Deliverable | Acceptance |
|---|---|
| Self-hosted relay (opt-in, container) using `obsidian-headless` or a vault-watching worker | Multi-day horizons without a third-party account; its own security review; documented threat model |
| Payload encryption for push channels | A channel can carry an opaque payload that only the user's device can read |
| Calendar round-trip | Completing an event in the calendar app can reflect back into the note, conflict-safe |
| Cross-device lease hardening | Two devices, one vault: exactly one alert, proven by a two-profile integration test |

## Phase 4 — Ecosystem

- Recipes gallery (journal workflows: day-ahead planning, weekly review, medication, shift work) with
  each recipe as a small documented note — this is also the SEO surface.
- Integrations that read Kairos state: Dataview/Bases views, a status-bar countdown, a mobile widget.
- Maintainer team: 2+ committers with release rights, documented on-call expectations, and an RFC
  process for syntax or state-model changes.
- Annual "state of the plugin" post with install numbers, reliability metrics, and what was cut.

## Explicitly out of scope

- A companion mobile app with APNs/FCM (See `docs/delivery.md` §T4: ntfy/Bark already solve this).
- Becoming a task manager, project planner, or calendar UI.
- Any hosted service that processes vault content by default.
