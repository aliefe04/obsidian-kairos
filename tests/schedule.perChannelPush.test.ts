/**
 * One registration per server-scheduled channel.
 *
 * These pin what a single collapsed slot cannot do. With two channels enabled the
 * old engine kept whichever id `combinedResult` happened to return first, so the
 * other channel's registration could never be withdrawn — the reminder fired after
 * the task was completed, and nothing could stop it. They also pin the two
 * per-channel capabilities that slot could not express: a horizon of its own (a
 * calendar takes a year, `ntfy.sh` takes three days) and a retirement policy of its
 * own (a delivered `ntfy` push is left alone, a real calendar entry is deleted).
 */

import { describe, expect, it } from "vitest";
import { ChannelRegistry, type ChannelContext, type DeliveryChannel } from "../src/channels/types";
import { channelContext, makeEngine, parsedReminder, scheduledChannelsOf, testSettings, type EngineHarness, type MemoryStore } from "./support";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DUE = Date.UTC(2026, 8, 11, 9, 0);
const NOW = DUE - HOUR;

interface FakeChannel {
	/** Message ids handed to `clear`, in order. */
	clearedPushIds: Array<string | undefined>;
	/** Instance ids handed to `clear`, in order. */
	cleared: string[];
	sent: number;
	channel: DeliveryChannel;
}

interface ChannelOptions {
	horizonDays?: number;
	deleteAfterDue?: boolean;
}

/**
 * A server-scheduled channel that answers with an id built from its own name, so a
 * withdrawn id names the channel that minted it and a mix-up is visible.
 */
function fakeChannel(id: string, options: ChannelOptions = {}): FakeChannel {
	const sent = { count: 0 };
	const clearedPushIds: Array<string | undefined> = [];
	const cleared: string[] = [];
	return {
		clearedPushIds,
		cleared,
		get sent() {
			return sent.count;
		},
		channel: {
			id,
			name: id,
			mode: "server-scheduled",
			isConfigured: () => true,
			scheduleHorizonDays: options.horizonDays,
			deleteAfterDue: options.deleteAfterDue,
			send: async () => {
				sent.count += 1;
				return { ok: true, id: `${id}-${sent.count}` };
			},
			clear: async (instanceId: string, _ctx: ChannelContext, pushId?: string) => {
				cleared.push(instanceId);
				clearedPushIds.push(pushId);
			},
		},
	};
}

interface PerChannelHarness extends EngineHarness {
	ntfy: FakeChannel;
	calendar: FakeChannel;
}

function harness(options: { store?: MemoryStore; now?: number } = {}): PerChannelHarness {
	const settings = testSettings();
	const registry = new ChannelRegistry();
	// The ntfy stand-in: no horizon of its own, so the settings value (three days)
	// decides, and no `deleteAfterDue`, so a passed push is retired and left alone.
	const ntfy = fakeChannel("ntfy");
	const calendar = fakeChannel("calendar", { horizonDays: 366, deleteAfterDue: true });
	registry.register(ntfy.channel);
	registry.register(calendar.channel);
	const context: ChannelContext = channelContext(settings, NOW);
	const engine = makeEngine({
		now: options.now ?? NOW,
		...(options.store === undefined ? {} : { store: options.store }),
		sendScheduled: async (message, _record, channels) => registry.deliverScheduled(message, context, channels),
		clearScheduled: async (instanceId, pushIds) => registry.clearInstance(instanceId, context, pushIds),
		scheduledChannels: scheduledChannelsOf(registry, settings),
	});
	return { ...engine, ntfy, calendar };
}

describe("one registration per server-scheduled channel", () => {
	it("keeps a separate id per channel and withdraws each with its own", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		await h.engine.syncServerScheduled(NOW);

		// Both within their horizon, so both register, and the ids do not collide.
		expect(h.ntfy.sent).toBe(1);
		expect(h.calendar.sent).toBe(1);
		expect(h.store.instances.get(id)?.pushIds).toEqual({ ntfy: "ntfy-1", calendar: "calendar-1" });

		// A second pass over an unchanged reminder publishes nothing, on either.
		await h.engine.syncServerScheduled(NOW + 1000);
		expect(h.ntfy.sent).toBe(1);
		expect(h.calendar.sent).toBe(1);

		await h.engine.ack(id);
		// The ids are not interchangeable: handing ntfy's id to the calendar would
		// delete nothing at all, and the completed task would stay in the list.
		expect(h.ntfy.clearedPushIds).toEqual(["ntfy-1"]);
		expect(h.calendar.clearedPushIds).toEqual(["calendar-1"]);
	});

	it("holds each channel to its own horizon, in the same pass", async () => {
		const h = harness();
		// Two months out: inside the calendar's year, far outside ntfy's three days.
		const far = new Date(DUE + 60 * DAY).toISOString().slice(0, 16);
		const reminder = parsedReminder({ dueLocal: far });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		await h.engine.syncServerScheduled(NOW);

		expect(h.calendar.sent).toBe(1);
		expect(h.ntfy.sent).toBe(0);
		// ntfy is asked nothing, so it records nothing — and when the due time comes
		// inside its horizon it still gets a registration, not a reconsideration.
		expect(h.store.instances.get(id)?.pushIds).toEqual({ calendar: "calendar-1" });
	});

	it("keeps a fired reminder's entry while the note still asks, and lets the line take it away", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		await h.engine.syncServerScheduled(NOW);
		expect(h.store.instances.get(id)?.pushIds).toEqual({ ntfy: "ntfy-1", calendar: "calendar-1" });

		// The reminder fires while the app is open. Its line is still in the note,
		// unchecked, so the task is still open — and Reminders is where the user ticks
		// it off. Deleting the entry the moment it rings would take that away and leave
		// the list out of step with the note.
		h.setNow(DUE + 60 * 1000);
		await h.engine.tick();
		await h.engine.syncServerScheduled(DUE + 60 * 1000);
		expect(h.calendar.clearedPushIds).toEqual([]);
		expect(h.ntfy.clearedPushIds).toEqual([]);
		expect(h.store.instances.get(id)?.pushIds).toEqual({ ntfy: "ntfy-1", calendar: "calendar-1" });

		// Completing or deleting the line is what removes it: the entry belongs to the
		// line, and the line is gone. The record has fired, so its registration counts
		// as delivered, and the withdrawal goes through the pass — where the channel
		// that owns a real entry takes it back and `ntfy`, whose clients read a delete
		// of a delivered notification as a dismissal, is left alone.
		await h.engine.sync([]);
		await h.engine.syncServerScheduled(DUE + 61 * 1000);
		expect(h.calendar.clearedPushIds).toEqual(["calendar-1"]);
		expect(h.ntfy.clearedPushIds).toEqual([]);
		expect(h.store.instances.get(id)?.pushIds).toBeUndefined();
	});

	it("deletes a muted reminder's entry, while the delivered ntfy push is left alone", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		await h.engine.syncServerScheduled(NOW);
		expect(h.calendar.clearedPushIds).toEqual([]);

		// Muting means "stop alerting me", and an entry left in the list would keep
		// alerting: the channel that owns a real entry takes it back. `ntfy` does not,
		// because a delete of a delivered notification reads as the user dismissing it.
		h.setNow(DUE + 60 * 1000);
		await h.engine.setMuted(id, true);
		await h.engine.tick();
		await h.engine.syncServerScheduled(DUE + 60 * 1000);
		expect(h.calendar.clearedPushIds).toEqual(["calendar-1"]);
		expect(h.ntfy.clearedPushIds).toEqual([]);
		expect(h.store.instances.get(id)?.pushFor).toBeUndefined();
	});

	it("does not register a quiet-hours reminder at its folded time", async () => {
		const h = harness();
		// A quiet-hours alarm is parsed as a digest: its alert moved to the digest
		// window, so it has no due-time delivery to hold. Registering it would put a
		// real alarm on the phone at the hour the user asked to be left alone.
		const reminder = parsedReminder({ dueLocal: "2026-09-11T23:30", severity: "digest" });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		await h.engine.syncServerScheduled(NOW);
		expect(h.ntfy.sent).toBe(0);
		expect(h.calendar.sent).toBe(0);
		expect(h.store.instances.get(id)?.pushFor).toBeUndefined();
	});

	it("registers a channel that returns no id once, not on every pass", async () => {
		// `ntfy` answers without an id when the publish body is unparsable, and a
		// channel that names entries after the instance never returns one at all. "No
		// id" means "cannot be withdrawn by handle", not "not registered": leaving it
		// out would republish that reminder on every pass, since every pass would find
		// the channel still outstanding.
		const settings = testSettings();
		const registry = new ChannelRegistry();
		let sends = 0;
		const bare: DeliveryChannel = {
			id: "bare",
			name: "bare",
			mode: "server-scheduled",
			isConfigured: () => true,
			send: async () => {
				sends += 1;
				return { ok: true };
			},
			clear: async () => undefined,
		};
		registry.register(bare);
		const context: ChannelContext = channelContext(settings, NOW);
		const engine = makeEngine({
			now: NOW,
			sendScheduled: async (message, _record, channels) => registry.deliverScheduled(message, context, channels),
			clearScheduled: async (instanceId, pushIds) => registry.clearInstance(instanceId, context, pushIds),
			scheduledChannels: scheduledChannelsOf(registry, settings),
		});
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await engine.engine.sync([reminder]);
		const id = engine.engine.instanceIdOf(reminder);
		await engine.engine.syncServerScheduled(NOW);
		await engine.engine.syncServerScheduled(NOW + 1000);
		await engine.engine.syncServerScheduled(NOW + 2000);

		expect(sends).toBe(1);
		// Recorded as registered, with no handle: the instance id is what a withdrawal
		// falls back to.
		expect(engine.store.instances.get(id)?.pushIds).toEqual({ bare: "" });
	});

	it("leaves a snooze successor's registration alone while the note still shows the old time", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([reminder]);
		const predecessorId = h.engine.instanceIdOf(reminder);
		await h.engine.syncServerScheduled(NOW);
		expect(h.calendar.clearedPushIds).toEqual([]);

		// Snoozed fifty minutes: the successor is a new instance whose time exists
		// only in state until the note is rewritten, so the note still offering the
		// old time is why it is absent from the index — not a reason to strip what it
		// registered. A rescan arrives on every index change, including Kairos's own
		// annotation write, so this happens constantly.
		const snoozed = await h.engine.snooze(predecessorId, 50);
		const successorId = snoozed?.newInstanceId ?? "";
		await h.engine.syncServerScheduled(NOW);
		expect(h.store.instances.get(successorId)?.pushIds).toEqual({ ntfy: "ntfy-2", calendar: "calendar-2" });
		// The snooze itself withdrew the predecessor's registration; what matters here
		// is that the rescan adds nothing to that.
		const ntfyCleared = [...h.ntfy.clearedPushIds];
		const calendarCleared = [...h.calendar.clearedPushIds];

		const rescanned = await h.engine.sync([reminder]);
		expect(rescanned.cancelled).toBe(0);
		expect(h.ntfy.clearedPushIds).toEqual(ntfyCleared);
		expect(h.calendar.clearedPushIds).toEqual(calendarCleared);
		expect(h.store.instances.get(successorId)?.pushIds).toEqual({ ntfy: "ntfy-2", calendar: "calendar-2" });
		expect(h.store.instances.get(successorId)?.pushFor).toBe("2026-09-11T09:50");
	});

	it("hands a successor to the note once the note carries its time, so completing that line withdraws", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([reminder]);
		const predecessorId = h.engine.instanceIdOf(reminder);
		await h.engine.syncServerScheduled(NOW);
		const snoozed = await h.engine.snooze(predecessorId, 50);
		const successorId = snoozed?.newInstanceId ?? "";
		await h.engine.syncServerScheduled(NOW);
		// The snooze withdrew the predecessor's entry; the successor now holds its own.
		expect(h.calendar.clearedPushIds).toEqual(["calendar-1"]);
		expect(h.store.instances.get(successorId)?.pushIds).toEqual({ ntfy: "ntfy-2", calendar: "calendar-2" });

		// The note is rewritten with the new time: it owns the successor now.
		await h.engine.sync([parsedReminder({ dueLocal: "2026-09-11T09:50" })]);
		expect(h.store.instances.get(successorId)?.supersedes).toBeUndefined();

		// So completing that line is an ordinary departure, and the entry goes with
		// it — the state-owned branch would have spared it forever.
		await h.engine.sync([]);
		expect(h.calendar.clearedPushIds).toEqual(["calendar-1", "calendar-2"]);
		expect(h.store.instances.get(successorId)?.pushIds).toBeUndefined();
	});

	it("migrates the pre-channel push id of an existing record", async () => {
		const first = harness();
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await first.engine.sync([reminder]);
		const id = first.engine.instanceIdOf(reminder);
		await first.engine.syncServerScheduled(NOW);

		// Rewind the record to the shape 0.1.2 wrote: one id, no channel attached.
		const stored = first.store.instances.get(id);
		expect(stored).toBeDefined();
		delete stored?.pushIds;
		if (stored !== undefined) {
			stored.pushId = "ntfy-1";
		}

		// A restart over that state. The id was minted when ntfy was the only channel
		// that registered ahead of the due time, so that is where it lands.
		const second = harness({ store: first.store });
		await second.engine.load();
		const migrated = second.engine.snapshot().find((record) => record.instanceId === id);
		expect(migrated?.pushIds).toEqual({ ntfy: "ntfy-1" });
		expect(migrated?.pushId).toBeUndefined();

		// And it still covers the due time: the migration must not turn one
		// registration into two pushes for the same reminder.
		await second.engine.syncServerScheduled(NOW + 1000);
		expect(second.ntfy.sent).toBe(0);
		expect(second.calendar.sent).toBe(1);
	});
});
