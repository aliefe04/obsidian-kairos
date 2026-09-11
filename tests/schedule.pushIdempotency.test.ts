import { describe, expect, it } from "vitest";
import {
	ChannelRegistry,
	combinedResult,
	type ChannelContext,
	type DeliveryChannel,
	type OutboundMessage,
} from "../src/channels/types";
import type { KairosSettings } from "../src/settings";
import { channelContext, makeEngine, parsedReminder, testSettings, type EngineHarness } from "./support";

const DUE = Date.UTC(2026, 8, 11, 9, 0);
const DUE_LOCAL = "2026-09-11T09:00";
const NOW = DUE - 60 * 60 * 1000;

interface FakeChannel {
	sent: OutboundMessage[];
	cleared: Array<{ instanceId: string; pushId?: string }>;
	channel: DeliveryChannel;
}

/**
 * A server-scheduled channel that counts publishes. `gate` holds every publish
 * open, so a test can drive the ordering the real plugin produced: a second
 * pass beginning while the first registration is still in flight.
 */
function fakeChannel(
	id: string,
	mode: "local" | "server-scheduled",
	options: { configured?: boolean; gate?: boolean } = {},
): FakeChannel {
	const sent: OutboundMessage[] = [];
	const cleared: Array<{ instanceId: string; pushId?: string }> = [];
	return {
		sent,
		cleared,
		channel: {
			id,
			name: id,
			mode,
			isConfigured: () => options.configured ?? true,
			send: async (message) => {
				sent.push(message);
				if (options.gate === true) {
					await gateOpen;
				}
				return { ok: true, id: `push-${sent.length}` };
			},
			clear: async (instanceId, _ctx, pushId) => {
				cleared.push(pushId === undefined ? { instanceId } : { instanceId, pushId });
			},
		},
	};
}

let releaseGate: () => void = () => undefined;
let gateOpen: Promise<void> = Promise.resolve();

/** Closes the publish gate; `openGate` releases every publish it holds. */
function closeGate(): void {
	gateOpen = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});
}

function openGate(): void {
	releaseGate();
}

function harness(settingsOverrides: Partial<KairosSettings> = {}): EngineHarness & { server: FakeChannel; local: FakeChannel } {
	const settings: KairosSettings = testSettings(settingsOverrides);
	const registry = new ChannelRegistry();
	const server = fakeChannel("fake-server", "server-scheduled", { gate: true });
	const local = fakeChannel("fake-local", "local");
	registry.register(server.channel);
	registry.register(local.channel);
	const context: ChannelContext = channelContext(settings, NOW);
	const engine = makeEngine({
		now: NOW,
		settings: settingsOverrides,
		// The fire path, wired the way `main.ts` wires it: the channels that deliver
		// without a server.
		send: async (message) => combinedResult(await registry.deliverLocal(message, context)),
		sendScheduled: async (message) => combinedResult(await registry.deliverScheduled(message, context)),
		clearScheduled: async (instanceId, pushId) => registry.clearInstance(instanceId, context, pushId),
	});
	return { ...engine, server, local };
}

describe("one push per reminder per due time", () => {
	it("publishes once when a second pass begins while the first registration is in flight", async () => {
		closeGate();
		const h = harness();
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);

		// The launch ordering, from the real plugin (`.testvault`, 2026-09-11): the
		// first pass is inside `main.start()`, and the second is the one
		// `main.applyIndex` runs from the indexer's `onFile` callback — which fires
		// per note inside `rescan()`'s `scanAll()`, while the first pass is still
		// awaiting the provider. Both then read the same record, neither has written
		// `pushFor`, and both publish: two ids two seconds apart for one due time.
		// Both passes are started before either registration settles: the gate holds
		// the first publish open until `openGate`, so the second pass runs while the
		// first is still inside the provider call.
		const first = h.engine.syncServerScheduled(NOW);
		const second = h.engine.syncServerScheduled(NOW);
		openGate();
		const [firstPass, secondPass] = await Promise.all([first, second]);

		expect(h.server.sent).toHaveLength(1);
		expect(firstPass.sent).toEqual([id]);
		expect(secondPass.sent).toEqual([]);
		expect(secondPass.cleared).toEqual([]);
		// The pending id is not withdrawn by the pass that skipped it.
		expect(h.server.cleared).toEqual([]);
		expect(h.store.instances.get(id)?.pushId).toBe("push-1");
		expect(h.store.instances.get(id)?.pushFor).toBe(DUE_LOCAL);
	});

	it("does not publish for a reminder that is firing, nor for the catch-up re-arm", async () => {
		// A reminder that becomes due while the pass is not looking — the app opened
		// seconds after the due minute, or a tick landed on it first. The tick's
		// fan-out must not reach a channel that holds registrations server-side:
		// ntfy cannot deliver an already-started schedule, so it clamps X-At to ten
		// seconds out and the published copy arrives as a second alert. That is the
		// third arrival in the trace — a reminder due 11:14 delivered at 11:14:10.
		const fired = harness();
		const firedReminder = parsedReminder({ dueLocal: DUE_LOCAL });
		await fired.engine.sync([firedReminder]);
		const id = fired.engine.instanceIdOf(firedReminder);

		fired.setNow(DUE + 2 * 60 * 1000);
		const tick = await fired.engine.tick();
		expect(tick.fired).toEqual([id]);
		expect(fired.local.sent.map((message) => message.instanceId)).toEqual([id]);
		expect(fired.server.sent).toEqual([]);

		// The pass that follows sees the due time it fired at, which has begun, and
		// must not register a push for it either.
		const pass = await fired.engine.syncServerScheduled();
		expect(pass.sent).toEqual([]);
		expect(fired.server.sent).toEqual([]);
		expect(fired.store.instances.get(id)?.pushFor).toBeUndefined();

		// The re-arm: past the grace window the catch-up folds the reminder into a
		// digest, which moves its due time. The fold is a delivery of the due time
		// that already began, and neither it nor the pass after it may publish.
		const folded = harness({ catchUpPolicy: "fold_into_digest", digestTimes: "" });
		const missed = parsedReminder({ dueLocal: DUE_LOCAL });
		await folded.engine.sync([missed]);
		const missedId = folded.engine.instanceIdOf(missed);

		// Twenty minutes late: past the 15-minute grace, so the catch-up policy
		// decides rather than the on-time path.
		folded.setNow(DUE + 20 * 60 * 1000);
		const catchUp = await folded.engine.tick();
		expect(catchUp.digested).toEqual([missedId]);
		expect(folded.local.sent.map((message) => message.instanceId)).toEqual([missedId]);
		expect(folded.server.sent).toEqual([]);

		const after = await folded.engine.syncServerScheduled();
		expect(after.sent).toEqual([]);
		expect(folded.server.sent).toEqual([]);
	});
});
