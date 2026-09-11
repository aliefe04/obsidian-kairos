# Setting up delivery

Kairos has four delivery channels. Each one is independent. The desktop channel is on by default;
the rest stay off until you configure them.

Which one you want depends on where the alert has to land. `ntfy` pushes to a phone in seconds, with
Obsidian closed. The CalDAV channel writes a task into a calendar account iOS shows in its **Reminders**
app, so the phone's own alarm fires — see [`recipes/caldav-reminders.md`](recipes/caldav-reminders.md).

The first question is usually "will it alert me when Obsidian is closed?". The answer depends on the
channel, so read the table in `docs/delivery.md` if you want the engineering version. The short
version:

| Situation | Desktop alert | ntfy push | Calendar file |
|---|---|---|---|
| Obsidian open, window focused | yes | yes | yes |
| Obsidian open, window hidden | yes | yes | yes |
| Obsidian closed | **no** | yes, while the push is registered | yes |
| Phone locked, Obsidian closed | no | yes | yes |
| No network at the alert time | yes | yes, if the push was registered earlier | yes |

## 1. Desktop notification — on by default

What you get: an operating system notification, plus a window with **Done**, **Snooze 10 minutes**,
**Snooze…**, and **Open note**.

Settings, under the *Channels* group:

| Setting | Default | Note |
|---|---|---|
| Desktop notifications | on | The operating system notification |
| Alert window | on | Opens with the alarm and takes keyboard focus. Digests never open it |
| Notification sound | off | Uses the operating system's notification sound |

Turn the alert window off if you do not want a window to take focus while you type.

Test it: open the command palette and run **Test notification**. It sends through every channel that
is configured.

Limit: nothing fires while Obsidian is closed. A plugin cannot run in a closed application. This is
why the channels that deliver without it exist.

## 2. ntfy — an alert on your phone with Obsidian closed

[ntfy](https://ntfy.sh) is a free, open-source push service. It can hold a message on the server until
a chosen time, which is what lets the alert arrive while Obsidian is closed.

1. Install the **ntfy** app on your phone (App Store, Google Play, or F-Droid).
2. Subscribe to a topic. Use a long random string, for example `kairos-7f3a9c21b8d4e6f0`.
   **The topic name is the secret.** Anyone who knows it can read your pushes and send you more.
3. In Kairos, open *Settings → Channels* and set:
   - **Send to ntfy** — on
   - **ntfy server** — `https://ntfy.sh`, or your own server
   - **ntfy topic** — the string from step 2
   - **Ntfy access token** — leave empty for `ntfy.sh`
   - **Push scheduling horizon (days)** — 3 by default

   The horizon is three days because `ntfy.sh` refuses a longer delay. Raise it only if you run your
   own server with a larger limit; a longer horizon against the public server means every far-off
   reminder is refused, and Kairos backs off rather than retrying in a loop.

   The push priority is stored at its default, which is *high*, and is not exposed as a setting yet.
4. Run **Test notification** from the command palette. The push must arrive on the phone.

How it works: when the vault index changes, Kairos sends every reminder due inside the horizon to the
server with an `X-At` time. The server holds the message and delivers it at that time. Each
registration carries an id, and the plugin remembers it: a reminder already registered is not
registered again, so one reminder is one push.

Limits, stated in the settings too:

- The server holds a scheduled message for a bounded period. On `ntfy.sh` the default maximum is three
  days. Kairos registers again every time you open the application. If Obsidian stays closed for
  longer than that period, that alert is not delivered.
- Completing or rescheduling a reminder cancels its pending push.
- The iOS app needs a reachable upstream server for instant delivery. If you self-host, read ntfy's
  own documentation for the `upstream-base-url` setting.

Privacy: the **title of the task** leaves your device. The note name is sent only if you turn on
*Include the note name*. Your note text is never sent. The topic name is stored in plaintext in
`data.json`, because Obsidian gives plugins no secret store. Treat it as a password.

## 3. Calendar file — the offline backstop

What you get: an `.ics` file that Kairos keeps in your vault. Your calendar application reads it and
owns the alarm, so the alarm fires with Obsidian closed, offline, and in aeroplane mode. Nothing
leaves the device.

1. In Kairos, open *Settings → Channels* and set:
   - **Write a calendar file** — on
   - **Calendar file path** — where to write it in the vault, default `kairos.ics`
   - **Calendar alarm lead (minutes)** — how long before the due time the alarm fires, default 0
2. Import the file into your calendar application, or subscribe to it.
3. Make sure alerts are enabled in the calendar application.

Limits:

- A calendar application refreshes a *subscribed* file on its own schedule. iOS and Google can take
  hours. For an alert at the exact minute, configure ntfy as well.
- A file you *imported by hand* does not update itself. Import it again after a change.
- Each event carries a stable id, so a re-import updates the events instead of duplicating them.

## Which channel should I use?

| Your goal | Configure |
|---|---|
| Interrupt me while I work at the computer | Desktop (already on) |
| Interrupt me on the phone, at the exact minute | Desktop + ntfy |
| Work with no network, with no account | Desktop + calendar file |
| Nothing leaves my device, ever | Desktop + calendar file |
| All three, with the phone as the last resort | All three |

## What is not shipped in 0.1.0

Bark, Pushover, Telegram, generic webhooks, and the self-hosted relay are designed and described in
`docs/delivery.md`. The code does not implement them yet. `CONTRIBUTING.md` explains how to add a
channel; a channel is one file plus one test.
