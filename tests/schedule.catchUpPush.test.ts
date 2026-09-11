import { describe, expect, it } from "vitest";
import { ChannelRegistry, combinedResult, type ChannelContext, type DeliveryChannel, type OutboundMessage } from "../src/channels/types";
import type { KairosSettings } from "../src/settings";
import { channelContext, makeEngine, outboundMessage, parsedReminder, scheduledChannelsOf, testSettings, type EngineHarness } from "./support";

const DUE = Date.UTC(2026, 8, 11, 9, 0);
const DUE_LOCAL = "2026-09-11T09:00";
const NOW = DUE - 60 * 60 * 1000;

interface FakeChannel {
	sent: OutboundMessage[];
	/** Instance ids handed to `clear`, in order. */
	cleared: string[];
	/** The message id each clear carried; `undefined` when the record had none. */
	clearedPushIds: Array<string | undefined>;
	channel: DeliveryChannel;
}

/** A channel that records what the registry hands it, in one mode or the other. */
function fakeChannel(id: string, mode: "local" | "server-scheduled"): FakeChannel {
	const sent: OutboundMessage[] = [];
	const cleared: string[] = [];
	const clearedPushIds: Array<string | undefined> = [];
	return {
		sent,
		cleared,
		clearedPushIds,
		channel: {
			id,
			name: id,
			mode,
			isConfigured: () => true,
			send: async (message) => {
				sent.push(message);
				return { ok: true, id: `push-${sent.length}` };
			},
			// A local channel cannot cancel anything on a server, so it has no clear.
			...(mode === "server-scheduled"
				? {
						clear: async (instanceId: string, _ctx: ChannelContext, pushId?: string) => {
							cleared.push(instanceId);
							clearedPushIds.push(pushId);
						},
					}
				: {}),
		},
	};
}

interface FireHarness extends EngineHarness {
	server: FakeChannel;
	local: FakeChannel;
	/** The fan-out each fire was routed to, in order. */
	fires: Array<{ instanceId: string; serverScheduled: boolean }>;
}

/**
 * The fire path wired the way `main.ts` wires it — the engine, the store and the
 * registry — plus a stub that records which branch the engine asked for, so a
 * test can tell "delivered locally because a registration covers it" from
 * "published everywhere because nothing does".
 */
function harness(): FireHarness {
	const settings: KairosSettings = testSettings();
	const registry = new ChannelRegistry();
	const server = fakeChannel("fake-server", "server-scheduled");
	const local = fakeChannel("fake-local", "local");
	registry.register(server.channel);
	registry.register(local.channel);
	const context: ChannelContext = channelContext(settings, NOW);
	const fires: FireHarness["fires"] = [];
	const engine = makeEngine({
		now: NOW,
		send: async (message, _record, serverScheduled) => {
			fires.push({ instanceId: message.instanceId, serverScheduled });
			const results = serverScheduled
				? await registry.deliverLocal(message, context)
				: await registry.deliver(message, context);
			return combinedResult(results);
		},
		sendScheduled: async (message, _record, channels) => registry.deliverScheduled(message, context, channels),
		clearScheduled: async (instanceId, pushIds) => registry.clearInstance(instanceId, context, pushIds),
		scheduledChannels: scheduledChannelsOf(registry, settings),
	});
	return { ...engine, server, local, fires };
}

describe("the fire path and the registration that covers it", () => {
	it("delivers a fire its registration covers through the local channels only", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		expect((await h.engine.syncServerScheduled(NOW)).sent).toEqual([id]);
		expect(h.server.sent).toHaveLength(1);

		h.setNow(DUE + 30 * 1000);
		const tick = await h.engine.tick();
		expect(tick.fired).toEqual([id]);
		// The callback was told a registration covers this due time, so the fire is
		// local: publishing here would be a second push for one due time.
		expect(h.fires).toEqual([{ instanceId: id, serverScheduled: true }]);
		expect(h.local.sent.map((message) => message.instanceId)).toEqual([id]);
		expect(h.server.sent).toHaveLength(1);

		// The registration itself is untouched by the fire — it is the push the
		// provider is holding for this due time.
		expect(h.store.instances.get(id)?.pushIds?.["fake-server"]).toBe("push-1");
		expect(h.store.instances.get(id)?.pushFor).toBe(DUE_LOCAL);
	});

	it("publishes a catch-up fire no registration covers", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);

		// The app was closed at the due minute: the pass registers only a due time
		// still ahead, so nothing server-side holds this one. Firing locally only
		// would leave the phone silent while the record reads as delivered.
		h.setNow(DUE + 20 * 60 * 1000);
		const tick = await h.engine.tick();
		expect(tick.fired).toEqual([id]);
		expect(h.fires).toEqual([{ instanceId: id, serverScheduled: false }]);
		// One publish for that due time, on the channel that holds registrations,
		// and the alert the user sees at launch.
		expect(h.server.sent.map((message) => message.instanceId)).toEqual([id]);
		expect(h.local.sent.map((message) => message.instanceId)).toEqual([id]);
	});

	it("withdraws a registration by id when the pass retires a record completed before its due time", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		await h.engine.syncServerScheduled(NOW);

		// A completion the index finds cancels its push inline; this drives the pass
		// itself, whose job is a registration left on a record the index no longer
		// wants while the due time is still ahead — a genuine cancellation.
		const record = h.engine.snapshot().find((entry) => entry.instanceId === id);
		expect(record).toBeDefined();
		if (record === undefined) {
			throw new Error("the reminder is missing from the engine");
		}
		record.state = "cancelled";

		const pass = await h.engine.syncServerScheduled();
		expect(pass.cleared).toEqual([id]);
		expect(h.server.cleared).toEqual([id]);
		expect(h.server.clearedPushIds).toEqual(["push-1"]);
		expect(h.store.instances.get(id)?.pushIds?.["fake-server"]).toBeUndefined();
		expect(h.store.instances.get(id)?.pushFor).toBeUndefined();
	});

	it("retires a passed registration without deleting it on the phone", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		await h.engine.syncServerScheduled(NOW);

		h.setNow(DUE + 2 * 60 * 1000);
		expect((await h.engine.tick()).fired).toEqual([id]);
		expect(h.fires).toEqual([{ instanceId: id, serverScheduled: true }]);

		// The registration is retired from the record — no later pass repeats it —
		// but the provider is not asked to delete it: it has delivered that push or
		// is about to, and a delete of a delivered notification is read by the
		// phone's client as the user dismissing it.
		const pass = await h.engine.syncServerScheduled();
		expect(pass.cleared).toEqual([id]);
		expect(h.server.cleared).toEqual([]);
		expect(h.server.clearedPushIds).toEqual([]);
		expect(h.store.instances.get(id)?.pushIds?.["fake-server"]).toBeUndefined();
		expect(h.store.instances.get(id)?.pushFor).toBeUndefined();
	});

	it("keeps the registration of a record that is about to fire, and retires it after the fire", async () => {
		// A reminder registered before the app closed and due while it was shut.
		// `main.start()` reaches the pass from `applyIndex` and the catch-up tick
		// only after it, so the pass runs over a record whose due time has passed.
		// `armed` is the record inside the arming window and `scheduled` the one
		// before it; both are still waiting to fire, and both own their marker.
		for (const state of ["armed", "scheduled"] as const) {
			const h = harness();
			const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
			await h.engine.sync([reminder]);
			const id = h.engine.instanceIdOf(reminder);
			expect((await h.engine.syncServerScheduled(NOW)).sent).toEqual([id]);

			const record = h.engine.snapshot().find((entry) => entry.instanceId === id);
			expect(record).toBeDefined();
			if (record === undefined) {
				throw new Error("the reminder is missing from the engine");
			}
			record.state = state;

			// The relaunch pass, past the due time. It leaves the marker alone: the
			// catch-up that follows is the fire that reads it to learn the provider
			// already holds a push for this due time.
			h.setNow(DUE + 2 * 60 * 1000);
			const pass = await h.engine.syncServerScheduled();
			expect(pass.sent).toEqual([]);
			expect(pass.cleared).toEqual([]);
			expect(h.server.sent).toHaveLength(1);
			expect(h.store.instances.get(id)?.pushIds?.["fake-server"]).toBe("push-1");
			expect(h.store.instances.get(id)?.pushFor).toBe(DUE_LOCAL);

			const tick = await h.engine.tick();
			expect(tick.fired).toEqual([id]);
			// Told a registration covers this due time, so the catch-up goes to the
			// local channels only: publishing here would deliver a second copy of a
			// push the phone has already been sent.
			expect(h.fires).toEqual([{ instanceId: id, serverScheduled: true }]);
			expect(h.server.sent.map((message) => message.instanceId)).toEqual([id]);
			expect(h.local.sent.map((message) => message.instanceId)).toEqual([id]);

			// The fire wrote `notified`, so the record has left the waiting set: the
			// pass after it drops the marker, and still sends no delete — the
			// provider has delivered that push or is about to.
			const after = await h.engine.syncServerScheduled();
			expect(after.cleared).toEqual([id]);
			expect(h.server.cleared).toEqual([]);
			expect(h.server.clearedPushIds).toEqual([]);
			expect(h.store.instances.get(id)?.pushIds?.["fake-server"]).toBeUndefined();
			expect(h.store.instances.get(id)?.pushFor).toBeUndefined();
		}
	});

	it("keeps a server-scheduled channel out of the local fan-out but not out of the test fan-out", async () => {
		const registry = new ChannelRegistry();
		const local = fakeChannel("fake-local", "local");
		const server = fakeChannel("fake-server", "server-scheduled");
		registry.register(local.channel);
		registry.register(server.channel);
		const context = channelContext(testSettings(), NOW);
		const message = outboundMessage();

		await registry.deliverLocal(message, context);
		expect(local.sent).toEqual([message]);
		expect(server.sent).toEqual([]);

		await registry.deliver(message, context);
		expect(server.sent).toEqual([message]);
	});
});
