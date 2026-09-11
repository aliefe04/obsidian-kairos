# Risks and Open Questions

Two lists: risks we manage, and questions we have not answered yet. The second list matters more —
each item names the experiment that would settle it.

---

## 1. Risk register

| # | Risk | Likelihood | Impact | Mitigation | Trigger to act |
|---|---|---|---|---|---|
| R1 | **The mobile promise is misunderstood** — a user reads "reminders on your phone" and expects push with zero setup | High | High | Delivery tiers are stated in the README, in the settings tab at the point of configuration, and in a `docs/delivery.md` FAQ ("will it alert with my phone locked?"). The first-run flow leads to the tier that works with no account (ICS) and marks the push tiers as *requires one paste* | Any issue/review that says the plugin "doesn't notify on mobile" |
| R2 | **ICS tier under-delivers** because calendar clients refresh subscribed feeds on their own cadence | Medium | Medium | Position ICS as the offline/no-account backstop and ntfy as the to-the-minute tier; measure and publish the refresh behaviour per client before v0.1 ships | Field test shows > 1 h median refresh on iOS or Android |
| R3 | **Sync conflicts corrupt state** (Obsidian Sync: non-md is last-write-wins, markdown merges can duplicate text) | Medium | High | Create-only, per-device state files; the note is authoritative; every in-note write re-verifies the line inside one atomic `Vault.process`; a two-profile integration test before every release | Any duplicate or missing fired record reproduced with two devices |
| R4 | **Cross-device dedupe fails when `.obsidian` is not synced** (iCloud/OneDrive/Syncthing users) | Medium | Medium | Fire locally rather than go silent; offer a vault-folder state location; document the trade-off in the setting itself | Field reports of duplicate alerts on one vault |
| R5 | **Performance on very large vaults** (10k+ notes) regresses | Medium | High | Prefilter on `metadataCache`; never scan at `onload`; yield between files; benchmark before v0.1 | Cold scan > 1.5 s or any UI hitch in a 10k-note vault |
| R6 | **Review rejection or a policy change** (the 2026 dashboard review scans every version) | Medium | Medium | `eslint-plugin-obsidianmd` in CI at zero warnings; disclose remote services; no telemetry, no obfuscation, no default hotkeys; keep `versions.json` correct | Any review comment; treat it as a release blocker |
| R7 | **Maintainer burnout** (this market has abandoned plugins everywhere) | Medium | High | Org ownership, two committers, RFC + triage policy, external contribution lanes that do not require core changes, explicit scope refusals | Open-issue count > 40 with no closure in 60 days |
| R8 | **Syntax drift**: a future Tasks/Reminder change makes our interop claim false | Medium | Medium | We write only `⏰` and re-verify the interop contract in `docs/spec/syntax.md` §4 on every dependency-touching release; a compatibility test file lives in the sample vault | Either plugin changes its emoji set or ordering rule |
| R9 | **Third-party channel breakage** (ntfy/Bark/Pushover API change) | Medium | Low | Each channel has a Test button and reports its own errors into the diagnostics ring buffer; a channel failure never blocks local delivery | Any channel error rate reported twice in a week |
| R10 | **A fork fragments the user base** (as happened with Day Planner) | Low | Medium | MIT license, org ownership, public roadmap, and a documented path for large features to land upstream before someone forks | A fork gaining > 500 installs |
| R11 | **Timezone/DST bugs are silent** — the market's unowned risk | Medium | High | Two-probe DST resolution with explicit gap/overlap semantics, zone stored per instance, zone-change re-registration, and unit tests naming the zones | Any report of an alert at the wrong hour |
| R12 | **The `leadMinutes` setting is misread** as "notify me early" | Medium | Low | The settings description states it is an arming window; an actual advance-notice feature is a Phase 2 decision (see Q3) | Confusion in issues or reviews |
| R13 | **A push provider refuses a registration and the client keeps asking** — ntfy.sh rejects a delay beyond three days, and passes run on every index change, ack, snooze, rescan and start | Was High, now Low | Medium | The horizon defaults to the provider's limit, a refusal backs off exponentially to a 6-hour ceiling, and the deferred instances are reported rather than silently dropped. `ServerScheduleResult.deferred` is the observable | Any `deferred` count that stays above zero for a reminder already inside the horizon |
| R14 | **The push provider neither replaces a pending message nor lets a sequence-keyed one be cancelled** — `ntfy.sh` delivers a repeat `X-Sequence-ID` publish as a second message, and a message published *with* `X-Sequence-ID` cannot be cancelled by any key: `DELETE` by message id and by sequence id both answer `200`, yet the scheduled message is delivered. Even the message-id delete lands for only some HTTP clients: probed 2026-09-11, `curl` cancelled 5 of 5 and Bun 6 of 6, while node v24's `fetch` (undici) cancelled 0 of 3 with `200` on every delete | Confirmed (was High) | Medium | Cancel by the message id the publish returned, persisted on the instance record, one entry per channel (`pushIds`/`pushFor`); an unchanged reminder is never re-published, so one registration cannot become two pushes, and the publish carries no `X-Sequence-ID`, so the working cancel key is never poisoned. The docs state the delete as best-effort and never promise a quiet phone. What would settle the client question: a probe through Obsidian's own `requestUrl` — Electron/Chromium's stack, not undici — against a real scheduled push on a real topic. Probed 2026-09-11 (ADR 12) | Any duplicate push, or a cancelled push that still arrives — including a report of a completed task buzzing the phone. Worth an upstream `ntfy` report so the documented behaviour and the observed behaviour are reconciled |

## 2. Open questions, with the experiment that answers each

| # | Question | Experiment | Decision if confirmed / refuted |
|---|---|---|---|
| Q1 | Does a **iOS Shortcuts personal automation** reliably read the vault file and post a local notification at a chosen time, with Obsidian closed? (Obsidian staff confirmed time-of-day automations do not *run the app*, but a Shortcut posting a notification needs no app launch) | Build the recipe on a real iPhone with an iCloud-synced vault; run for 3 days | Confirmed → ship it as the zero-server iOS tier and lead the mobile story with it. Refuted → say so publicly and point to ntfy |
| Q2 | What is the **actual refresh latency** of a subscribed/imported `.ics` on iOS Calendar and Google Calendar? | Publish a feed that changes hourly, observe for 48 h on both | Drives the exact wording of the ICS tier and whether a local-network publishing step is needed |
| Q3 | Do users want a **true advance notice** ("10 minutes before") in addition to firing at the due time? | Ask in the v0.1 release thread; count requests | Add `advanceMinutes` as a per-reminder modifier, distinct from the arming window |
| Q4 | Is `obsidian-headless` a viable **relay host** for Phase 3, given it is open beta and not a plugin host? | Spike a container that reads a synced vault and posts to ntfy; measure on a 3-day horizon | Feasible → build the relay on it. Not feasible → a vault-watching worker with the user's own sync client |
| Q5 | Does **two-device dedupe** hold in practice with Obsidian Sync, including flaky connectivity? | The two-profile protocol in `docs/architecture.md` §7 run before every release, plus a second run with sync disabled on one side | Keep the lease. If it flaps, fall back to per-device firing plus a visible "also fired on your phone" note |
| Q6 | Does the **date cascade produce false positives** on real vaults (prose that looks like a date, daily-note format drift)? | Run the parser over three volunteer vaults (with permission, read-only output: counts only) | Drift found → tighten the default formats and improve the ambiguity inbox |
| Q7 | Is `Notice`-based alerting sufficient on mobile foreground, or do we need a modal? | Ship the notice default; measure dismissals via a user-reported survey | Notice sufficient → keep it quiet. Not → modal for alarm-grade only |

## 3. Assumptions that are currently unverified

- **[INFERENCE]** The `.ics` tier will actually fire an OS alarm on a phone with Obsidian closed. The
  mechanism is standard (`VALARM`), but no field test has been run — Q2 is the gate, and the roadmap
  makes the ICS tier's exit criterion field validation, not code completion.
- **[INFERENCE]** ntfy's server-side scheduling window (default max 3 days, 12 h cache) is enough for
  a multi-day journal workflow with a rolling re-registration on every app open. The plugin registers
  ahead; the honest user-visible statement is the horizon, not a promise.
- **[REPORTED]** The performance target (10k notes < 1.5 s) is a target, not a measurement; the
  benchmark is a Phase 1 deliverable.
- **[INFERENCE]** Locale packs make non-English use viable. Turkish is shipped as the proof that this
  works without `chrono-node`; no user testing has happened yet.
