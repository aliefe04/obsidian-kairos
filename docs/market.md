# Market Teardown — reminder and notification plugins for Obsidian

Compiled 2026-09-10 from primary sources (plugin repos, release APIs, official docs, the Obsidian
plugin registry export). Labels: **V** = the primary source was read; **R** = secondary or
community-reported.

---

## 1. The platform constraints that shape every product in this market

| Constraint | Evidence |
|---|---|
| `Notice` is an in-app toast, not an OS notification. No API schedules OS notifications | `obsidian.d.ts` describes `Notice` as a "Notification component… present timely, high-value information"; nothing notification-scheduling-related exists in the API **V** |
| Desktop OS notifications are still possible, via Electron from the renderer | obsidian-reminder ships `src/plugin/ui/system-notification.ts` constructing `new Notification({title, body, timeoutType})` from `window.require("electron").remote` **V**. Electron documents macOS 256-byte body truncation and `timeoutType: 'never'` on Windows/Linux **V** |
| Hidden-window timers are throttled | Chromium clamps hidden pages to ≥ 1 s and switches to once-per-minute after ~5 min hidden (Chrome 88) **V**; Electron's `backgroundThrottling` defaults to `true` and a plugin cannot change its host window **V** |
| **Obsidian mobile cannot run plugin code in the background, and has no local-notification API** | Mobile is Capacitor; dev docs list only Node/Electron unavailability **V**. Obsidian's own Reminder plugin states it plainly: "On mobile, Obsidian can't run plugin code in the background, so none of the notification methods above fire unless the app happens to be open at the reminder's time" **V** |
| Sync runs only while the app is open | Official Sync FAQ: "Is my data being synced in the background? No" **V**; Obsidian staff, 2026-02-27: "Sync does not currently run in background" **R** |
| `.md` conflicts are auto-merged and can duplicate text; every other file type is last-write-wins; `.obsidian` JSON merges local-on-top | Obsidian Sync troubleshooting docs **V** — this is the reason the state model uses create-only, per-device files |

Consequence: **no plugin can alert when Obsidian mobile is closed, by itself.** Any honest product
either delegates delivery outside the app (server push, calendar alarm) or says it cannot.

## 2. Competitors

| Product | Syntax | Channels | Mobile | Recurrence | Catch-up after closed | Timezone | Maintenance | Reach |
|---|---|---|---|---|---|---|---|---|
| **Reminder** (uphy, MIT) | `(@YYYY-MM-DD HH:mm)`, Tasks emoji interop | in-app toast/modal, desktop system notification, ntfy (experimental) | in-app only | yes, but only when completed via the plugin | ntfy registers **24 h** ahead only; "re-notify muted on startup" defaults off | none — naive wall-clock strings | 1.4.3, 2026-08-29; 80 open issues | 331k downloads, 658★ |
| **Tasks** (obsidian-tasks-group, MIT) | `📅 ⏳ 🛫 ➕ 🔁 ✅` | **none** — notifications are explicitly out of scope (#2721) | n/a | yes | n/a | n/a | 8.4.0, 2026-08-25; 155 open issues | 4.2M downloads |
| **Task Genius** (FSL-1.1-ALv2) | own syntax + Tasks emoji | desktop system notifications, tray badge, digest | desktop only | view-based | desktop process must run | n/a | 9.14.0-beta.5, 2026-06-28; 213 open issues | 164k downloads |
| **Day Planner** (ivan-lednev) | `- [ ] 10:00 - 10:30 X`, Tasks `⏳`, ICS **read** | desktop "task started" alerts | crash reports on mobile | — | — | — | 0.35.1, 2026-07-31 | 882k downloads |
| **Remindian** (macOS app, MIT) | reads Tasks/TaskNotes markdown | delegates to Apple Reminders / Things / Todoist / TickTick → real lock-screen alerts | via native apps | yes | yes (the target app owns it) | inherits target | created 2026-02, unsigned beta | 336★ |
| **Ntfy Notifications** (`android-ntfy-notifier`) | `⏰/🔔 date`, `@remind()`, `#remind`, `notify::`, `ntfy::`, `30m/2h/1d` | ntfy → phone shade; Telegram/Slack/email | yes, via ntfy | local queue | ntfy max schedule 3 days; Obsidian must run periodically to hand off | UTC ISO in payload | 1.4.1, 2026-09-09 | 1.8k downloads |
| **Notelert** | inline `:@` | Android push via companion app, email, Google Calendar, Telegram | via companion | yes | external service | — | ~4 months old | 1.5k downloads |

**Registry reality check.** 7,484 plugins are published. Search the export for reminder-adjacent
ids and you find `obsidian-reminder-plugin`, `lite-reminders`, `notelert`, `nudge`, `remember`,
`reminder-telegram`, `apple-reminders-sync`, `alarm-timer`, `countdown-timer`, `cron`,
`export-ics-schedule`, `task-calendar-bridge`, and more — but **not one of them exports reminders to
`.ics` for a calendar app to alarm on** ("ICS Calendar" and Day Planner only *read* ICS) **V**.

## 3. Pain points, ranked

1. **The alert requires the app to be open — especially on mobile.** The canonical forum thread
   ("Reminders/notifications in Obsidian") has 117 posts and is still active in 2026: *"man, this has
   been open for 4 years. Is this ever going to be implemented? Kanban tasks are pretty useless
   without notifications"* (2024-11-02); *"the reminders only pop up within Obsidian itself"* (2021);
   *"Mobile Notifs: Impossible within Obsidian"* (2025-01-24).
2. **Alerts that never fire.** Reminder #64 "System notifications on android for reminders not
   firing" (open since 2022-02-21); #251 "Times do not work since a few updates" (2025-08-27); #202
   "Plugin stopped working" (2024-10-29); Day Planner #334 "Task notification not working".
3. **Duplicate alerts.** Reminder #142 "Activating Kanban displays normal reminders twice" (open
   since 2023-03); Day Planner #642/#708 "'Task Started' notification appears for every created
   task".
4. **Per-device drift and no cross-device state.** Reminder #85 "Allow Obsidian Sync to sync the
   reminder states before reminding" (open since 2022); #257 "Reminder notification across device";
   cross-device dismissal needs "keep system notification on screen" on Windows/Linux.
5. **Missing reminders after downtime.** Reminder's own docs: "If Obsidian isn't opened for more than
   a day… won't notify you"; #270 "New reminders in synced files aren't detected until manually
   rescanned" (2026-06-30, open).
6. **Abandonment and scope churn.** Tasks documents notifications as out of scope; Day Planner's
   rewrite pushed users to a community fork; Task Genius has had no release since 2026-06-28.
7. **Timezone and DST: an unowned risk.** No timezone setting exists in Reminder and no DST issue
   titles were found — the failure is silent rather than reported.

## 4. What a new entrant can own

1. **Real mobile delivery with no companion service and no 24-hour cliff.** The only closed-app path
   today is ntfy-on-a-short-leash, a macOS app, or an Android companion app. Owning a multi-day,
   no-account, offline-capable delivery tier (`.ics` + honest server-side scheduling) is unclaimed.
2. **Deterministic scheduling with a single-fire guarantee.** Stored zone, explicit catch-up policy
   per reminder, and cross-device arbitration — currently nobody.
3. **Zero-configuration, zero-dependency UX that covers both alarm-grade reminders and ordinary
   journal lines**, instead of six plugins and six syntaxes.

## 5. What changed in 2026 that a plan must account for

- **Submission moved to `community.obsidian.md` plus a developer dashboard**, the automated review
  now scans **every version** rather than the first submission, and closed-source submissions are no
  longer accepted. Labels are Free / Optional payments / Paid; Obsidian is explicit that it is "not a
  store".
- **Review guidelines are enforced by tooling**: `eslint-plugin-obsidianmd` ships in the official
  sample plugin and checks for global `app`, `innerHTML`, console noise, sentence-case UI text,
  missing cleanup registration, default hotkeys, and more. This repo runs it in CI.
- Mobile 1.14 added OS surfaces (iOS Quick Capture widget, Android "Open Note" widget) but **still no
  notification API**.
- `obsidian-headless` (open beta) runs Sync continuously without the desktop app — the only supported
  way to keep a schedule alive off-device. Phase 3 can use it; nothing else can.
