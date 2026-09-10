# Architecture

Read alongside the two frozen specs: `spec/syntax.md` (what a user writes and what we parse) and
`spec/state-model.md` (identity, states, storage, sync safety).

## 1. Data flow

```mermaid
flowchart LR
    A[Note on disk] -->|metadataCache listItems + cachedRead| B[parseNote]
    B -->|ParsedReminder[]| C[ScheduleEngine.sync]
    C -->|create/update/cancel| D[(state/instances, lease, fired log)]
    C --> E[syncServerScheduled]
    E -->|X-At, rolling horizon| F[server-scheduled channels]
    G[Single next-wake timer] --> H[ScheduleEngine.tick]
    H -->|due set, recomputed every wake| I[local channels]
    I --> J[OS notification + modal with Done/Snooze]
    H -->|ack / snooze| A
    H --> D
```

Three properties are load-bearing:

1. **The index is derived, the note is authoritative.** `state/` can be deleted at any time; the worst
   outcome is that already-fired reminders fire once more.
2. **There is exactly one timer.** It is armed to the earliest `due − lead` in the index and re-armed
   after every index change. Nothing polls per reminder.
3. **A tick recomputes, it does not accumulate.** Throttled windows simply see a larger due set on the
   next wake. This is what makes hidden-window throttling harmless rather than fatal.

## 2. Modules

| Path | Contract |
|---|---|
| `parse/timeTokens.ts` | Token grammar and boundary rules. Pure, no Obsidian imports. Exposes `scanTimes`, `formatHm`, `parseHm`, `TimeMatch` (with `rangeEnd`) |
| `parse/noteDate.ts` | The date cascade and its refusal cases. Pure. Exposes `resolveNoteDate` |
| `parse/parseNote.ts` | List items + text → `ParsedReminder[]`; also `rewriteTimeToken`, the only in-note mutation |
| `parse/locales/*` | Data-only dictionaries: relative words, weekday/month names, meridiem markers |
| `parse/instanceId.ts` | `sha256(vaultId‖relPath‖blockId‖dueLocal‖occurrenceIndex)`, hashing injectable for tests |
| `index/indexer.ts` | Vault scan and per-file debounce; reports ambiguous notes instead of guessing |
| `schedule/time.ts` | Wall-clock ↔ epoch conversion with explicit DST semantics (two-probe) |
| `schedule/engine.ts` | Due plan, lease, dedupe, catch-up, snooze, ack, server-schedule mirroring |
| `schedule/stateStore.ts` | Durability layout; the only module that writes plugin state |
| `channels/types.ts` | `DeliveryChannel` with `mode: 'local' \| 'server-scheduled'` — the extension point |
| `channels/{desktop,ntfy,ics}.ts` | The three shipped channels |
| `ui/*`, `settings.ts`, `main.ts` | Surfaces; `settings.ts` uses the declarative 1.13 API so settings are searchable |

## 3. Invariants

- **No in-note write without re-verification.** Every mutation is one atomic `Vault.process` call that
  re-reads the target line and confirms the expected status character or time token before writing. A
  stale index must never overwrite text the user just typed.
- **Kairos writes only `⏰`.** `📅`, `⏳`, `🛫`, `🔁`, `➕`, `✅` and Dataview fields belong to other
  plugins. Reminder's rule that nothing may sit between `⏰` and `📅` is preserved.
- **Completed is terminal.** Any status character in the configured completing set cancels the
  instance before delivery.
- **A lease never causes silence.** Unreadable lease → fire locally.
- **Severity is decided once, when the note is parsed.** Quiet hours are applied to the time written in
  the note (`parseNote`), and the outcome is stored on the record, so an item due at 23:30 is a digest
  from the moment the file is read. There is exactly one implementation of that rule and it is
  boundary-tested; a delivery-time copy is how the two drift apart. The only later reclassification is
  the user's own catch-up policy — `fold_into_digest` delivers a late item as a digest at the next
  window and records it as one — and `eslint` keeps `obsidian` and `settings.ts` out of `src/parse/`
  so the rule cannot silently move back into the settings module.
- **Mobile parity in the type system, not in prose.** No module may import `electron` outside
  `channels/desktop.ts`, and that module guards on `Platform.isMobileApp`.

## 4. Why these dependencies are absent

| Rejected | Reason |
|---|---|
| `chrono-node` | No Turkish support (locales are fi/fr/it/ja/nl/ru/uk/vi + partial others); a locale pack is 20 lines and gives the community a one-file contribution lane |
| `moment-timezone` | Bundles ~10× the size and *patches* `moment`, so tests would exercise a different runtime than production. `Intl` does what is needed |
| `rrule` | Phase 2 only, and only opt-in per line — advancing `🔁` lines collides with Tasks/Reminder ownership |
| Any UI framework | The surfaces are a modal, a settings tab and one list view; vanilla DOM through the Obsidian API keeps the bundle at 63 KB and the review simple |

## 5. Performance contract

- `onload` is cheap. Indexing starts at `onLayoutReady` — `vault.on('create')` fires for every file at
  startup, and Tasks shipped a headline fix for exactly this mistake (8.3.0, "Stop blocking Obsidian UI
  during startup").
- The scan prefilter is `metadataCache.getFileCache(file).listItems`: notes with no checkboxes are
  never read.
- Work yields between files so the UI thread never blocks.
- Steady-state cost is proportional to changed files: `metadataCache.on('changed')` → debounced
  per-file reparse.
- Target: 10,000 notes / 50,000 list items cold in < 1.5 s. **This is a target, not a measurement** —
  a benchmark script and published numbers are a Phase 1 deliverable (`docs/roadmap.md`).

## 6. Extension points

**A new channel** implements one interface and is registered:

```ts
export interface DeliveryChannel {
	id: string;
	name: string;
	mode: "local" | "server-scheduled";
	isConfigured(settings: KairosSettings): boolean;
	send(message: OutboundMessage, ctx: ChannelContext): Promise<DeliveryResult>;
	clear?(instanceId: string, ctx: ChannelContext): Promise<void>;
}
```

`mode: 'server-scheduled'` means the engine hands the channel upcoming reminders ahead of time
(rolling horizon, re-registered on every index change) so delivery survives the app being closed.
Adding a channel touches no engine code and needs no maintainer approval beyond review — this is the
main community growth lane.

**A new locale** is a data file in `parse/locales/` plus fixtures. No parser change.

## 7. Testing strategy

| Layer | Tool | Gate |
|---|---|---|
| Pure logic (tokens, cascade, engine, ICS, ntfy payload, severity) | vitest, injected clock and in-memory state store | every push; 100 tests in 12 files today |
| Review guidelines | `eslint-plugin-obsidianmd` | every push, zero warnings tolerated |
| Types | `tsc --noEmit` strict with `noUncheckedIndexedAccess` | every push |
| Real app | `scripts/smoke.mjs` — launches real Obsidian with an isolated profile and a throwaway vault, drives it over CDP, asserts the parsed schedule and the fired log | before every release, and after any change to parsing, scheduling or delivery |
| Sync behaviour | the two-profile protocol: device A snoozes while device B's note is unchanged; a claim refused by B and later released; a note edited by hand while a push is pending; A rescans and re-creates a superseded instance | before every release |

Determinism rule: no test may depend on the wall clock or the host timezone. Time is injected; zone
tests name their zone explicitly. `zoneinfo`-style sweeps caught the DST defect in Phase 0.

The rule covers defaults too. The smoke vault pins the plugin's settings and asserts them before it
relies on them, because the production defaults fold an alarm inside quiet hours (22:00 → 07:00) into
the next digest: a harness that writes a note two minutes in the past passed at 21:24 and reported
"fired: 0" at 22:02 with the same code.

It also covers boundaries, and two kinds of them. A test that pins delivery *at* a due time ticks
exactly on it, because that is the rule: the alert fires at `due` (`schedule.engine.test.ts`, the DST
and midnight cases). A test that pins a *digest window* ticks just after it, because `nextDigestAt`
returns the next candidate at or after `now`, so a pass one millisecond late would otherwise choose the
following window: the fold-to-digest test fails against a plan that re-derives its window from the tick
and passes against one that pins it.

## 8. Known platform limits the architecture accepts

| Limit | Architectural response |
|---|---|
| No background execution on mobile | Delegate to T2/T3 tiers (`docs/delivery.md`) and say so in the UI |
| Hidden-window timer throttling | Recompute due sets; never count ticks |
| No secret storage | Capability URLs (long random topic names), plaintext disclosure, title-only payloads |
| Sync is last-write-wins for non-markdown and can duplicate text in markdown | Create-only per-device state files; all user-visible state in the note |
| Two plugins advancing one `🔁` line is undefined | Kairos reads recurrence, never advances it |
