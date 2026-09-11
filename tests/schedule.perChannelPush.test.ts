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

	it("deletes a passed registration only where the channel asks for it", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		await h.engine.syncServerScheduled(NOW);
		expect(h.store.instances.get(id)?.pushIds).toEqual({ ntfy: "ntfy-1", calendar: "calendar-1" });

		// The reminder comes due while the app is open and is delivered locally, so
		// the registrations have served their purpose and the record leaves the live
		// set with its due time behind it.
		h.setNow(DUE + 60 * 1000);
		await h.engine.tick();
		await h.engine.syncServerScheduled(DUE + 60 * 1000);

		// A calendar entry is deleted, or a task completed at 09:00 would still sit
		// in the list at 10:00. The ntfy push is not: its own clients read a delete of
		// a delivered notification as the user dismissing it.
		expect(h.calendar.clearedPushIds).toEqual(["calendar-1"]);
		expect(h.ntfy.clearedPushIds).toEqual([]);
		// Either way the record stops claiming the registration.
		expect(h.store.instances.get(id)?.pushFor).toBeUndefined();
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
