# Delivery Strategy — how an alert reaches a human

The central engineering fact of this product: **Obsidian mobile cannot alert while it is closed, and
no plugin can fix that.** Everything below is a response to that limit, ordered by what it costs the
user (nothing → an account → a server).

Each tier is independent and additive. A user may enable one, several, or all.

| Tier | Delivers when Obsidian is… | Platforms | What the user gives up |
|---|---|---|---|
| **T1 Desktop OS notification** | open (focused or hidden) | macOS, Windows, Linux | nothing |
| **T2 `.ics` in the vault** | **fully closed**, offline, in aeroplane mode | both, via the OS calendar | nothing but a one-time calendar import/subscription |
| **T3 Webhook push** (ntfy, Bark, Pushover, Telegram, …) | closed | both | a topic name or token, and the task title leaving the device |
| **T4 Self-hosted relay** (Phase 3) | closed, multi-day horizon | both | a container to run |

## T1 — Desktop OS notification

Mechanism: Electron `remote.Notification` from the plugin's renderer context, which is what the
incumbent ships today and what the API permits.

Rules the implementation follows, from Electron's documented behaviour:

- macOS truncates the body at 256 bytes → the payload is the task title, and the note name only if the
  user opts in.
- Windows/Linux need `timeoutType: 'never'` for the notification to stay on screen long enough to
  click, so that is the default there; macOS ignores it.
- Sound: `silent: false` by default; per-platform sound selection is a Phase 2 setting.
- The OS notification and the in-app modal are one delivery with two surfaces: the modal carries
  **Done**, **Snooze**, and **Open note**; the OS notification carries what the platform supports
  (actions on macOS/Windows).
- Hidden-window throttling (≥ 1 s, then once per minute after ~5 minutes hidden) is why the engine
  never counts ticks: every wake recomputes the due set from wall-clock time.
- On mobile — where Electron does not exist — this channel degrades to an in-app toast and reports
  that it did so. It never throws.

## T2 — `.ics` in the vault (the tier nobody ships)

Kairos writes `kairos.ics` into the vault: one `VEVENT` per live reminder, `DTSTART;TZID=<zone>`,
`VALARM` with `TRIGGER:PT0M`, CRLF endings, 75-octet line folding, and a `UID` derived from the
instance identity so re-exports update events instead of duplicating them.

Why this is the strongest differentiator: **the alarm is then owned by the OS calendar**, which fires
with Obsidian closed, with no network, on both iOS and Android, and the reminder content never leaves
the device. Nothing in the registry does this today — the existing ICS plugins only read.

Honest limitations, which the UI states at the point of configuration:

- Calendar apps refresh *subscribed* feeds on their own cadence; iOS/Google may take hours. For
  promised-to-the-minute alerts, T3 is the tier to use, and the settings text says so.
- iCloud-to-iCloud publishing (a shared file path) is a Phase 2 investigation, not a claim.

## T3 — Webhook push (a phone alert with Obsidian closed)

Channels, in the order they will be offered. **v0.1.0 ships `ntfy` only**; Bark, Pushover, Telegram
and the generic webhook are Phase 2 (`docs/roadmap.md`). The constraints below decided the order:

| Channel | Why it is ranked here | Constraint to state in the UI |
|---|---|---|
| **ntfy** | Self-hostable, free, both platforms, and it can hold a *scheduled* push server-side | Public server: message bodies traverse ntfy's servers. Self-hosting iOS needs `upstream-base-url` pointed at ntfy.sh for instant delivery. Server-side delay max defaults to 3 days, message cache 12 h |
| **Bark** | iOS only, one key in a URL, supports `level=critical` and repeat (`call=1`) for alarms that must not be missed | iOS only |
| **Pushover** | Mature, both platforms, emergency priority repeats until acknowledged | Clients are a paid app; 10k messages/month free |
| **Telegram** | Free, both platforms, already installed on many phones | Creating a bot is a real setup step; bot chats are not end-to-end encrypted |
| **Generic webhook / Discord / Slack** | One POST, no account beyond the workspace | The user owns the integration |

Design rules for every push channel:

1. **Payload is the task title only** by default. Note names are opt-in, vault paths never.
2. **Server-side scheduling is a first-class mode.** A channel declares
   `mode: 'server-scheduled'`; the engine then registers reminders ahead of time (rolling horizon,
   re-registered whenever the index changes) with `X-At`-style offsets, so the alert survives
   Obsidian being closed for days — the specific failure of the incumbent's 24-hour window.
3. **Two-way cancel.** Completing or rescheduling a task clears the scheduled push
   (`X-Sequence-ID` + `clear()`), so a done task does not buzz the phone an hour later.
4. **A `Test notification` command** that fans out to every configured channel, plus a title-only
   default, because a user who cannot see what will leave their device will not turn the channel on.
5. **The horizon is the provider's limit, not ours.** The default is three days, which is `ntfy.sh`'s
   documented maximum delay (`message-delay-limit`). A reminder due beyond it is not registered at
   all, because the server would refuse it. A refusal is remembered: the next attempt waits 1 minute,
   then 2, 4, 8, doubling to a ceiling of 6 hours. Passes happen on every index change, ack, snooze,
   rescan and start, so an instant retry would spend the provider's quota on a request that is known
   to fail — and a refusal caused by the horizon fails every time until the reminder comes inside it.
   Self-hosting users raise the horizon in the settings.
6. **A refusal can never push the next attempt past the due time.** The wait is clamped to one minute
   before `due`, because a retry after `due` cannot work: the provider would be asked to deliver in the
   past, and the alert would never be registered at all. Inside that final minute the retry happens at
   once, and the due time itself ends the attempts. The last pass is visible to the user as a line in
   the settings tab and in **Copy diagnostics** — a phone that stops ringing must not be silent about
   it.

## T4 — Self-hosted relay (Phase 3, opt-in)

Target: multi-day horizons with no third-party account, using `obsidian-headless` (which keeps a
vault synced without the desktop app) or a small container that reads the synced vault and posts to
the user's chosen channel. It is designed but deliberately not built in Phase 0/1 — it needs its own
security review, and shipping a half-built relay would be worse than shipping none.

Explicitly **not** on the roadmap: building a companion app with APNs/FCM credentials. That requires
an owned, reviewed app on two stores, and it re-solves a problem ntfy/Bark already solve for free.

## The catch-up contract (all tiers)

| Situation | Behaviour |
|---|---|
| Due while Obsidian was closed, ≤ `grace` (default 15 min) | Fire on launch, immediately, marked `alarm` |
| Due while closed, > `grace`, user policy `fire_now_with_age` (**default**) | Fire on launch with the age in the text ("09:00 — 2 h ago") |
| Same, policy `fold_into_digest` | Deferred to the next digest window (default 08:00 / 18:00) |
| Same, policy `skip_and_mark_missed` | No alert; the record is marked missed and visible in the agenda view |
| Inside quiet hours (decided when the note is parsed, from the time written) | Folded into the next digest, always — even for alarms |
| Alert fires on two devices at once | The lease decides; the loser receives nothing and records nothing |

The default is deliberate: a late alert is recoverable, a silently dropped one is not.

## Privacy

- No telemetry of any kind, no accounts, no analytics.
- Default payload: the task title. Note name opt-in. Vault path never.
- Channel tokens are plaintext in `data.json` — there is no secret API in Obsidian and
  `safeStorage` is desktop-only. The settings field says so, the README says so, and the review
  guidelines require disclosing remote services: `docs/community.md` lists this as a release-blocking
  disclosure.
