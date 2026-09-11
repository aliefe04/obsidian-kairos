# Decisions

Architecture decision records for choices that are load-bearing, or that a reader would otherwise
try to reverse. Each entry states the decision, what was considered instead, and what follows from
it. New entries go at the end.

## 1. No runtime dependency beyond `obsidian`

- **Decision:** `package.json` declares no `dependencies`. `obsidian` and the tooling are
  devDependencies. SHA-256 lives in `src/parse/instanceId.ts`, and the plugin uses `Intl` for zone
  data.
- **Alternatives:** `chrono-node` for date parsing, plus `luxon`/`date-fns` for zone math;
  `node:crypto` or `crypto.subtle` for hashing.
- **Consequence:** the bundle stays small and loads on mobile, where `node:crypto` does not exist
  and `crypto.subtle` is async and unavailable in some renderer contexts. The cost is that zone
  support equals whatever the runtime's `Intl` knows, and any future need for a library is a
  deliberate change to this record.

## 2. Hand-written locale packs instead of a date-parsing library

- **Decision:** `src/parse/locales/<tag>.ts` are data modules — relative words, weekday and month
  names, `am`/`pm` equivalents, and the words that introduce a time. `getLocalePack` keys on the
  primary subtag, so `tr-TR` finds `tr`. v0.1 ships `en` and `tr`.
- **Alternatives:** `chrono-node`, which ships no Turkish support and carries a locale table per
  language; or per-language grammar rules in code.
- **Consequence:** adding a language is a data-only change plus a fixture test against the same
  cases the `en` pack covers. A language whose pack does not exist is simply not supported, and a
  pack that is missing a word fails visibly in that language rather than silently elsewhere.

## 3. Wall clock plus IANA zone instead of epochs

- **Decision:** a reminder's due time is `YYYY-MM-DDTHH:mm` in local wall clock. A record also
  stores `tzId` and the `utcOffsetMinutes` captured with it. Instants are computed on demand in
  `src/schedule/time.ts`, by probing the zone offset a day either side of the target.
- **Alternatives:** store epoch milliseconds (a promise about a timezone the user may leave);
  store UTC and render local; store only an offset.
- **Consequence:** "9am" survives a flight and a DST change, and offset drift is detectable because
  both the zone and its captured offset are stored. The gaps are explicit: a spring-forward wall
  clock has no instant, so `02:30` resolves to `03:30`; a fall-back overlap has two, and the earlier
  instant is the one a clock reading that wall time means.

## 4. Per-device, create-only state files instead of one shared JSON

- **Decision:** state is one file per purpose under `state/` — `instances/<id>.json` (created once,
  then rewritten atomically), `acks/<id>.<deviceId>.json` (create-only),
  `lease/<id>.json` (the only contended file), `fired/<deviceId>-<yyyymmdd>.jsonl` (append-only, per
  device), `devices/<id>.json` (heartbeat). `data.json` holds flat scalar settings only.
- **Alternatives:** one `state.json` for every reminder; keeping the reminder list in `data.json`;
  writing state into the notes.
- **Consequence:** Obsidian Sync merges Markdown with `diff-match-patch` (which can duplicate text)
  and resolves non-Markdown files last-writer-wins, so any file with two writers is a silent
  data-loss bug. One writer per file removes that class of conflict. Deleting `state/` costs only
  "already fired" and "snoozed" history, because the note is the source of truth.

## 5. A single recomputed next-wake timer

- **Decision:** every tick recomputes the due set from the index (`computeDuePlan`) and reports
  `nextWakeAt`. The plugin keeps one `setTimeout` armed to the earliest wake time and re-arms it
  after every index change.
- **Alternatives:** one timer per reminder; a fixed-interval poll; counting ticks.
- **Consequence:** timer count does not grow with the number of reminders. A hidden window cannot
  cause a missed alarm, because Chromium clamps background timers to at least a second and then to
  roughly one call per minute — tick counts are meaningless, tick wall clock is not.

## 6. A separate `server-scheduled` channel mode for ntfy

- **Decision:** `DeliveryChannel.mode` is `local` or `server-scheduled`. Only the
  `server-scheduled` channels are mirrored from the live index by `syncServerScheduled`, which
  sends every instance due inside the horizon and clears any pending push whose instance left the
  index. `ChannelRegistry.deliverScheduled` filters on the mode, so a local channel is never asked
  to schedule anything.
- **Alternatives:** treating ntfy like any other channel and sending from the tick (the push then
  only covers a running device, which defeats the purpose); running our own push service.
- **Consequence:** a closed laptop still receives the push, because the server is holding it. The
  costs are deliberate: re-sends are tolerated because the payload carries the instance id, and
  nothing beyond the horizon is mirrored — three days by default, which is `ntfy.sh`'s documented
  maximum delay (§12 explains the limit, the backoff and its clamp).

## 7. `leadMinutes` is an arming window, not an early alert

- **Decision:** inside `[due - lead, due)` a record is moved to `armed` and this device claims the
  lease; delivery happens at `due` and not before. `computeDuePlan` keeps those records in
  `plan.arming`, separate from `plan.due`.
- **Alternatives:** alerting at `due - lead`, which is what a "remind me ten minutes before"
  reading of the setting would produce; or keeping `lead` purely cosmetic.
- **Consequence:** cross-device single-fire is decided before the alarm, so two devices do not both
  open an alert window, and no setting can make an alert early. The setting's name is the price: it
  reads like an early alert, and its description says what it actually does.

## 8. Ticks are serialized, and an instance is claimed before the channel is awaited

- **Decision:** `ScheduleEngine.tick()` joins an in-flight tick instead of starting a second one, and
  `deliver()` records the instance in the fired log *before* awaiting the channel (the mark is not
  rolled back; a failed send is reported, not retried forever).
- **Alternatives:** trusting that `tickNow()` callers cannot overlap; marking the instance only after
  the channel returns.
- **Consequence:** exactly one alert per instance even though ticks arrive from five places (the
  interval, the wake timer, a rescan, an ack, a snooze) and delivery is slow (an OS notification, a
  network POST). This was a real defect: the first real-app smoke run delivered one reminder three
  times, and the original `fired.lines > 0` assertion could not see it. The harness now asserts
  `matching === 1` and exactly one delivery notice, so the regression cannot return silently.

## 9. `messageSummary()` stays title-free; each surface composes the title once

- **Decision:** `messageSummary()` emits `HH:mm · age · note name` and never the title. The title is
  composed where a surface has no title of its own — the delivery notice in `main.ts`, the channel's
  own notice text in `desktop.ts`, the ntfy `X-Title`, the notification's `title` field, the modal
  heading.
- **Alternatives:** putting the title inside the summary (tried first, reverted). It reads well in
  the notice and prints the task twice everywhere else: the desktop channel renders
  `${title} · ${summary}` in its fallback text, the OS notification carries the title as `title` and
  the summary as `body`, and the modal shows a heading plus the summary paragraph.
- **Consequence:** the notice reads `call the dentist · 21:13 · 1 min late · 10-09-2026-Friday` while
  the notification and the window each show the task exactly once. Two follow-on rules: the alert
  window is gated to `severity === "alarm"`, because a digest is the non-interruptive path and the
  window takes keyboard focus; and the notice text is composed at *every* call site that has no title
  of its own, since on mobile that notice is the only alert surface there is. No test pinned the old
  format, so the duplication would have shipped silently on three surfaces — it was caught by reading
  the real notice out of the smoke run. `docs/PLAN.md` §10 records both rounds.

## 10. A snooze successor owns its time through `supersedes`, not through a counter

- **Decision:** `snooze()` writes the predecessor as `snoozed` and gives the successor
  `supersedes: <predecessorId>`. `sync()` derives a `superseded` set from those links; an
  index-derived instance in that set is forced to `snoozed` so it can never fire beside its
  successor. A `snoozed` record that is absent from the index is pruned, because its old time has
  left the note and nothing can re-create it. `snoozed` rows are hidden from the agenda and from the
  `.ics` export.
- **Alternatives:** `snoozeCount > 0` as the marker (it is also the user-visible tally, and an
  annotate-mode re-parse produces a fresh count-0 record while the old one is spared, so both stay
  live); always rewriting the note (intrusive by default, and impossible to express across midnight);
  keeping predecessors forever (every snooze would leave an inert instance file that the tick
  re-iterates).
- **Consequence:** snoozing is durable with annotation off — the default — and the note keeps saying
  the original time while the state-owned successor fires at the new one. Two follow-on rules came
  out of the same review: the in-note rewrite is skipped when the snooze crosses midnight (writing
  `00:20` under yesterday's date would re-parse as a different, already-past instance and alert a
  second time), and the arming window renews its claim on every pass instead of shortening the
  user's `leadMinutes` to fit the 5-minute lease TTL.

## 11. A refused claim leaves the record eligible

- **Decision:** `armed` means "this device holds the claim and is waiting for `due`" (spec §3). When
  another device owns the claim the record stays `scheduled`, is reported in `TickResult.blockedByLease`,
  and is retried on the next tick.
- **Alternatives:** marking a refusal as `armed` (what shipped first — it made one state mean both
  "we own it" and "we lost it", so no test could assert either), or as `notified` (which would go
  silent and never fire even after the other device released the claim).
- **Consequence:** cross-device arbitration is observable and testable: `blockedByLease` is the signal,
  and the losing device still fires if the winner never does.

## 12. Server-side scheduling is bounded by the provider, and a refusal backs off

- **Decision:** the horizon is a setting, `serverScheduleHorizonDays`, defaulting to **three days** —
  `ntfy.sh`'s documented maximum delay (`message-delay-limit`). A reminder due beyond the horizon is
  not registered at all. A refused registration is remembered with an exponential delay (1 minute,
  doubling, capped at 6 hours) and reported in `ServerScheduleResult.deferred` instead of being
  retried on every pass.
- **Alternatives:** the seven-day horizon this shipped with (every registration in the 3–7 day window
  is an HTTP 400, and the pass ran on every index change, ack, snooze, rescan and start — a quota
  burn against `ntfy.sh`, with a rate limit as the likely second-order effect); retrying until the
  reminder comes inside the limit (the same quota burn, slower); giving up permanently after one
  refusal (a transient network error would then silence an alert for good).
- **Consequence:** the README's "with Obsidian closed" promise is now honest at three days on the
  default server, and a self-hosting user can raise it in the settings. The horizon is read from the
  live settings object, which `setControlValue` mutates in place, so a change applies on the next pass
  without rebuilding the engine. Six tests pin the horizon and the backoff ladder, including that a
  jump of exactly the cap length retries and that an instance which leaves the index stops being
  tracked.
- **The header form is part of the contract, and it shipped wrong.** `X-At` accepts an absolute Unix
  timestamp or a duration carrying a unit; a bare integer is neither. This sent a count of seconds
  (`"3600"`), which the server refused with `400 invalid delay parameter` — every registration failed,
  so the tier that exists to alert a phone with the app closed had never scheduled a single alert,
  while the desktop alert made the failure invisible. The fix is an absolute timestamp, verified
  against `ntfy.sh` by posting both forms and confirming the accepted one arrived at the second it
  named. The test that came with the defect asserted the rejected form, which is the general lesson:
  an assertion written from the implementation pins the bug rather than the protocol.
- **`X-Sequence-ID` does not update or cancel a pending scheduled message, so the plugin persists the
  message id instead.** Probed against `ntfy.sh` on 2026-09-11: publishing a second message under the
  same sequence id — header form or URL-path form — delivers both copies rather than replacing the
  pending one; `DELETE /<topic>/<sequence id>` and `GET /<topic>/<sequence id>/delete` answer `200`
  with a real `message_delete` event, and the scheduled message is still delivered. A success response
  is not evidence of cancellation. Only `DELETE /<topic>/<message id>`, using the `id` field of the
  publish response, was observed to stop a delivery, and it did: that message never arrived.
  **Decision:** the engine stores the returned id on the instance record (`pushId`) together with the
  `dueLocal` it was registered for (`pushFor`), and it cancels by that id. A reminder whose record
  still carries both is not published again — the idempotency that keeps one registration from
  becoming two pushes — and the previous id is deleted when a registration is superseded.
  **Alternatives:** keeping the sequence-id cancel (it answered `200` and cancelled nothing, so the
  phone rang for a task already done); re-publishing as an update (it delivered a duplicate push);
  holding the id only in memory (a restart would lose the only handle that cancels, and the record
  set that held it was also the tracking state, so both are now the same persisted field).
  **Consequence:** cancellation depends on a value the provider returns and the plugin persists, not
  on an id the caller chooses, and it survives a restart. A provider that returns no id leaves
  `pushFor` set — the reminder is still not re-published — but its push cannot be withdrawn; the
  engine degrades to "one registration, no cancel" rather than to duplicates.
- **A `200` on the delete is not proof of cancellation; whether it takes effect depends on the HTTP
  client.** Probed against `ntfy.sh` on 2026-09-11, publishing with an absolute `X-At` and cancelling
  with `DELETE /<topic>/<message id>`: `curl` cancelled 5 of 5 and Bun's `fetch` 6 of 6 — immediate,
  and 2 s / 20 s / 45 s after publication — and none of those messages arrived; node v24's `fetch`
  (undici) cancelled 0 of 3, with every DELETE answered `200` with a real `message_delete` event and
  every message delivered anyway. The plugin's deletes go through Obsidian's `requestUrl`, which is
  Electron/Chromium's networking stack rather than undici, so the expectation is that they behave like
  the curl-class clients — **[INFERENCE]**, not a measurement; R14 names the probe that would settle
  it. **Consequence:** the plugin sends the id-based delete and stops there. A cancellation whose push
  is still delivered is the server ignoring a request the response reported as `200`, and no document
  claims a stopped delivery — a completed task may still buzz the phone.
- **The publish carries no `X-Sequence-ID`, because the header poisons the only cancel that works.**
  Probed against `ntfy.sh` on 2026-09-11: a message published *with* the header could not be cancelled
  by any key — `DELETE /<topic>/<message id>` and `DELETE /<topic>/<sequence id>` both answered `200`
  and the message was delivered — while the same publish without the header was cancelled by message
  id and never arrived. The header had nothing left to buy, since the record's `pushFor` already stops
  an unchanged reminder from being published again, so `buildNtfyRequest` no longer sends it.
  **Consequence:** the message id the provider returns is the only handle observed to cancel a
  delivery, and it stays usable because no publish writes a sequence id alongside it. Whether the
  server acts on the delete is still the client's decision (the bullet above), so the id buys an
  attempt, not a stopped push.

## 13. Quiet hours are applied at parse time, by one implementation

- **Decision:** quiet hours are read from the time written in the note, applied while the note is
  parsed (`parseNote`), and the outcome is stored on the record as `severity`. The delivery side
  never re-derives it. The unused copy of that rule in `settings.ts` (`isInQuietHours`, along with its
  `toMinutes` and `parseMinuteList` helpers) is deleted.
- **Alternatives:** applying quiet hours at delivery time (a second implementation of one rule, and
  the two can disagree — which is what the deleted copy already demonstrated: it had no caller, no
  test, and a different signature, taking a minutes-of-day number and `KairosSettings` where the live
  one takes the parsed time and `ParseSettings`, while the parser's copy decided every alert);
  keeping the helper "for reuse" (it was exported, untested, unreachable, and would have looked
  authoritative to the next contributor).
- **Consequence:** quiet hours never reclassify an instance after parsing, so a reminder cannot change
  class because a later tick happened to run in a different part of the day. The one later
  reclassification is the user's own catch-up policy: `fold_into_digest` delivers a late item as a
  digest at the next window and records it as one, which is what the policy means — an alarm missed by
  fourteen hours is not supposed to interrupt at 23:00. That path is pinned by a test which fails if
  the window is ignored, because it was ignored: the plan computed `deliverAt` and the delivery loop
  discarded it, so the folded item arrived as a notification on the tick that opened the app, was
  marked `notified`, and never reached the window it had been folded into. The window is also pinned by
  the pass that first notices the miss, because `nextDigestAt` only accepts a candidate at or after
  `now`: a tick a millisecond past 08:00 would choose 18:00, the next tick 08:00 tomorrow, and the item
  would never be delivered at all. A test that ticks exactly on the window passes against both versions
  and proves nothing, so the tests tick just after it, as an interval or wake timer does.
- **Coverage:** the rule is testable through the contract a user sees
  (`tests/quietHours.test.ts`): both boundaries of a window that wraps midnight
  (21:59 alarm, 22:00/23:30/00:00/06:59 digest, 07:00 alarm), a window inside one day, off, blank,
  malformed and zero-length windows all leaving an alarm alone, and a digest that is not delivered at
  its due time but is delivered at the next window. Before this, the whole suite and the smoke vault
  ran with quiet hours off, so a regression would have downgraded alarms in silence — which is how it
  was found: the smoke alarm stopped interrupting at 22:02 and started again the next morning.
- **Known limit:** a record keeps the severity it was parsed with. Changing the window affects records
  created after the next parse of their note, and `Rescan vault` re-parses everything; a settings
  change alone does not. The candidates are to re-derive on a parse-affecting settings change (a full
  vault pass on each such change, or a targeted one) or to move the rule to delivery time, which
  contradicts the decision above unless the parse-time copy is removed in the same change.
