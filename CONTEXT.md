# CONTEXT — the words this project uses

One page. These terms have exactly one meaning in this repository, and the two specification files are
their source of truth:

- `docs/spec/syntax.md` — what a person writes in a note, and what the parser accepts.
- `docs/spec/state-model.md` — how a reminder is identified, scheduled, stored and synchronised.

If this page and a specification disagree, the specification wins. Change the specification first.

## The model

| Term | Meaning |
|---|---|
| **note date** | The date a note belongs to. Kairos finds it from frontmatter, H1, the nearest preceding date heading, the file name, or the Daily Notes folder. `syntax.md` §2 |
| **date-scoped note** | A note whose date resolves. A bare time works only in such a note. `syntax.md` §2 |
| **task line** | A list item with a checkbox. It carries the alert time. `syntax.md` §1, §3 |
| **form A / B / C / D** | The four write forms. A and B are a bare time at the end or the start of the line. C is an explicit date. D is another plugin's form. `syntax.md` §1 |
| **reminder** | A task line with a resolved alert time. |
| **instance** | One occurrence of a reminder. The engine schedules instances, never lines. `state-model.md` §1 |
| **instance id** | `sha256(vaultId ‖ relPath ‖ blockId? ‖ dueLocalISO ‖ occurrenceIndex)`. The identity of an instance. Editing a title keeps the identity; changing the time creates a new one. `state-model.md` §1 |
| **dueLocal** | The alert time, written `YYYY-MM-DDTHH:mm` in local wall clock. Never an epoch, because an epoch is a promise about a timezone. `state-model.md` §1, §2 |
| **severity** | `alarm` interrupts now. `digest` waits for a configured window. `state-model.md` §3 |
| **state** | One of `scheduled`, `armed`, `notified`, `snoozed`, `acked`, `muted`, `missed`, `cancelled`. `state-model.md` §2 |
| **arming window** | The time before `due`, of length `leadMinutes`. Inside it the record is `armed` and holds the lease. `state-model.md` §3 |
| **lead** | `leadMinutes`. The length of the arming window. It is not an early alert: the alert fires at `due`. `state-model.md` §3 |
| **lease** | The small file that decides which device may fire. Written create-only, renewed with a non-decreasing sequence number. "To claim" is the action; the lease is the object. `state-model.md` §3 |
| **catch-up** | What happens when the alert time passed while the application was closed. The policy is per reminder: `fire_now_with_age`, `fold_into_digest`, or `skip_and_mark_missed`. `state-model.md` §3 |
| **grace** | The time after `due` during which an alert still counts as on time. Default 15 minutes. `delivery.md` |
| **supersede** | A snooze creates a successor instance with a new time. The successor records `supersedes`, the predecessor becomes `snoozed` and stays inert. `state-model.md` §2, §3 |
| **fired log** | The append-only file per device that records the alerts which fired. `state-model.md` §3, §4 |
| **state folder** | `.obsidian/plugins/kairos/state/`. It holds instances, acks, leases, the fired log and device heartbeats. Deleting it loses history, never a reminder. `state-model.md` §4 |
| **delivery tier (T1–T4)** | Four ways to reach a person: desktop notification, `.ics` in the vault, webhook push, self-hosted relay. `delivery.md` |
| **channel** | One delivery path in the code: `desktop`, `ntfy`, `ics`. Each declares a mode: `local` or `server-scheduled`. `src/channels/types.ts` |

## Names that are not ours

| Name | What it is |
|---|---|
| **ntfy** | A third-party open-source push service (`ntfy.sh`), by Philipp Heckel. The name is "notify" with the vowels removed. Kairos posts to a topic on it, or to a server you host yourself. |
| **Tasks**, **Reminder** | Other Obsidian plugins. Kairos reads their syntax and writes only `⏰`. `syntax.md` §4 |
| **Obsidian**, **Obsidian Sync**, **BRAT** | The application, its sync service, and the community beta installer. |
| **VALARM**, **VEVENT**, **`.ics`** | Calendar file format terms (RFC 5545). |

## Words we avoid

| Avoid | Use | Why |
|---|---|---|
| "notification" for an in-app toast | **notice** | `Notice` is the Obsidian class for an in-app toast. It is not an operating system notification. |
| "alert" for a digest | **digest** | A digest is deliberately batched and non-interruptive. |
| "claim" as a noun | **lease** | "Claim" is the action. |
| "due date" | **dueLocal** | The project schedules times, not dates. |
