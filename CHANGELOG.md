# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/aliefe04/obsidian-kairos/compare/0.1.1...HEAD
[0.1.1]: https://github.com/aliefe04/obsidian-kairos/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/aliefe04/obsidian-kairos/releases/tag/0.1.0
