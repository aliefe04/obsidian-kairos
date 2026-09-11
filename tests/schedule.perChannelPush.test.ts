/**
 * One registration per server-scheduled channel.
 *
 * These pin what a single collapsed slot cannot do. With two channels enabled the
 * old engine kept whichever id `combinedResult` happened to return first, so the
 * other channel's registration could never be withdrawn — the reminder fired after
 * the task was completed, and nothing could stop it.
 */

import { describe, expect, it } from "vitest";
import { ChannelRegistry, type ChannelContext, type DeliveryChannel } from "../src/channels/types";
import { channelContext, makeEngine, parsedReminder, scheduledChannelsOf, testSettings, type EngineHarness, type MemoryStore } from "./support";

const HOUR = 60 * 60 * 1000;
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

/**
 * A server-scheduled channel that answers with an id built from its own name, so a
 * withdrawn id names the channel that minted it and a mix-up is visible.
 */
function fakeChannel(id: string): FakeChannel {
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
	// Two server-scheduled stand-ins, so one record holding two registrations is
	// what every scenario here exercises.
	const ntfy = fakeChannel("ntfy");
	const calendar = fakeChannel("calendar");
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

	it("keeps a fired reminder's registration while the note still asks, and retires it without a delete when the line goes", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		await h.engine.syncServerScheduled(NOW);
		expect(h.store.instances.get(id)?.pushIds).toEqual({ ntfy: "ntfy-1", calendar: "calendar-1" });

		// The reminder fires while the app is open. Its line is still in the note,
		// unchecked, so the reminder is still wanted — and the provider has already
		// delivered, or is about to. Deleting the push the moment it rings would read
		// to the provider's clients as the user dismissing the very alert the line
		// still asks for.
		h.setNow(DUE + 60 * 1000);
		await h.engine.tick();
		await h.engine.syncServerScheduled(DUE + 60 * 1000);
		expect(h.calendar.clearedPushIds).toEqual([]);
		expect(h.ntfy.clearedPushIds).toEqual([]);
		expect(h.store.instances.get(id)?.pushIds).toEqual({ ntfy: "ntfy-1", calendar: "calendar-1" });

		// Completing or deleting the line is what removes it: the entry belongs to the
		// line, and the line is gone. The record has fired, so its registration counts
		// as delivered, and a delete sent now would read to a provider's clients as
		// the user dismissing the notification — so it is retired from the record and
		// no later pass repeats it.
		await h.engine.sync([]);
		await h.engine.syncServerScheduled(DUE + 61 * 1000);
		expect(h.calendar.clearedPushIds).toEqual([]);
		expect(h.ntfy.clearedPushIds).toEqual([]);
		expect(h.store.instances.get(id)?.pushIds).toBeUndefined();
	});

	it("retires a muted reminder's registration without a delete", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		await h.engine.syncServerScheduled(NOW);
		expect(h.calendar.clearedPushIds).toEqual([]);

		// Muting means "stop alerting me". The due time has passed, so the provider
		// has delivered the push or is about to, and deleting it would read as the
		// user dismissing the notification: the registration is retired from the
		// record instead, and no later pass repeats it.
		h.setNow(DUE + 60 * 1000);
		await h.engine.setMuted(id, true);
		await h.engine.tick();
		await h.engine.syncServerScheduled(DUE + 60 * 1000);
		expect(h.calendar.clearedPushIds).toEqual([]);
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

	it("schedules a line again when it comes back, unless its time has passed", async () => {
		const h = harness({ now: NOW });
		const future = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		const past = parsedReminder({ dueLocal: "2026-09-11T08:00", sourcePath: "journal/2026/11-09-2026-Friday.md" });
		await h.engine.sync([future, past]);
		const futureId = h.engine.instanceIdOf(future);
		const pastId = h.engine.instanceIdOf(past);
		await h.engine.syncServerScheduled(NOW);
		expect(h.calendar.clearedPushIds).toEqual([]);

		// Both lines are deleted — a mistake, or a tick — so both reminders are
		// cancelled and their entries withdrawn.
		await h.engine.sync([]);
		await h.engine.syncServerScheduled(NOW);
		expect(h.store.instances.get(futureId)?.state).toBe("cancelled");
		expect(h.store.instances.get(pastId)?.state).toBe("cancelled");

		// Undo. The block id comes back with the text, so these are the same instances.
		const back = await h.engine.sync([future, past]);
		expect(back.updated).toBeGreaterThanOrEqual(1);
		// The one still ahead of us is scheduled again, so it registers and will ring.
		expect(h.store.instances.get(futureId)?.state).toBe("scheduled");
		// The one whose time has gone stays cancelled: reviving it would deliver the
		// reminder a second time through the catch-up fire.
		expect(h.store.instances.get(pastId)?.state).toBe("cancelled");

		const pass = await h.engine.syncServerScheduled(NOW);
		expect(pass.sent).toEqual([futureId]);
		// Both channels registered it again, each with its own id.
		const pushes = h.store.instances.get(futureId)?.pushIds ?? {};
		expect(Object.keys(pushes).sort()).toEqual(["calendar", "ntfy"]);
		expect(pushes["ntfy"]).toBeTruthy();
		expect(pushes["calendar"]).toBeTruthy();
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
