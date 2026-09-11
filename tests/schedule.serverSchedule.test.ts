import { describe, expect, it } from "vitest";
import { ChannelRegistry, combinedResult, type ChannelContext, type DeliveryChannel, type OutboundMessage } from "../src/channels/types";
import type { KairosSettings } from "../src/settings";
import { channelContext, makeEngine, parsedReminder, testSettings, type EngineHarness, type MemoryStore } from "./support";

const DUE = Date.UTC(2026, 8, 11, 9, 0);
const NOW = DUE - 60 * 60 * 1000;

interface FakeChannel {
	sent: OutboundMessage[];
	/** Instance ids handed to `clear`, in order. */
	cleared: string[];
	/** The message id each clear carried; `undefined` when the record had none. */
	clearedPushIds: Array<string | undefined>;
	channel: DeliveryChannel;
}

/**
 * A channel that records what the registry hands it, in one mode or the other.
 * A server-scheduled send answers with the message id a real provider returns,
 * numbered by publish order so a superseded registration is identifiable.
 */
function fakeChannel(id: string, mode: "local" | "server-scheduled", configured = true): FakeChannel {
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
			isConfigured: () => configured,
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

interface ServerHarness extends EngineHarness {
	server: FakeChannel;
	local: FakeChannel;
}

function harness(options: { serverConfigured?: boolean; store?: MemoryStore } = {}): ServerHarness {
	const settings: KairosSettings = testSettings();
	const registry = new ChannelRegistry();
	const server = fakeChannel("fake-server", "server-scheduled", options.serverConfigured ?? true);
	const local = fakeChannel("fake-local", "local");
	registry.register(server.channel);
	registry.register(local.channel);
	const context: ChannelContext = channelContext(settings, NOW);
	const engine = makeEngine({
		now: NOW,
		store: options.store,
		sendScheduled: async (message) => combinedResult(await registry.deliverScheduled(message, context)),
		clearScheduled: async (instanceId, pushId) => registry.clearInstance(instanceId, context, pushId),
	});
	return { ...engine, server, local };
}

describe("ScheduleEngine syncServerScheduled", () => {
	it("contacts the server-scheduled channel when the index gains a live reminder", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);

		const result = await h.engine.syncServerScheduled();
		expect(result.sent).toEqual([id]);
		expect(result.failed).toEqual([]);
		expect(h.server.sent).toHaveLength(1);
		expect(h.server.sent[0]?.instanceId).toBe(id);
		expect(h.server.sent[0]?.title).toBe("msg to dentist");
		expect(h.server.sent[0]?.dueLocal).toBe("2026-09-11T09:00");
		expect(h.server.sent[0]?.severity).toBe("alarm");
		expect(h.local.sent).toEqual([]);
	});

	it("leaves the channel alone when it is not configured", async () => {
		const h = harness({ serverConfigured: false });
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([reminder]);
		const result = await h.engine.syncServerScheduled();
		expect(result.sent).toEqual([]);
		expect(h.server.sent).toEqual([]);
	});

	it("registers an unchanged reminder once and keeps its message id", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);

		const first = await h.engine.syncServerScheduled();
		expect(first.sent).toEqual([id]);
		const second = await h.engine.syncServerScheduled();
		expect(second.sent).toEqual([]);
		expect(second.cleared).toEqual([]);
		expect(h.server.sent).toHaveLength(1);
		expect(h.store.instances.get(id)?.pushId).toBe("push-1");
		expect(h.store.instances.get(id)?.pushFor).toBe("2026-09-11T09:00");
	});

	it("clears the pending push when the instance is acked", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		await h.engine.syncServerScheduled();
		expect(h.server.cleared).toEqual([]);

		await h.engine.ack(id);
		expect(h.server.cleared).toEqual([id]);
		expect(h.server.clearedPushIds).toEqual(["push-1"]);
		expect(h.local.cleared).toEqual([]);
		expect(h.store.instances.get(id)?.pushFor).toBeUndefined();
	});

	it("cancels the predecessor by its message id when the instance is snoozed", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		await h.engine.syncServerScheduled();

		await h.engine.snooze(id, 30);
		expect(h.server.cleared).toEqual([id]);
		expect(h.server.clearedPushIds).toEqual(["push-1"]);
	});

	it("clears the old push and schedules the new one when the line's time is edited", async () => {
		const h = harness();
		const before = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([before]);
		const beforeId = h.engine.instanceIdOf(before);
		await h.engine.syncServerScheduled();

		const edited = parsedReminder({ dueLocal: "2026-09-11T09:50" });
		const afterId = h.engine.instanceIdOf(edited);
		expect(afterId).not.toBe(beforeId);
		const sync = await h.engine.sync([edited]);
		expect(sync.cancelled).toBe(1);
		expect(h.server.cleared).toEqual([beforeId]);
		expect(h.server.clearedPushIds).toEqual(["push-1"]);

		const result = await h.engine.syncServerScheduled();
		expect(result.sent).toEqual([afterId]);
		expect(h.server.sent.map((message) => message.instanceId)).toEqual([beforeId, afterId]);
	});

	it("re-registers a reminder whose due time moved, withdrawing the superseded id", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		await h.engine.syncServerScheduled();
		expect(h.store.instances.get(id)?.pushId).toBe("push-1");

		// The record can hold a due time that no longer matches the push it carries
		// — a folded catch-up or an external edit leaves that behind — and the stale
		// registration must be withdrawn rather than left to fire.
		const record = h.engine.snapshot().find((entry) => entry.instanceId === id);
		expect(record).toBeDefined();
		if (record === undefined) {
			throw new Error("the reminder is missing from the engine");
		}
		record.dueLocal = "2026-09-11T09:50";

		const pass = await h.engine.syncServerScheduled();
		expect(pass.sent).toEqual([id]);
		expect(h.server.sent).toHaveLength(2);
		expect(h.server.cleared).toEqual([id]);
		expect(h.server.clearedPushIds).toEqual(["push-1"]);
		expect(h.store.instances.get(id)?.pushId).toBe("push-2");
		expect(h.store.instances.get(id)?.pushFor).toBe("2026-09-11T09:50");
	});

	it("skips an unchanged reminder and cancels its push after a restart", async () => {
		const first = harness();
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await first.engine.sync([reminder]);
		const id = first.engine.instanceIdOf(reminder);
		await first.engine.syncServerScheduled();
		expect(first.store.instances.get(id)?.pushId).toBe("push-1");

		// A new engine over the same state is a restart: the id comes from disk, not
		// from a field the old process was holding.
		const second = harness({ store: first.store });
		await second.engine.sync([reminder]);
		const pass = await second.engine.syncServerScheduled();
		expect(pass.sent).toEqual([]);
		expect(second.server.sent).toEqual([]);

		await second.engine.ack(id);
		expect(second.server.cleared).toEqual([id]);
		expect(second.server.clearedPushIds).toEqual(["push-1"]);
	});

	it("does not cancel the same push twice when an ack is followed by a pass", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		await h.engine.syncServerScheduled();

		await h.engine.ack(id);
		await h.engine.syncServerScheduled();
		expect(h.server.cleared).toEqual([id]);
		expect(h.server.clearedPushIds).toEqual(["push-1"]);
	});
});
