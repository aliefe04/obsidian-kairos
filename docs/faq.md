# Frequently asked questions

## How do I install and update it?

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Obsidian's community plugin list,
then use **Add Beta plugin** with `aliefe04/obsidian-kairos`. BRAT reads this repository's releases
and can update the plugin for you — *Check for updates to all beta plugins* in its settings.

If you copied `main.js` and `manifest.json` into `.obsidian/plugins/kairos/` yourself, nothing updates
it: copy both files again after each release, then reload Obsidian. The plugin is not in the community
plugin directory yet.

## Will it alert me when my phone is locked?

It depends on which channel you configured.

| Your setup | Alert with the phone locked |
|---|---|
| Obsidian mobile open, in the foreground | yes, an in-app notice |
| Obsidian mobile in the background, or closed | **no**, and no plugin can do it |
| ntfy push configured | **yes** |
| Calendar file configured | **yes**, from the calendar application |

The row about Obsidian mobile in the background is a platform limit, not a missing feature. Obsidian
mobile cannot run plugin code in the background, and it gives plugins no notification API.
`docs/delivery.md` documents the limit with its sources.

## Why did my reminder not fire?

Work down this list. It is ordered by how often each cause occurs.

1. **Is the note date-scoped?** A bare time works only when the note's own date resolves: a
   frontmatter `date`, an H1 with a date, a date heading above the line, or a file name in a
   configured format. If the file name is ambiguous, such as `08-09-2026`, Kairos refuses it and says
   so with a notice: "N notes could not be date-resolved".
2. **Is the time at the end of the line?** `- [ ] msg to dentist 09:00` works. A time in the middle of
   a sentence does not, unless you write `at` before it. This is deliberate; it prevents a prose time
   from scheduling an alert.
3. **Is the checkbox incomplete?** `- [x]` cancels the reminder.
4. **Was Obsidian running?** The desktop channel needs the application open. See the first question.
5. **Is a channel configured?** Desktop is on by default. ntfy and the calendar file are off
   until you configure them.
6. **Was the alert older than the grace time?** An alert more than 15 minutes overdue is delivered
   late, and the text says how late. With the `skip_and_mark_missed` policy it is not delivered at
   all, and it appears in the agenda as missed.
7. **Did the phone never ring, while the desktop did?** Open the settings and read the *Registered
   channels* line, which is the first item in the *Channels* group. It reports the last pass, for
   example `push scheduling: 3 registered, 2 pending, 1 failed, 1 deferred`. `failed` or `deferred`
   that stays above zero means the push provider refused the registration — usually a wrong topic, a
   revoked token, or a horizon longer than the server allows. The same line is in **Copy
   diagnostics**.

Then run **Copy diagnostics** from the command palette and open an issue with the result. It contains
versions and paths, never note text.

## Why did it fire twice?

Three known causes.

1. **Two devices, no shared state.** The lease that decides which device fires lives in the state
   folder. If that folder is not synchronised, each device fires. Fix: set *State location* to
   *Vault folder*, so your sync tool carries the state, or accept one alert per device.
2. **The same text in two notes.** Each task line is its own reminder. Two identical lines are two
   alerts. The agenda view shows both.
3. **A reminder that was snoozed on one device and not the other.** Snoozing creates a new time. The
   other device still holds the old time until it synchronises.

## Does Kairos change my notes?

By default, no. The state folder holds everything. One setting, *Annotate in note*, allows a snooze to
rewrite the existing time token in place. Even then, Kairos never writes `📅`, `⏳`, `🛫`, `🔁`, `➕`,
`✅`, or Dataview fields.

## Will it break Tasks or Reminder?

No. Kairos reads both syntaxes and writes only `⏰`. It never advances a recurring `🔁` line, because
two plugins advancing one line is how tasks get duplicated. See `docs/spec/syntax.md` §4.

## What data leaves my device?

Nothing, unless you configure a push channel. With ntfy, the task title is sent, and the note name
only if you enable *Include note name*. Your note text and your vault path are never sent. There is no
telemetry and no account.

## Does it work offline?

- Desktop alerts: yes.
- Calendar file: yes, including in aeroplane mode.
- ntfy: the push is registered while you have a network. The delivery itself comes from the server.

## Where is my data, and can I delete it?

The state folder is `.obsidian/plugins/kairos/state/`. It holds reminders, acknowledgements, leases,
the fired log and device heartbeats. Delete it at any time: you lose the history of what already
fired, and you lose nothing about what is planned, because your notes are the source of truth.

## Can I use it with several vaults?

Yes. Each vault has its own settings and its own state folder.

## Why does the agenda show a reminder I cannot see in my note?

You probably snoozed it with *Annotate in note* turned off. The new time exists in the state folder
only, and the note still shows the old time. Turn the setting on if you want your notes to always
reflect the current plan.

## Which Obsidian version do I need?

1.13.0 or later. The settings use the declarative settings API that arrived in 1.13.0, which is also
what makes every setting searchable.
