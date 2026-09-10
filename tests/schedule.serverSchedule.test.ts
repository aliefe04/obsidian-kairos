import { describe, expect, it } from "vitest";
import { ChannelRegistry, combinedResult, type ChannelContext, type DeliveryChannel, type OutboundMessage } from "../src/channels/types";
import type { KairosSettings } from "../src/settings";
import { channelContext, makeEngine, parsedReminder, testSettings, type EngineHarness } from "./support";

const DUE = Date.UTC(2026, 8, 11, 9, 0);
const NOW = DUE - 60 * 60 * 1000;

interface FakeChannel {
	sent: OutboundMessage[];
	cleared: string[];
	channel: DeliveryChannel;
}

/** A channel that records what the registry hands it, in one mode or the other. */
function fakeChannel(id: string, mode: "local" | "server-scheduled", configured = true): FakeChannel {
	const sent: OutboundMessage[] = [];
	const cleared: string[] = [];
	return {
		sent,
		cleared,
		channel: {
			id,
			name: id,
			mode,
			isConfigured: () => configured,
			send: async (message) => {
				sent.push(message);
				return { ok: true };
			},
			// A local channel cannot cancel anything on a server, so it has no clear.
			...(mode === "server-scheduled"
				? {
						clear: async (instanceId: string) => {
							cleared.push(instanceId);
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

function harness(options: { serverConfigured?: boolean } = {}): ServerHarness {
	const settings: KairosSettings = testSettings();
	const registry = new ChannelRegistry();
	const server = fakeChannel("fake-server", "server-scheduled", options.serverConfigured ?? true);
	const local = fakeChannel("fake-local", "local");
	registry.register(server.channel);
	registry.register(local.channel);
	const context: ChannelContext = channelContext(settings, NOW);
	const engine = makeEngine({
		now: NOW,
		sendScheduled: async (message) => combinedResult(await registry.deliverScheduled(message, context)),
		clearScheduled: async (instanceId) => registry.clearInstance(instanceId, context),
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

	it("clears the pending push when the instance is acked", async () => {
		const h = harness();
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		await h.engine.syncServerScheduled();
		expect(h.server.cleared).toEqual([]);

		await h.engine.ack(id);
		expect(h.server.cleared).toEqual([id]);
		expect(h.local.cleared).toEqual([]);
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

		const result = await h.engine.syncServerScheduled();
		expect(result.sent).toEqual([afterId]);
		expect(h.server.sent.map((message) => message.instanceId)).toEqual([beforeId, afterId]);
	});
});
