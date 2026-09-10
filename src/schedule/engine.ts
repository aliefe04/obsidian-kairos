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
	digest: Array<{ record: ReminderRecord; deliverAt: number }>;
	waiting: ReminderRecord[];
	/** Inside the lead window: claim the lease now, deliver at `due`. */
	arming: ReminderRecord[];
	nextWakeAt: number | null;
	dueEpochMs: Map<string, number>;
}

export interface DuePlanInput {
	records: ReminderRecord[];
	now: number;
	settings: KairosSettings;
	/** Device zone, used when a record carries no zone of its own. */
	tzId: string;
	/** Instances already in this device's fired log. */
	alreadyFired: ReadonlySet<string>;
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
		// at `due`.
		// The window opens `lead` before the due time and the claim is renewed on
		// every pass while it is open, so a lead longer than the lease TTL still
		// reserves the alarm.
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
	clearScheduled?: (instanceId: string) => Promise<void>;
	/** How far ahead a server-scheduled push is worth sending. */
	serverScheduleHorizonMs?: number;
	hash?: HashFn;
	leaseTtlMs?: number;
	dedupeWindowMs?: number;
}

/** A week covers the "day ahead" workflow without scheduling the whole year. */
export const DEFAULT_SERVER_SCHEDULE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

export interface ServerScheduleResult {
	/** Instances mirrored to a server-scheduled channel in this pass. */
	sent: string[];
	/** Instances whose pending push was cancelled. */
	cleared: string[];
	/** Instances the server refused; retried on the next pass. */
	failed: string[];
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
	private firedIds = new Set<string>();
	private scheduledPushes = new Set<string>();
	private loaded = false;

	constructor(private readonly options: EngineOptions) {}

	private get leaseTtlMs(): number {
		return this.options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
	}

	private get dedupeWindowMs(): number {
		return this.options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
	}

	async load(): Promise<void> {
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
		if (!this.loaded) {
			await this.load();
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
				record.updatedAt = now;
				await this.options.store.writeInstance(record);
				await this.clearPush(record.instanceId);
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
		});

		for (const record of plan.catchUp) {
			if (record.catchUp === "skip_and_mark_missed") {
				record.state = "missed";
				record.updatedAt = now;
				await this.options.store.writeInstance(record);
				missed.push(record.instanceId);
				continue;
			}
			if (record.catchUp === "fold_into_digest") {
				const deliverAt = nextDigestAt(now, this.options.settings, this.options.tzId);
				plan.digest.push({ record, deliverAt });
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
		const record = this.records.get(instanceId);
		if (!record) {
			return false;
		}
		await this.options.store.writeAck({ instanceId, deviceId: this.options.deviceId, ackedAt: now });
		record.state = "acked";
		record.updatedAt = now;
		await this.options.store.writeInstance(record);
		await this.clearPush(instanceId);
		return true;
	}

	async setMuted(instanceId: string, muted: boolean, now = this.options.clock()): Promise<boolean> {
		const record = this.records.get(instanceId);
		if (!record) {
			return false;
		}
		record.state = muted ? "muted" : "notified";
		record.updatedAt = now;
		await this.options.store.writeInstance(record);
		return true;
	}

	/** Snooze re-keys the instance (spec §1): a new due time is a new identity. */
	async snooze(instanceId: string, minutes: number, now = this.options.clock()): Promise<SnoozeResult | null> {
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
		await this.clearPush(instanceId);
		return { oldInstanceId: instanceId, newInstanceId, dueLocal };
	}

	async snoozeUntil(instanceId: string, dueLocal: string, now = this.options.clock()): Promise<SnoozeResult | null> {
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
		return this.snooze(instanceId, Math.round(deltaMs / 60000), now);
	}

	/**
	 * Mirrors the live index into the channels that deliver with Obsidian closed
	 * (docs/spec/state-model.md §7). Every reminder due inside the horizon is
	 * (re)sent — a repeat is idempotent because the payload carries the instance
	 * identity — and every instance that was acked, completed or re-keyed since
	 * the last pass has its pending push cleared.
	 */
	async syncServerScheduled(now = this.options.clock()): Promise<ServerScheduleResult> {
		const result: ServerScheduleResult = { sent: [], cleared: [], failed: [] };
		const send = this.options.sendScheduled;
		if (!send) {
			return result;
		}
		const horizon = now + (this.options.serverScheduleHorizonMs ?? DEFAULT_SERVER_SCHEDULE_HORIZON_MS);
		const live = new Set<string>();
		for (const record of this.snapshot()) {
			if (record.state !== "scheduled" && record.state !== "armed") {
				continue;
			}
			const due = recordEpochMs(record, this.options.tzId);
			if (!Number.isFinite(due) || due <= now || due > horizon) {
				continue;
			}
			live.add(record.instanceId);
			const message = this.messageFor(record, now, 0, record.severity, false);
			try {
				const outcome = await send(message, record);
				if (outcome.ok) {
					result.sent.push(record.instanceId);
				} else {
					result.failed.push(record.instanceId);
				}
			} catch {
				result.failed.push(record.instanceId);
			}
		}
		for (const instanceId of this.scheduledPushes) {
			if (live.has(instanceId)) {
				continue;
			}
			await this.clearPush(instanceId);
			result.cleared.push(instanceId);
		}
		this.scheduledPushes = live;
		return result;
	}

	private async clearPush(instanceId: string): Promise<void> {
		if (!this.options.clearScheduled) {
			return;
		}
		try {
			await this.options.clearScheduled(instanceId);
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
