/**
 * Scheduling engine (docs/spec/state-model.md §2, §3).
 *
 * Pure with respect to its environment: the clock, the store and the delivery
 * function are injected, so every rule below is covered by tests with a fake
 * clock and no Obsidian.
 */

import type { OutboundMessage, DeliveryResult } from "../channels/types";
import type { KairosSettings, Severity } from "../settings";
import { buildInstanceId, buildTitleHash, type HashFn } from "../parse/instanceId";
import type { ParsedReminder } from "../parse/parseNote";
import { addMinutesToWallClock, isValidTimeZone, offsetMinutesAt, wallClockAt, wallClockParts, zonedWallToEpoch } from "./time";

export type ReminderState = "scheduled" | "armed" | "notified" | "snoozed" | "acked" | "muted" | "missed" | "cancelled";

export interface Lease {
	deviceId: string;
	seq: number;
	expiresAt: number;
}

export interface ReminderRecord {
	schemaVersion: 1;
	instanceId: string;
	sourcePath: string;
	blockId?: string;
	line: number;
	titleHash: string;
	title: string;
	dueLocal: string;
	tzId: string;
	utcOffsetMinutes: number;
	severity: Severity;
	catchUp: KairosSettings["catchUpPolicy"];
	state: ReminderState;
	snoozeCount: number;
	/** Instance id this record took over from, when it was born from a snooze. */
	supersedes?: string;
	/** Message id of the pending server-side push, when the provider returned one. */
	pushId?: string;
	/** The `dueLocal` value the push was registered for. */
	pushFor?: string;
	lease?: Lease;
	firedBy: string[];
	firstSeenAt: number;
	updatedAt: number;
}

export interface FiredRecord {
	instanceId: string;
	sourcePath: string;
	dueLocal: string;
	firedAt: number;
	deviceId: string;
	ageMinutes: number;
	severity: Severity;
}

export interface AckRecord {
	instanceId: string;
	deviceId: string;
	ackedAt: number;
}

export interface DeviceInfo {
	deviceId: string;
	platform: string;
	pluginVersion: string;
	tzId: string;
	lastSeenAt: number;
}

export interface StateStore {
	readInstances(): Promise<ReminderRecord[]>;
	writeInstance(record: ReminderRecord): Promise<void>;
	readAcks(): Promise<AckRecord[]>;
	writeAck(record: AckRecord): Promise<void>;
	readFired(): Promise<FiredRecord[]>;
	appendFired(record: FiredRecord): Promise<void>;
	readLease(instanceId: string): Promise<Lease | null>;
	writeLease(instanceId: string, lease: Lease, options: { createOnly: boolean }): Promise<boolean>;
	writeDevice(info: DeviceInfo): Promise<void>;
}

export const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_DEDUPE_WINDOW_MS = 60 * 1000;
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface DuePlan {
	due: ReminderRecord[];
	catchUp: ReminderRecord[];
	/** Due now: a digest window has arrived, so the tick delivers these as digests. */
	digest: Array<{ record: ReminderRecord; deliverAt: number }>;
	waiting: ReminderRecord[];
	/** Inside the lead window: claim the lease now, deliver at `due`. */
	arming: ReminderRecord[];
	nextWakeAt: number | null;
	dueEpochMs: Map<string, number>;
	/** The window chosen this pass for each folded catch-up, for the engine to remember. */
	foldWindows: Map<string, number>;
}

export interface DuePlanInput {
	records: ReminderRecord[];
	now: number;
	settings: KairosSettings;
	/** Device zone, used when a record carries no zone of its own. */
	tzId: string;
	/** Instances already in this device's fired log. */
	alreadyFired: ReadonlySet<string>;
	/** Windows already pinned for a folded catch-up, so a later tick still delivers it. */
	foldWindows?: ReadonlyMap<string, number>;
}

/** The next configured digest window at or after `epochMs`. */
export function nextDigestAt(epochMs: number, settings: KairosSettings, tzId: string): number {
	const minutes = settings.digestTimes
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^\d{1,2}:\d{2}$/u.test(line));
	if (minutes.length === 0) {
		return epochMs;
	}
	let best: number | null = null;
	for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
		const dayClock = wallClockAt(epochMs + dayOffset * 24 * 60 * 60 * 1000, tzId);
		const day = dayClock.slice(0, 10);
		for (const minute of minutes) {
			const [hour, rest] = minute.split(":");
			const candidate = zonedWallToEpoch(`${day}T${String(hour).padStart(2, "0")}:${rest}`, tzId);
			if (Number.isFinite(candidate) && candidate >= epochMs && (best === null || candidate < best)) {
				best = candidate;
			}
		}
	}
	return best ?? epochMs;
}

export function reminderZone(record: ReminderRecord, fallbackTzId: string): string {
	return record.tzId.length > 0 && isValidTimeZone(record.tzId) ? record.tzId : fallbackTzId;
}

export function recordEpochMs(record: ReminderRecord, fallbackTzId: string): number {
	return zonedWallToEpoch(record.dueLocal, reminderZone(record, fallbackTzId));
}

/** Recomputes the due set from the index on every tick (spec §3). */
export function computeDuePlan(input: DuePlanInput): DuePlan {
	const graceMs = input.settings.graceMinutes * 60000;
	const leadMs = input.settings.leadMinutes * 60000;
	const plan: DuePlan = {
		due: [],
		catchUp: [],
		digest: [],
		waiting: [],
		arming: [],
		nextWakeAt: null,
		dueEpochMs: new Map<string, number>(),
		foldWindows: new Map<string, number>(),
	};
	const wake = (candidate: number): void => {
		if (plan.nextWakeAt === null || candidate < plan.nextWakeAt) {
			plan.nextWakeAt = candidate;
		}
	};
	for (const record of input.records) {
		if (record.state === "acked" || record.state === "cancelled" || record.state === "missed" || record.state === "muted" || record.state === "snoozed") {
			continue;
		}
		if (record.state === "notified" || input.alreadyFired.has(record.instanceId)) {
			continue;
		}
		const due = recordEpochMs(record, input.tzId);
		if (!Number.isFinite(due)) {
			continue;
		}
		plan.dueEpochMs.set(record.instanceId, due);
		if (record.severity === "digest") {
			const deliverAt = nextDigestAt(due, input.settings, input.tzId);
			if (deliverAt <= input.now) {
				plan.digest.push({ record, deliverAt });
			} else {
				plan.waiting.push(record);
				wake(deliverAt);
			}
			continue;
		}
		// `leadMinutes` is the arming window, not an early alert: the timer wakes
		// `lead` before the due time so this device can claim the lease, and the
		// alert itself lands at `due` (spec §3). Re-waking at an `armAt` that is
		// already in the past would spin the timer, so inside the window we wake
		// at `due`. The claim is renewed on every pass while the window is open, so
		// a lead longer than the lease TTL still reserves the alarm.
		const armAt = due - leadMs;
		if (input.now < armAt) {
			plan.waiting.push(record);
			wake(armAt);
			continue;
		}
		if (input.now < due) {
			plan.arming.push(record);
			wake(due);
			continue;
		}
		if (input.now <= due + graceMs) {
			plan.due.push(record);
			continue;
		}
		// Past grace, the record's own catch-up policy decides. `fold_into_digest`
		// means "do not interrupt late": it waits for a digest window exactly like an
		// item whose written time is inside quiet hours, rather than being delivered
		// on the next tick. `skip_and_mark_missed` and the default policy are the
		// tick's business, because they need the store.
		if (record.catchUp === "fold_into_digest") {
			// The window is chosen once, by the pass that first notices the miss, and
			// remembered. Re-deriving it from this pass's `now` would move it forward on
			// every tick: `nextDigestAt` only accepts a candidate at or after `now`, so
			// a tick one millisecond past the window would pick the following one, and
			// the next, and the item would never be delivered at all.
			const pinned = input.foldWindows?.get(record.instanceId);
			const deliverAt = pinned ?? nextDigestAt(input.now, input.settings, input.tzId);
			plan.foldWindows.set(record.instanceId, deliverAt);
			if (deliverAt <= input.now) {
				plan.digest.push({ record, deliverAt });
			} else {
				plan.waiting.push(record);
				wake(deliverAt);
			}
			continue;
		}
		plan.catchUp.push(record);
	}
	return plan;
}

export interface EngineOptions {
	store: StateStore;
	settings: KairosSettings;
	vaultId: string;
	deviceId: string;
	tzId: string;
	clock: () => number;
	/** Platform identifier recorded in the device heartbeat. */
	platform: string;
	pluginVersion: string;
	/** One outcome per instance: the caller collapses the channel fan-out. */
	send: (message: OutboundMessage, record: ReminderRecord) => Promise<DeliveryResult>;
	/** Mirrors into channels that deliver without the app running. */
	sendScheduled?: (message: OutboundMessage, record: ReminderRecord) => Promise<DeliveryResult>;
	onDeliver?: (record: ReminderRecord, message: OutboundMessage, result: DeliveryResult) => void;
	clearScheduled?: (instanceId: string, pushId?: string) => Promise<void>;
	hash?: HashFn;
	leaseTtlMs?: number;
	dedupeWindowMs?: number;
}

/** First retry delay after a rejected registration, doubling per attempt. */
export const SCHEDULE_BACKOFF_BASE_MS = 60 * 1000;

/** Ceiling for that backoff, so a doomed registration retries four times a day. */
export const SCHEDULE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * How long before `due` the last useful registration attempt must happen.
 * `ntfy.sh` requires an `X-At` delay of at least 10 seconds; a minute leaves room
 * for the request to land and the server to hold it.
 */
export const SCHEDULE_RETRY_MARGIN_MS = 60 * 1000;

export interface ServerScheduleResult {
	/** Instances registered (or re-registered) on a server-scheduled channel in this pass. */
	sent: string[];
	/** Instances whose pending push was cancelled. */
	cleared: string[];
	/** Instances the server refused in this pass. */
	failed: string[];
	/** Live instances skipped because an earlier refusal is still in backoff. */
	deferred: string[];
}

export interface TickResult {
	fired: string[];
	digested: string[];
	missed: string[];
	blockedByLease: string[];
	nextWakeAt: number | null;
}

export interface SyncResult {
	created: number;
	updated: number;
	cancelled: number;
}

export interface SnoozeResult {
	oldInstanceId: string;
	newInstanceId: string;
	dueLocal: string;
}

export class ScheduleEngine {
	private readonly records = new Map<string, ReminderRecord>();
	private readonly recentFires = new Map<string, number>();
	/** The digest window pinned for each folded catch-up (see `computeDuePlan`). */
	private foldWindows = new Map<string, number>();
	private firedIds = new Set<string>();
	/** Registrations the provider refused, with the time they may be retried. */
	private scheduleBackoff = new Map<string, { attempts: number; retryAt: number }>();
	private loaded = false;
	/**
	 * The tail of the queue that serializes everything which reads or writes the
	 * record set — `load`, `sync`, `syncServerScheduled`, `ack` and `snooze`.
	 *
	 * Two of those overlap in the ordinary course of a launch, and a registration
	 * decided from a record the other one is halfway through writing is a
	 * duplicate push. `main.start()` awaits `rescan()`, and `rescan()`'s
	 * `scanAll()` fires the index callback for every note it reads; that callback
	 * (`main.applyIndex`) runs its own pass, so the callback's pass is still
	 * awaiting the provider when the rescan's own pass begins. Both then read a
	 * record whose `pushFor` is not written yet and both publish — which is the
	 * duplicate the real plugin produced two seconds apart at launch (observed
	 * in `.testvault`, 2026-09-11: two ids registered at t=0 and t=2 s for one
	 * due time).
	 *
	 * A queued pass runs its own pass after the one it waited for rather than
	 * joining it, unlike `tick`: it mirrors an index that has moved on since that
	 * pass began, so the earlier pass's answer is not its answer.
	 *
	 * `tick` is deliberately outside the queue. Ticks are serialized with each
	 * other, they recompute the due set from wall-clock time on every wake, and
	 * their deliveries go to the local channels, which publish nothing on a
	 * server; a tick that lands mid-pass can only make a record less live, and
	 * the pass only registers a record due in the future.
	 */
	private exclusive: Promise<void> = Promise.resolve();

	constructor(private readonly options: EngineOptions) {}

	/** Runs `operation` once every operation queued before it has finished. */
	private async serialize<T>(operation: () => Promise<T>): Promise<T> {
		const earlier = this.exclusive;
		let release: () => void = () => undefined;
		this.exclusive = new Promise<void>((resolve) => {
			release = resolve;
		});
		await earlier;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	private get leaseTtlMs(): number {
		return this.options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
	}

	private get dedupeWindowMs(): number {
		return this.options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
	}

	async load(): Promise<void> {
		await this.serialize(() => this.loadRecords());
	}

	/** The body of `load`, without the queue: `sync` calls it while holding it. */
	private async loadRecords(): Promise<void> {
		const stored = await this.options.store.readInstances();
		for (const record of stored) {
			this.records.set(record.instanceId, record);
		}
		const fired = await this.options.store.readFired();
		this.firedIds = new Set(fired.map((entry) => entry.instanceId));
		this.loaded = true;
		await this.options.store.writeDevice({
			deviceId: this.options.deviceId,
			platform: this.options.platform,
			pluginVersion: this.options.pluginVersion,
			tzId: this.options.tzId,
			lastSeenAt: this.options.clock(),
		});
	}

	snapshot(): ReminderRecord[] {
		return [...this.records.values()].sort((a, b) => a.dueLocal.localeCompare(b.dueLocal));
	}

	/** Merges a fresh parse of the vault into the stored records. */
	async sync(parsed: ParsedReminder[], now = this.options.clock()): Promise<SyncResult> {
		return this.serialize(() => this.mergeIndex(parsed, now));
	}

	private async mergeIndex(parsed: ParsedReminder[], now: number): Promise<SyncResult> {
		if (!this.loaded) {
			await this.loadRecords();
		}
		const seen = new Set<string>();
		const indexedPaths = new Set<string>();
		// Instances a live snooze successor has taken over. The note still carries
		// the old time, so the index keeps offering it; it has to stay inert instead
		// of firing alongside its successor.
		const superseded = new Set<string>();
		for (const record of this.records.values()) {
			if (record.supersedes !== undefined) {
				superseded.add(record.supersedes);
			}
		}
		const result: SyncResult = { created: 0, updated: 0, cancelled: 0 };
		for (const reminder of parsed) {
			const instanceId = this.instanceIdOf(reminder);
			seen.add(instanceId);
			indexedPaths.add(reminder.sourcePath);
			const stale = superseded.has(instanceId) ? this.records.get(instanceId) : undefined;
			if (stale !== undefined) {
				if (stale.state !== "snoozed") {
					stale.state = "snoozed";
					stale.updatedAt = now;
					await this.options.store.writeInstance(stale);
					result.updated += 1;
				}
				continue;
			}
			const existing = this.records.get(instanceId);
			if (existing) {
				const titleHash = buildTitleHash(reminder.title, this.options.hash);
				if (existing.title !== reminder.title || existing.line !== reminder.line || existing.titleHash !== titleHash) {
					existing.title = reminder.title;
					existing.line = reminder.line;
					existing.titleHash = titleHash;
					existing.severity = reminder.severity;
					existing.updatedAt = now;
					await this.options.store.writeInstance(existing);
					result.updated += 1;
				}
				continue;
			}
			const zone = reminder.tzId.length > 0 && isValidTimeZone(reminder.tzId) ? reminder.tzId : this.options.tzId;
			const due = zonedWallToEpoch(reminder.dueLocal, zone);
			const record: ReminderRecord = {
				schemaVersion: 1,
				instanceId,
				sourcePath: reminder.sourcePath,
				...(reminder.blockId === undefined ? {} : { blockId: reminder.blockId }),
				line: reminder.line,
				titleHash: buildTitleHash(reminder.title, this.options.hash),
				title: reminder.title,
				dueLocal: reminder.dueLocal,
				tzId: zone,
				utcOffsetMinutes: Number.isFinite(due) ? offsetMinutesAt(zone, due) : 0,
				severity: reminder.severity,
				catchUp: this.options.settings.catchUpPolicy,
				state: superseded.has(instanceId) ? "snoozed" : "scheduled",
				snoozeCount: 0,
				firedBy: [],
				firstSeenAt: now,
				updatedAt: now,
			};
			this.records.set(instanceId, record);
			await this.options.store.writeInstance(record);
			result.created += 1;
		}
		for (const record of [...this.records.values()]) {
			if (seen.has(record.instanceId)) {
				continue;
			}
			// A record born from a snooze carries a time that exists only in state
			// until the note is rewritten, so while its source note still exists it
			// is owned by state rather than by the note and must not be cancelled
			// here (spec §5).
			const bornFromSnooze = record.supersedes !== undefined && indexedPaths.has(record.sourcePath);
			if ((record.state === "scheduled" || record.state === "armed") && !bornFromSnooze) {
				record.state = "cancelled";
				const pushId = record.pushId;
				delete record.pushId;
				delete record.pushFor;
				record.updatedAt = now;
				await this.options.store.writeInstance(record);
				await this.clearPush(record.instanceId, pushId);
				result.cancelled += 1;
				continue;
			}
			// A superseded predecessor whose old time has left the note can never be
			// re-created, so it is dropped rather than kept inert forever.
			if (record.state === "snoozed" && record.supersedes === undefined) {
				this.records.delete(record.instanceId);
				continue;
			}
			// A snoozed instance outlives the line it came from: the new time only
			// exists in state until the note is rewritten. Fired and acked
			// instances are history.
			if ((record.state === "notified" || record.state === "acked" || record.state === "missed") && now - record.updatedAt > HISTORY_RETENTION_MS) {
				this.records.delete(record.instanceId);
			}
		}
		return result;
	}

	private inFlightTick: Promise<TickResult> | null = null;

	instanceIdOf(reminder: ParsedReminder): string {
		return buildInstanceId(
			{
				vaultId: this.options.vaultId,
				relPath: reminder.sourcePath,
				blockId: reminder.blockId ?? "",
				dueLocal: reminder.dueLocal,
				occurrenceIndex: 0,
			},
			this.options.hash,
		);
	}

	/**
	 * One tick: recompute the due set, deliver what is due, re-arm the timer.
	 *
	 * Ticks arrive from the interval, the wake timer, a rescan, an ack and a
	 * snooze. Two overlapping ticks see the same instance as due and both deliver
	 * it — the duplicate-alert bug this engine exists to prevent — so they are
	 * serialized: a tick that arrives while one is running joins it rather than
	 * starting a second.
	 */
	async tick(now = this.options.clock()): Promise<TickResult> {
		if (this.inFlightTick) {
			return this.inFlightTick;
		}
		const running = this.runTick(now);
		this.inFlightTick = running;
		try {
			return await running;
		} finally {
			this.inFlightTick = null;
		}
	}

	private async runTick(now: number): Promise<TickResult> {
		const fired: string[] = [];
		const digested: string[] = [];
		const missed: string[] = [];
		const blockedByLease: string[] = [];
		const plan = computeDuePlan({
			records: this.snapshot(),
			now,
			settings: this.options.settings,
			tzId: this.options.tzId,
			alreadyFired: this.firedIds,
			foldWindows: this.foldWindows,
		});
		// Rebuilt from the plan, so a record that is no longer a folded catch-up
		// (delivered, acked, cancelled, or its policy changed) drops its pin.
		this.foldWindows = plan.foldWindows;

		for (const record of plan.catchUp) {
			if (record.catchUp === "skip_and_mark_missed") {
				record.state = "missed";
				record.updatedAt = now;
				await this.options.store.writeInstance(record);
				missed.push(record.instanceId);
				continue;
			}
			plan.due.push(record);
		}

		for (const entry of plan.digest) {
			const record = entry.record;
			const due = plan.dueEpochMs.get(record.instanceId) ?? recordEpochMs(record, this.options.tzId);
			const ageMinutes = Math.max(0, Math.round((now - due) / 60000));
			const delivered = await this.deliver(record, now, ageMinutes, "digest");
			if (delivered) {
				digested.push(record.instanceId);
			}
		}

		for (const record of plan.arming) {
			if (this.suppressed(record.instanceId, now)) {
				continue;
			}
			// Claimed, or renewed, on every pass: the arming window can be longer
			// than the lease TTL, and the claim has to still be ours at `due`.
			const claimed = await this.claimLease(record.instanceId, now);
			if (record.state !== "armed") {
				record.state = "armed";
				record.updatedAt = now;
				await this.options.store.writeInstance(record);
			}
			if (!claimed) {
				blockedByLease.push(record.instanceId);
			}
		}

		for (const record of plan.due) {
			if (this.suppressed(record.instanceId, now)) {
				record.state = "notified";
				record.updatedAt = now;
				await this.options.store.writeInstance(record);
				continue;
			}
			const claimed = await this.claimLease(record.instanceId, now);
			if (!claimed) {
				// Another device holds the claim. "armed" means "we own it and are
				// waiting for the due time" (spec §3), so a refusal leaves the record
				// eligible and it is retried on the next tick instead.
				record.updatedAt = now;
				await this.options.store.writeInstance(record);
				blockedByLease.push(record.instanceId);
				continue;
			}
			const due = plan.dueEpochMs.get(record.instanceId) ?? recordEpochMs(record, this.options.tzId);
			const ageMinutes = Math.max(0, Math.round((now - due) / 60000));
			const delivered = await this.deliver(record, now, ageMinutes, record.severity);
			if (delivered) {
				fired.push(record.instanceId);
			}
		}

		const refreshed = computeDuePlan({
			records: this.snapshot(),
			now,
			settings: this.options.settings,
			tzId: this.options.tzId,
			alreadyFired: this.firedIds,
			foldWindows: this.foldWindows,
		});
		return { fired, digested, missed, blockedByLease, nextWakeAt: refreshed.nextWakeAt };
	}

	private suppressed(instanceId: string, now: number): boolean {
		if (this.firedIds.has(instanceId)) {
			return true;
		}
		const last = this.recentFires.get(instanceId);
		if (last !== undefined && now - last < this.dedupeWindowMs) {
			return true;
		}
		return false;
	}

	private messageFor(record: ReminderRecord, now: number, ageMinutes: number, severity: Severity, actions: boolean): OutboundMessage {
		const due = recordEpochMs(record, this.options.tzId);
		return {
			instanceId: record.instanceId,
			title: record.title,
			noteName: noteNameOf(record.sourcePath),
			dueLocal: record.dueLocal,
			dueEpochMs: Number.isFinite(due) ? due : now,
			severity,
			ageMinutes,
			actions,
		};
	}

	private async deliver(record: ReminderRecord, now: number, ageMinutes: number, severity: Severity): Promise<boolean> {
		const message = this.messageFor(record, now, ageMinutes, severity, true);
		// Claim the instance before awaiting the channel. Delivery is the one slow,
		// re-entrant step in the tick (an OS notification or a network POST), so a
		// claim recorded afterwards would leave a window in which another pass sees
		// the instance as still due.
		this.recentFires.set(record.instanceId, now);
		this.firedIds.add(record.instanceId);
		let result: DeliveryResult = { ok: false, detail: "no delivery function" };
		try {
			result = await this.options.send(message, record);
		} catch (error) {
			result = { ok: false, detail: error instanceof Error ? error.message : "delivery threw" };
		}
		record.state = "notified";
		record.severity = severity;
		record.firedBy = record.firedBy.includes(this.options.deviceId) ? record.firedBy : [...record.firedBy, this.options.deviceId];
		record.updatedAt = now;
		this.recentFires.set(record.instanceId, now);
		this.firedIds.add(record.instanceId);
		await this.options.store.writeInstance(record);
		await this.options.store.appendFired({
			instanceId: record.instanceId,
			sourcePath: record.sourcePath,
			dueLocal: record.dueLocal,
			firedAt: now,
			deviceId: this.options.deviceId,
			ageMinutes,
			severity,
		});
		this.options.onDeliver?.(record, message, result);
		return result.ok;
	}

	/** Create-only lease, renewed with a non-decreasing sequence number. */
	private async claimLease(instanceId: string, now: number): Promise<boolean> {
		try {
			const existing = await this.options.store.readLease(instanceId);
			const expired = existing === null || existing.expiresAt <= now;
			if (expired) {
				const lease: Lease = { deviceId: this.options.deviceId, seq: (existing?.seq ?? 0) + 1, expiresAt: now + this.leaseTtlMs };
				const written = await this.options.store.writeLease(instanceId, lease, { createOnly: existing === null });
				if (written) {
					return true;
				}
				const reread = await this.options.store.readLease(instanceId);
				return reread !== null && reread.deviceId === this.options.deviceId && reread.expiresAt > now;
			}
			if (existing.deviceId === this.options.deviceId) {
				await this.options.store.writeLease(instanceId, { deviceId: this.options.deviceId, seq: existing.seq + 1, expiresAt: now + this.leaseTtlMs }, { createOnly: false });
				return true;
			}
			return false;
		} catch {
			// No readable lease (state not synced, read-only folder): fire locally
			// rather than go silent.
			return true;
		}
	}

	async ack(instanceId: string, now = this.options.clock()): Promise<boolean> {
		return this.serialize(() => this.markAcked(instanceId, now));
	}

	/**
	 * Cancels by the id the record carries, so a registration an in-flight pass
	 * wrote while this ack was queued behind it is withdrawn rather than left to
	 * buzz for a reminder the user just completed.
	 */
	private async markAcked(instanceId: string, now: number): Promise<boolean> {
		const record = this.records.get(instanceId);
		if (!record) {
			return false;
		}
		await this.options.store.writeAck({ instanceId, deviceId: this.options.deviceId, ackedAt: now });
		record.state = "acked";
		const pushId = record.pushId;
		delete record.pushId;
		delete record.pushFor;
		record.updatedAt = now;
		await this.options.store.writeInstance(record);
		await this.clearPush(instanceId, pushId);
		return true;
	}

	async setMuted(instanceId: string, muted: boolean, now = this.options.clock()): Promise<boolean> {
		return this.serialize(async () => {
			const record = this.records.get(instanceId);
			if (!record) {
				return false;
			}
			record.state = muted ? "muted" : "notified";
			record.updatedAt = now;
			await this.options.store.writeInstance(record);
			return true;
		});
	}

	/** Snooze re-keys the instance (spec §1): a new due time is a new identity. */
	async snooze(instanceId: string, minutes: number, now = this.options.clock()): Promise<SnoozeResult | null> {
		return this.serialize(() => this.reschedule(instanceId, minutes, now));
	}

	/**
	 * Cancels the predecessor's push by the id it carries, so a registration an
	 * in-flight pass wrote while this snooze was queued behind it is withdrawn
	 * rather than left to fire beside its successor's.
	 */
	private async reschedule(instanceId: string, minutes: number, now: number): Promise<SnoozeResult | null> {
		const record = this.records.get(instanceId);
		if (!record) {
			return null;
		}
		const dueLocal = addMinutesToWallClock(record.dueLocal, minutes);
		const newInstanceId = buildInstanceId(
			{
				vaultId: this.options.vaultId,
				relPath: record.sourcePath,
				blockId: record.blockId ?? "",
				dueLocal,
				occurrenceIndex: 0,
			},
			this.options.hash,
		);
		record.state = "snoozed";
		const pushId = record.pushId;
		delete record.pushId;
		delete record.pushFor;
		record.updatedAt = now;
		await this.options.store.writeInstance(record);
		const zone = reminderZone(record, this.options.tzId);
		const due = zonedWallToEpoch(dueLocal, zone);
		const next: ReminderRecord = {
			...record,
			instanceId: newInstanceId,
			dueLocal,
			utcOffsetMinutes: Number.isFinite(due) ? offsetMinutesAt(zone, due) : record.utcOffsetMinutes,
			state: "scheduled",
			snoozeCount: record.snoozeCount + 1,
			supersedes: instanceId,
			firedBy: [],
			firstSeenAt: now,
			updatedAt: now,
		};
		delete next.lease;
		this.records.set(newInstanceId, next);
		await this.options.store.writeInstance(next);
		await this.clearPush(instanceId, pushId);
		return { oldInstanceId: instanceId, newInstanceId, dueLocal };
	}

	async snoozeUntil(instanceId: string, dueLocal: string, now = this.options.clock()): Promise<SnoozeResult | null> {
		return this.serialize(async () => {
			const record = this.records.get(instanceId);
			if (!record) {
				return null;
			}
			const parsed = wallClockParts(dueLocal);
			if (!parsed) {
				return null;
			}
			const current = wallClockParts(record.dueLocal);
			if (!current) {
				return null;
			}
			const deltaMs = Date.UTC(parsed.ymd.y, parsed.ymd.m - 1, parsed.ymd.d, parsed.time.hour, parsed.time.minute) -
				Date.UTC(current.ymd.y, current.ymd.m - 1, current.ymd.d, current.time.hour, current.time.minute);
			return this.reschedule(instanceId, Math.round(deltaMs / 60000), now);
		});
	}

	/**
	 * Mirrors the live index into the channels that deliver with Obsidian closed
	 * (docs/spec/state-model.md §7). A live reminder is registered once per due
	 * time: the record remembers the id the provider returned, so an unchanged
	 * reminder is not published a second time — ntfy.sh delivers both copies of a
	 * repeat registration rather than replacing the pending one — and every
	 * registration the index no longer wants is withdrawn by that id.
	 *
	 * The pass reads its clock once it is the only one running, not when it is
	 * called: a pass that waited behind a slow registration with a `now` from
	 * before it would see a due time that has already begun as still ahead, and
	 * register a push for it.
	 */
	async syncServerScheduled(now?: number): Promise<ServerScheduleResult> {
		return this.serialize(() => this.publishServerSchedule(now ?? this.options.clock()));
	}

	private async publishServerSchedule(now: number): Promise<ServerScheduleResult> {
		const result: ServerScheduleResult = { sent: [], cleared: [], failed: [], deferred: [] };
		const send = this.options.sendScheduled;
		if (!send) {
			return result;
		}
		// Bounded by the provider's own limit: ntfy.sh refuses a delay longer than
		// three days (`message-delay-limit`), so the default is three days and a
		// self-hosting user can raise it. The settings object is mutated in place,
		// so a change takes effect on the next pass.
		const horizon = now + this.options.settings.serverScheduleHorizonDays * 24 * 60 * 60 * 1000;
		const live = new Set<string>();
		for (const record of this.snapshot()) {
			if (record.state !== "scheduled" && record.state !== "armed") {
				continue;
			}
			const due = recordEpochMs(record, this.options.tzId);
			if (!Number.isFinite(due) || due <= now || due > horizon) {
				continue;
			}
			// Live before the backoff check: a deferred instance must keep its slot,
			// or the clear pass below would cancel a push that is still wanted.
			live.add(record.instanceId);
			// The push this record already carries is the one the server will deliver
			// at this due time, so publishing it again would deliver a second copy.
			if (record.pushFor === record.dueLocal) {
				continue;
			}
			const backoff = this.scheduleBackoff.get(record.instanceId);
			if (backoff !== undefined && backoff.retryAt > now) {
				result.deferred.push(record.instanceId);
				continue;
			}
			const message = this.messageFor(record, now, 0, record.severity, false);
			try {
				const outcome = await send(message, record);
				if (outcome.ok) {
					this.scheduleBackoff.delete(record.instanceId);
					// A provider that hands back a new id has left the previous
					// registration pending; withdraw it before it can deliver too.
					if (outcome.id !== undefined && record.pushId !== undefined && outcome.id !== record.pushId) {
						await this.clearPush(record.instanceId, record.pushId);
					}
					if (outcome.id !== undefined) {
						record.pushId = outcome.id;
					}
					record.pushFor = record.dueLocal;
					record.updatedAt = now;
					await this.options.store.writeInstance(record);
					result.sent.push(record.instanceId);
				} else {
					this.noteScheduleFailure(record.instanceId, now, due);
					result.failed.push(record.instanceId);
				}
			} catch {
				this.noteScheduleFailure(record.instanceId, now, due);
				result.failed.push(record.instanceId);
			}
		}
		// Every registration the index no longer wants — completed, re-keyed, past
		// due or outside the horizon — is withdrawn by its message id, which is the
		// only handle ntfy.sh honours for a pending scheduled message.
		for (const record of this.snapshot()) {
			if (record.pushFor === undefined || live.has(record.instanceId)) {
				continue;
			}
			const pushId = record.pushId;
			delete record.pushId;
			delete record.pushFor;
			record.updatedAt = now;
			await this.options.store.writeInstance(record);
			await this.clearPush(record.instanceId, pushId);
			result.cleared.push(record.instanceId);
		}
		for (const instanceId of [...this.scheduleBackoff.keys()]) {
			if (!live.has(instanceId)) {
				this.scheduleBackoff.delete(instanceId);
			}
		}
		return result;
	}

	/**
	 * A refused registration is not retried on every pass. Passes happen on every
	 * index change, ack, snooze, rescan and start, so an instant retry would spend
	 * the provider's quota on a request that is known to fail — and a reminder due
	 * beyond the provider's delay limit fails every time until it comes inside it.
	 *
	 * The wait is clamped to just before `due`. A retry that lands after the due
	 * time cannot work: the provider would be asked to deliver in the past, so the
	 * alert would never be registered at all, which is the failure this backoff
	 * exists to bound. Clamping keeps at least one attempt inside the window where
	 * it can still succeed, even after a long outage.
	 */
	private noteScheduleFailure(instanceId: string, now: number, due: number): void {
		const attempts = (this.scheduleBackoff.get(instanceId)?.attempts ?? 0) + 1;
		const delay = Math.min(SCHEDULE_BACKOFF_BASE_MS * 2 ** (attempts - 1), SCHEDULE_BACKOFF_MAX_MS);
		const lastUsefulRetryAt = due - SCHEDULE_RETRY_MARGIN_MS;
		// `Math.max(now, …)`: inside the final margin the deadline is already gone,
		// so retry at once and let the due time itself end the attempts — after it
		// the record leaves the horizon and is skipped.
		const retryAt = Math.max(now, Math.min(now + delay, lastUsefulRetryAt));
		this.scheduleBackoff.set(instanceId, { attempts, retryAt });
	}

	private async clearPush(instanceId: string, pushId?: string): Promise<void> {
		if (!this.options.clearScheduled) {
			return;
		}
		try {
			await this.options.clearScheduled(instanceId, pushId);
		} catch {
			// Cancelling a push is best effort; the server side expires it anyway.
		}
	}
}

export function noteNameOf(sourcePath: string): string {
	const base = sourcePath.split("/").pop() ?? sourcePath;
	return base.replace(/\.md$/u, "");
}

export function messageSummary(message: OutboundMessage): string {
	// Deliberately title-free: every surface composes the title separately (the
	// notification's own title, the modal heading, the ntfy X-Title), so putting it
	// here would print it twice on each of them.
	const parts = [message.dueLocal.slice(11)];
	if (message.ageMinutes >= 1) {
		parts.push(ageOf(message.ageMinutes));
	}
	if (message.noteName) {
		parts.push(message.noteName);
	}
	return parts.join(" · ");
}

export function ageOf(minutes: number): string {
	if (minutes < 60) {
		return `${minutes} min late`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours} h late`;
	}
	return `${Math.round(hours / 24)} d late`;
}
