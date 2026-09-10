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
  nothing beyond the horizon (default seven days) is mirrored.

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

## 9. The alert text leads with the task title

- **Decision:** `messageSummary()` emits `title · HH:mm · age · note name`. The desktop channel uses
  that string as-is instead of prefixing the title again.
- **Alternatives:** keeping `HH:mm · age · note name` (which is what shipped first) and letting the
  OS notification's own title field carry the task.
- **Consequence:** the in-app notice is self-contained — "call the dentist · 21:13 · 1 min late" —
  and the mobile fallback path no longer duplicates the title. Found by reading the real notice text
  out of the smoke run rather than by asserting a string in a unit test.
