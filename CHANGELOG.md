# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5] — 2026-09-11

### Fixed

- **A password pasted with its line break was rejected as wrong.** A password is almost always copied
  out of a file or echoed by a terminal, and every one of those sources ends the line with a break.
  The settings field shows nothing, the server answers `401`, and the failure reads as a wrong
  password — measured on the deployed server: the password file's own bytes answer `401`, the same
  bytes with the breaks removed answer `207`. The CalDAV password was the one credential passed
  through untouched (`ntfy`'s token was already trimmed); it now drops line breaks, and keeps spaces,
  which a password may legitimately contain and a header cannot confuse with a break.

### Documentation

- **An iOS account cannot authenticate over plain HTTP — measured, and previously described as
  workable.** With the account pointed at `http://…:5232/` and *Use SSL* off, the phone's DAV clients
  reached the server and were refused without ever presenting the password: requests from `accountsd`,
  `remindd` and `dataaccessd` were each logged `denied for anonymous user`, answered `401`, and not
  one produced a `207` — while the same requests carrying credentials answer `207` at every step. The
  recipe now states TLS as a requirement and documents the smallest way to provide it on a LAN: a
  Caddy front with a local CA on a second port, its root certificate served for installation, and the
  two-step trust (install the profile, then enable it under *Certificate Trust Settings*) that
  skipping leaves a certificate the phone still refuses.

## [0.1.4] — 2026-09-11

### Added

- **The vault's identity is kept in the vault, not in each device's settings.** A reminder's instance
  id — and so the name of every registration made from it — is derived partly from the vault id, so
  two devices writing one vault have to agree on it or each makes its own copy of the same reminder:
  two tasks in Reminders for one line, each device able to withdraw only the one it wrote. The id now
  lives at `<state folder>/vault-id`, where a vault sync carries it to the other device. A value
  already in `data.json` is written out rather than replaced, so a vault that has been in use keeps
  the ids its state files and server entries are named after.

### Changed

- **The vault state folder's default name is now visible (`kairos`).** Sync tools commonly skip
  dot-folders, so a state folder named `.kairos` is the one that does not reach a second device — and
  that folder is exactly what two devices writing one vault have to share: with a private state
  folder the two engines are independent, both register every reminder, the phone rings twice for one
  line, and the lease cannot fence a double fire. `State location` selects whether state is shared at
  all (`plugin-dir`, still the default, keeps it to this device; `vault-folder` puts it in the vault),
  and the folder name applies when it is in the vault. A vault already running keeps the name it has.

### Fixed

- **A reminder that fired while Obsidian was closed left a calendar entry nothing could withdraw.**
  The catch-up fire publishes through the channels but stores no handle, so when the line was later
  completed or deleted there was nothing to delete by — the task stayed in Reminders for good. A
  departure with no handle now asks the channels that own a real entry (`deleteAfterDue`) to sweep
  their collection for that instance.
- **A line that came back was not scheduled again.** Deleting a line, or ticking it off, cancels its
  reminder; undoing either is ordinary, and the block id returns with the text, so it is the same
  instance. A cancelled record whose due time is still ahead returns to `scheduled` and registers
  again. One whose time has gone stays cancelled: reviving it would deliver the reminder a second
  time through the catch-up fire.

## [0.1.3] — 2026-09-11

### Added

- **A CalDAV channel, so a reminder can reach an iPhone's Reminders app.** One `VTODO` per reminder,
  with an absolute alarm at the due instant, written into a collection you name. A CalDAV account
  added in iOS Settings surfaces that collection as a list, so the phone alarms with Obsidian
  closed. The resource name is derived from the instance id, so writing the same instance twice
  rewrites one task, and a cancelled reminder is deleted from the instance id alone — even if no
  handle was stored. An edited due time is a new instance (the id carries the time), so it replaces
  the old task by withdrawing it rather than by an in-place update. A collection that does not exist yet is created on the first write
  (`MKCALENDAR`; Radicale answers a `PUT` into a missing collection with `409`). Registration,
  withdrawal and deletion verified against a real Radicale. Setup: `docs/recipes/caldav-reminders.md`.
- **Each server-scheduled channel keeps its own registration.** The record held a single push id, so
  two channels enabled at once meant one channel's registration could never be withdrawn: a
  completed task still rang the phone. A channel now also states its own horizon — `ntfy.sh` refuses
  a delay beyond three days, a calendar takes a year — and whether a registration whose due time has
  passed should be deleted (never for `ntfy`, whose clients read that as a dismissal; always for a
  channel that owns a real entry). Existing records migrate their id to `ntfy`.

### Fixed

- **A line written while Obsidian was running never became a reminder.** The note was parsed on the
  metadata change and stored, but the engine was only told about it by a full rescan — so a reminder
  typed during a session was ignored until the next launch, rename or delete: no local alert, no
  registration. The engine is now synced on the change itself, outside a scan (a scan syncs the
  finished index once, since a per-file sync would look like every other file had been deleted).
  Covered end to end by a smoke step that writes a line into a running app and watches the engine
  pick it up.
- **The phone's task was deleted the moment the reminder fired.** A fired reminder left the
  registration set, so the next pass retired its entry — which for a calendar channel meant deleting
  it. The line is still in the note, unchecked, so the task is still open, and Reminders is where the
  user ticks it off. An entry now stays while the note asks for it and goes when the note stops:
  completing or deleting the line withdraws it, and `acked` or `muted` (the user is finished with it)
  deletes it as before.
- **A quiet-hours reminder was registered with a push provider for its written time.** Such a
  reminder is parsed as a digest and delivered in the digest window, but it was still mirrored into
  every server-scheduled channel at its written time — a real alarm at the hour the user asked to be
  left alone, with the app closed and nothing to soften it.
- **Every channel refused left a reminder covered by nothing.** A pass whose registrations were all
  refused still recorded the due time as covered, so the catch-up fire went to the local channels
  only and the phone that never received the push stayed silent.
- **Unticking a channel left its registration stranded.** Withdrawal is now derived from the entries
  the record itself holds rather than from the configured channels, and `ntfy`'s cancellation no
  longer requires the channel to still be enabled — the stored server and topic are enough.

## [0.1.2] — 2026-09-11

### Fixed

- **A reminder that came due while Obsidian was closed never reached the phone.** The fire path had
  been narrowed to the local channels, which is right for a due time the provider already holds a
  registration for — but the mirroring pass registers only due times still ahead, inside the horizon.
  A reminder that came due during an outage therefore had no registration at all, and its catch-up
  reached no server channel: the phone stayed silent, and the record still moved to `notified` with an
  entry in the fired log, so it read as delivered. A fire whose due time no registration covers now
  reaches every configured channel again, and the provider publishes the push immediately, clamped to
  its minimum delay — that late alert is the intended and only delivery for that due time.
- **Retiring a registration whose due time had passed dismissed it on the phone.** Cancelling a push
  always deleted it by message id; once that due time had passed the provider had delivered the
  notification or was about to, and `ntfy`'s clients read a delete of a delivered notification as the
  user dismissing it. A passed registration is now dropped from the record (`pushId`/`pushFor`) without
  issuing a delete, so no later pass repeats it and the message is left to the provider. A due time
  still ahead keeps the existing delete-by-id, which is a genuine cancellation.
- **Relaunching after a reminder was missed while Obsidian was closed published a second push for
  it.** That retirement ran on the launch pass, which `main.start()` reaches before the tick that
  catches the reminder up: the record's `pushId`/`pushFor` were dropped, the catch-up then read no
  registration covering its due time, and it published again — a push for a due time the phone had
  already been sent. A record that is still `scheduled` or `armed` is about to fire, so it now keeps
  its marker whatever its due time reads; the catch-up that reads it stays local-only, and the pass
  after that fire drops the marker without a delete.
- **A live reminder was registered again on every pass, duplicating the push.** `ntfy.sh` does not
  replace a pending scheduled message when the same `X-Sequence-ID` is published again — both copies
  are delivered — so the engine now remembers the registration: the instance record stores the
  `dueLocal` the push was made for (`pushFor`) and an unchanged reminder is not published at all.
- **Two overlapping passes still registered the same reminder twice.** The record-set operations were
  serialized nowhere, so a pass triggered by the indexer could read a record before the pass ahead of
  it had written `pushFor` and publish a second push. Traced in the real app on 2026-09-11: two
  registrations two seconds apart for one reminder, both delivered at the same due second.
  `load`, `sync`, `syncServerScheduled`, `ack`, `setMuted` and the snooze writes now run one at a time
  in a FIFO queue.
- **A firing reminder published a second push ten seconds later.** The fire path sent to every
  configured channel, so the firing tick re-published to the server-scheduled one; ntfy clamps a
  schedule that has already begun to ten seconds out, so the duplicate landed after the alert it
  duplicated (the third arrival in that trace, due 11:14 delivered 11:14:10). The fire path now uses
  the local channels only; `Test notification` still reaches all of them.
- **Completing or rescheduling a task did not cancel its push.** Cancellation was an empty-body
  publish carrying `X-Sequence-ID`; `ntfy.sh` answers `200 message_delete` to a delete by sequence id
  and still delivers the message. Both facts were probed live on 2026-09-11. Cancellation now sends
  `DELETE /<topic>/<message id>` with the id the publish returned, persisted on the instance record so
  it survives a restart. That form was observed to stop a delivery from `curl` (5 of 5) and Bun's
  `fetch` (6 of 6), immediately and up to 45 s after publication, while node v24's `fetch` (undici)
  cancelled 0 of 3 — every delete answered `200` with a real `message_delete` event and every message
  was delivered anyway. A `200` is not proof of cancellation, and Obsidian's `requestUrl` is
  Electron/Chromium's stack, not undici, so no guarantee is made that a completed task cannot buzz the
  phone (ADR 12, R14).
- **A push published with `X-Sequence-ID` could not be cancelled.** Probed live on `ntfy.sh`
  (2026-09-11): with the header present, `DELETE /<topic>/<message id>` and `DELETE /<topic>/<sequence
  id>` both answered `200` and the message was delivered; the same publish without the header was
  cancelled by message id and never arrived. The publish therefore sends no sequence id — the record's
  `pushFor` already stops a repeated registration, so the header bought nothing.

### Changed

- The push summary line reports what it counts: `push scheduling: 2 registered, 3 pending, 0 failed,
  0 deferred, 1 cleared`. `registered` is the registrations the last pass made, `pending` is the
  pushes the server is holding, read back from state, and `cleared` counts registrations the pass
  dropped from the record — withdrawn by message id when their due time is still ahead, retired
  without a delete once it has passed. All three replace the old `sent` wording, which implied the
  every-pass re-send that no longer happens.

## [0.1.1] — 2026-09-11

### Fixed

- **The phone push tier never scheduled anything.** `X-At` was sent as a count of seconds (`"3600"`),
  which `ntfy` accepts as neither a timestamp nor a duration: it answered
  `400 invalid delay parameter`, so every registration was refused. The desktop alerted normally and
  the phone stayed silent, which is the one failure this tier exists to prevent. The header is now an
  absolute Unix timestamp — also what the server compares against, so a device clock a few seconds out
  cannot move an alert. Verified against `ntfy.sh` by posting both forms: the count was rejected, the
  timestamp was accepted, and it arrived at the second it named.
- The diagnostics line reported `daily notes folder (detected)` even when nothing had been detected —
  the state a device lands in when the vault's Daily notes configuration never synced to it, where no
  dated note resolves and nothing says so. It now names the folder in use, or says there is none and
  what to set.
- A format containing `dddd` rendered `11-09-2026-friday.md`, while Obsidian's own daily-note command
  writes `...-Friday.md`, because the renderer reused the locale pack's lower-cased lookup table.
  **Add reminder** could therefore ask for a second note beside the one Obsidian made. The packs now
  carry the display spelling, read from Obsidian's own bundled moment, for `en` and `tr`.

### Added

- A **Test notification** button in the Channels group. The specification promised one per channel and
  the code had none: the only way to send a test was a command nobody could find.

### Changed

- The smoke harness pins its settings before relying on them, waits for the daily-notes folder to be
  adopted instead of racing it, and asserts the diagnostics line it prints.
- The daily-note path is tested in both directions: rendered for a date, then read back through the
  parser, for every shipped locale and every default format including the leap day. That pair is how a
  fix in one direction can silently break the other.

## [0.1.0] — 2026-09-10

The first version. Built and tested against Obsidian 1.13.7 on macOS. It is not in the community
plugin directory yet: install it from this release, or with BRAT (`aliefe04/obsidian-kairos`).

### Added

- **Reminder syntax from the note itself.** A bare time in a date-scoped note
  (`- [ ] msg to dentist 09:00`) alerts at that time on that note's date. Start-of-line times, `at`
  prefixes, explicit `@ 2026-09-11 09:00` forms, and the existing `⏰` and `(@…)` forms of other
  plugins are read as well.
- **The date cascade**: frontmatter, H1, nearest preceding date heading, file name formats including
  `YYYY/DD-MM-YYYY-dddd`, and the Daily Notes folder cross-check. An ambiguous file name such as
  `08-09-2026` is refused and reported instead of guessed.
- **A scheduling engine** with one recomputed next-wake timer, deterministic instance identity,
  a per-device lease with fencing, a 60-second dedupe window, and per-reminder catch-up policy.
- **Two severities**: `alarm` interrupts, `digest` batches at a configured window. Quiet hours turn a
  reminder written inside them into a digest item.
- **Delivery channels**: desktop OS notification with an alert window (Done, Snooze, Open note), ntfy
  server-side scheduled push, and an RFC 5545 `.ics` export for a calendar application.
- **A searchable settings tab** using the Obsidian 1.13 declarative settings API.
- **An agenda view**: today, tomorrow, the next seven days, and overdue.
- **Commands**: open agenda, add reminder, rescan vault, copy diagnostics, test notification.
- **Locale packs** for `en` and `tr`, as data files rather than a dependency.
- **A real-application test harness** (`npm run smoke`) that drives Obsidian over the Chrome DevTools
  Protocol and asserts the parsed schedule, the exactly-once guarantee, and the rendered alert text.

### Changed

- The smoke harness pins the plugin's settings before it relies on them. It expected an alarm from a
  note written two minutes in the past, which the default quiet hours fold into a digest between
  22:00 and 07:00 — the same code passed at 21:24 and reported nothing fired at 22:02.

### Removed

- Four unused exports in `settings.ts`. `isInQuietHours` and `parseMinuteList` restated rules that the
  parser and the engine already implement, and `toMinutes` and `splitLines` existed only to serve them.
  Quiet hours is applied in one place, at parse time, and is covered by boundary tests
  (`tests/quietHours.test.ts`); before that, the whole suite and the smoke vault ran with quiet hours
  off, so a regression there would have downgraded alarms in silence.

### Fixed

- A catch-up with the `fold_into_digest` policy is held until the next digest window, and the window is
  settled once per reminder. It was delivered on the tick that opened the app — a notification at 23:00
  for a reminder the policy says should not interrupt — and was marked notified at that point, so it
  never reached the digest it was folded into.
- A push registration the provider keeps refusing is no longer retried past the reminder's own due
  time. The request would have asked for a delivery in the past, and the alert would never arrive.
- A phone that stops ringing is now visible: the *Registered channels* line shows the last push pass
  (`push scheduling: 3 sent, 1 failed, 1 deferred`) and so does **Copy diagnostics**.

### Security

- No telemetry, no account, no server component.
- The default push payload is the task title alone. The note name is opt-in and the vault path is
  never sent.
- Channel tokens are stored as plaintext in `data.json`, because Obsidian exposes no secret storage
  API. This is stated in the settings tab and in the README.

### Known limits

- Obsidian mobile cannot alert while the app is closed. This is a platform limit. The `.ics` and push
  tiers cover it; see `docs/delivery.md`.
- A push provider holds a scheduled alert for a bounded period. On `ntfy.sh` the maximum is three
  days, which is why the registration horizon defaults to three days. A user who runs their own server
  with a larger limit can raise it in the settings.
- Recurrence (`🔁`) is read for display and never advanced. Tasks and Reminder own that field.
- The performance target for large vaults (10,000 notes under 1.5 seconds) is a target, not yet a
  measurement. The benchmark is a Phase 1 item.

[0.1.5]: https://github.com/aliefe04/obsidian-kairos/compare/0.1.4...0.1.5
[0.1.4]: https://github.com/aliefe04/obsidian-kairos/compare/0.1.3...0.1.4
[0.1.3]: https://github.com/aliefe04/obsidian-kairos/compare/0.1.2...0.1.3
[0.1.2]: https://github.com/aliefe04/obsidian-kairos/compare/0.1.1...0.1.2
[0.1.1]: https://github.com/aliefe04/obsidian-kairos/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/aliefe04/obsidian-kairos/releases/tag/0.1.0
