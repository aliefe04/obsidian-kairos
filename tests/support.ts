/**
 * Fixtures shared by the suites: settings with the noisy defaults turned off,
 * an in-memory state store, and a reminder factory.
 */

import type { ChannelContext, DeliveryChannel, OutboundMessage } from "../src/channels/types";
import type { ParsedReminder, ParseSettings } from "../src/parse/parseNote";
import {
	ScheduleEngine,
	type AckRecord,
	type DeviceInfo,
	type EngineOptions,
	type FiredRecord,
	type Lease,
	type ReminderRecord,
	type StateStore,
} from "../src/schedule/engine";
import { DEFAULT_SETTINGS, type KairosSettings } from "../src/settings";

export const VAULT_ID = "vault-1";
export const DEVICE_ID = "device-1";

/**
 * Production defaults, minus quiet hours and lead time: the scheduling suites
 * set both explicitly so a reminder is due exactly when it says it is.
 */
export function testSettings(overrides: Partial<KairosSettings> = {}): KairosSettings {
	const base: KairosSettings = { ...DEFAULT_SETTINGS, quietHoursEnabled: false, leadMinutes: 0 };
	return { ...base, ...overrides };
}

export function parseSettings(overrides: Partial<ParseSettings> = {}): ParseSettings {
	const base: ParseSettings = {
		dailyNotesFolder: "",
		dailyNoteFormats: "YYYY-MM-DD",
		useFrontmatterDate: true,
		useHeadingDate: true,
		useFilenameDate: true,
		useDailyNotesFolderDate: true,
		defaultReminderTime: "09:00",
		defaultSeverity: "alarm",
		quietHoursEnabled: false,
		quietHoursStart: "22:00",
		quietHoursEnd: "07:00",
		aggressiveMidLine: false,
		completingStatusChars: "xX-",
	};
	return { ...base, ...overrides };
}

export function parsedReminder(overrides: Partial<ParsedReminder> & { dueLocal: string }): ParsedReminder {
	const base: ParsedReminder = {
		sourcePath: "journal/2026/11-09-2026-Friday.md",
		line: 0,
		statusChar: " ",
		title: "msg to dentist",
		dueLocal: "2026-09-11T09:00",
		tzId: "UTC",
		syntax: "bare-end",
		severity: "alarm",
	};
	return { ...base, ...overrides };
}

/** The alert payload the engine builds, with no Obsidian in sight. */
export function outboundMessage(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
	const base: OutboundMessage = {
		instanceId: "instance-1",
		title: "msg to dentist",
		noteName: "11-09-2026-Friday",
		dueLocal: "2026-09-11T09:00",
		dueEpochMs: Date.UTC(2026, 8, 11, 9, 0),
		severity: "alarm",
		ageMinutes: 0,
		actions: false,
	};
	return { ...base, ...overrides };
}

/** A channel context whose UI actions are inert: no suite drives the interface. */
export function channelContext(settings: KairosSettings, now: number, overrides: Partial<ChannelContext> = {}): ChannelContext {
	return {
		now,
		deviceId: DEVICE_ID,
		tzId: "UTC",
		settings,
		openInstance: () => undefined,
		ack: () => undefined,
		snooze: () => undefined,
		...overrides,
	};
}

/** The state store contract, in memory: one writer per file becomes one map entry. */
export class MemoryStore implements StateStore {
	readonly instances = new Map<string, ReminderRecord>();
	readonly acks: AckRecord[] = [];
	readonly fired: FiredRecord[] = [];
	readonly leases = new Map<string, Lease>();
	readonly devices: DeviceInfo[] = [];

	async readInstances(): Promise<ReminderRecord[]> {
		const records: ReminderRecord[] = [];
		for (const record of this.instances.values()) {
			records.push({ ...record, firedBy: [...record.firedBy] });
		}
		return records;
	}

	async writeInstance(record: ReminderRecord): Promise<void> {
		this.instances.set(record.instanceId, { ...record, firedBy: [...record.firedBy] });
	}

	async readAcks(): Promise<AckRecord[]> {
		const acks: AckRecord[] = [];
		for (const ack of this.acks) {
			acks.push({ ...ack });
		}
		return acks;
	}

	async writeAck(record: AckRecord): Promise<void> {
		this.acks.push({ ...record });
	}

	async readFired(): Promise<FiredRecord[]> {
		const fired: FiredRecord[] = [];
		for (const entry of this.fired) {
			fired.push({ ...entry });
		}
		return fired;
	}

	async appendFired(record: FiredRecord): Promise<void> {
		this.fired.push({ ...record });
	}

	async readLease(instanceId: string): Promise<Lease | null> {
		const lease = this.leases.get(instanceId);
		return lease ? { ...lease } : null;
	}

	async writeLease(instanceId: string, lease: Lease, options: { createOnly: boolean }): Promise<boolean> {
		const existing = this.leases.get(instanceId);
		if (options.createOnly && existing !== undefined && existing.deviceId !== lease.deviceId) {
			return false;
		}
		this.leases.set(instanceId, { ...lease });
		return true;
	}

	async writeDevice(info: DeviceInfo): Promise<void> {
		this.devices.push({ ...info });
	}
}

export interface SentMessage {
	message: OutboundMessage;
	record: ReminderRecord;
}

export interface EngineHarness {
	engine: ScheduleEngine;
	store: MemoryStore;
	sent: SentMessage[];
	cleared: string[];
	setNow(epochMs: number): void;
}

export interface HarnessOptions {
	settings?: Partial<KairosSettings>;
	tzId?: string;
	deviceId?: string;
	now?: number;
	store?: MemoryStore;
	hash?: EngineOptions["hash"];
	leaseTtlMs?: number;
	dedupeWindowMs?: number;
	send?: EngineOptions["send"];
	sendScheduled?: EngineOptions["sendScheduled"];
	clearScheduled?: EngineOptions["clearScheduled"];
	scheduledChannels?: EngineOptions["scheduledChannels"];
}

/**
 * The engine's view of a registry's server-scheduled channels, composed the way
 * `main.ts` composes it: registration is filtered by configuration, withdrawal
 * and cleanup are not, so a channel switched off after registering can still be
 * asked to take its registration back.
 */
export function scheduledChannelsOf(
	registry: { all(): DeliveryChannel[] },
	settings: KairosSettings,
): EngineOptions["scheduledChannels"] {
	return () =>
		registry
			.all()
			.filter((channel) => channel.mode === "server-scheduled")
			.map((channel) => ({
				id: channel.id,
				configured: channel.isConfigured(settings),
				horizonDays: channel.scheduleHorizonDays,
				deleteAfterDue: channel.deleteAfterDue,
			}));
}

export function makeEngine(options: HarnessOptions = {}): EngineHarness {
	const store = options.store ?? new MemoryStore();
	const sent: SentMessage[] = [];
	const cleared: string[] = [];
	let nowMs = options.now ?? 0;
	const engine = new ScheduleEngine({
		store,
		settings: testSettings(options.settings),
		vaultId: VAULT_ID,
		deviceId: options.deviceId ?? DEVICE_ID,
		tzId: options.tzId ?? "UTC",
		platform: "test",
		pluginVersion: "0.0.0",
		clock: () => nowMs,
		send:
			options.send ??
			((message, record) => {
				sent.push({ message, record });
				return Promise.resolve({ ok: true });
			}),
		sendScheduled: options.sendScheduled,
		scheduledChannels: options.scheduledChannels,
		clearScheduled:
			options.clearScheduled ??
			((instanceId) => {
				cleared.push(instanceId);
				return Promise.resolve();
			}),
		onDeliver: undefined,
		hash: options.hash,
		leaseTtlMs: options.leaseTtlMs,
		dedupeWindowMs: options.dedupeWindowMs,
	});
	return {
		engine,
		store,
		sent,
		cleared,
		setNow: (epochMs: number) => {
			nowMs = epochMs;
		},
	};
}
