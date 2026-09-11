/**
 * The provider horizon and the retry policy for server-side scheduling.
 *
 * These pin two defects that a plain "did it send?" assertion cannot see: a
 * horizon longer than the provider's delay limit, which makes every registration
 * of a far-off reminder fail, and a retry on every pass, which spends the
 * provider's quota on requests that are known to fail.
 */

import { describe, expect, it } from "vitest";
import type { ChannelDelivery, OutboundMessage } from "../src/channels/types";
import { DEFAULT_SETTINGS } from "../src/settings";
import { SCHEDULE_BACKOFF_BASE_MS, SCHEDULE_BACKOFF_MAX_MS, SCHEDULE_RETRY_MARGIN_MS } from "../src/schedule/engine";
import { makeEngine, parsedReminder, type EngineHarness } from "./support";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** 2026-09-11 09:00 UTC, the time the spec examples use. `makeEngine` runs in UTC. */
const DUE = Date.UTC(2026, 8, 11, 9, 0);

interface Recorder {
	attempts: number;
	failNext: number;
}

type HorizonHarness = EngineHarness & { recorder: Recorder };

function harness(options: { now: number; horizonDays?: number }): HorizonHarness {
	const recorder: Recorder = { attempts: 0, failNext: 0 };
	const engine = makeEngine({
		now: options.now,
		...(options.horizonDays === undefined ? {} : { settings: { serverScheduleHorizonDays: options.horizonDays } }),
		sendScheduled: (_message: OutboundMessage, _record, channels): Promise<ChannelDelivery[]> => {
			recorder.attempts += 1;
			if (recorder.failNext > 0) {
				recorder.failNext -= 1;
				return Promise.resolve(channels.map((channelId) => ({ channelId, result: { ok: false, detail: "ntfy returned 400" } })));
			}
			return Promise.resolve(channels.map((channelId, index) => ({ channelId, result: { ok: true, id: `push-${index}` } })));
		},
		// The provider the horizon exists for: no ceiling of its own, so the settings
		// value decides, exactly as it did before channels could differ.
		scheduledChannels: () => [{ id: "fake-server", configured: true }],
	});
	return { ...engine, recorder };
}

describe("server scheduling horizon", () => {
	it("defaults to the delay limit of the default provider", () => {
		// ntfy.sh documents three days as its maximum delay. A longer horizon is a
		// registration the server refuses, and the refusal repeats.
		expect(DEFAULT_SETTINGS.serverScheduleHorizonDays).toBe(3);
	});

	it("does not register a reminder beyond the horizon, and does once it is inside", async () => {
		const h = harness({ now: DUE - 5 * DAY });
		await h.engine.sync([parsedReminder({ dueLocal: "2026-09-11T09:00" })]);

		const beyond = await h.engine.syncServerScheduled(DUE - 5 * DAY);
		expect(beyond.sent).toEqual([]);
		expect(h.recorder.attempts).toBe(0);

		const inside = await h.engine.syncServerScheduled(DUE - 2 * DAY);
		expect(inside.sent).toHaveLength(1);
		expect(h.recorder.attempts).toBe(1);
	});

	it("registers a far reminder when the horizon is raised for a self-hosted server", async () => {
		const h = harness({ now: DUE - 5 * DAY, horizonDays: 7 });
		await h.engine.sync([parsedReminder({ dueLocal: "2026-09-11T09:00" })]);
		const result = await h.engine.syncServerScheduled(DUE - 5 * DAY);
		expect(result.sent).toHaveLength(1);
	});
});

describe("server scheduling backoff", () => {
	it("backs off after a refused registration instead of retrying on every pass", async () => {
		const now = DUE - HOUR;
		const h = harness({ now });
		await h.engine.sync([parsedReminder({ dueLocal: "2026-09-11T09:00" })]);
		h.recorder.failNext = 1;

		const first = await h.engine.syncServerScheduled(now);
		expect(first.failed).toHaveLength(1);
		expect(h.recorder.attempts).toBe(1);

		// Passes follow every index change, ack, snooze, rescan and start. None of
		// them may re-send while the backoff holds.
		const second = await h.engine.syncServerScheduled(now + 1000);
		expect(second.failed).toEqual([]);
		expect(second.deferred).toHaveLength(1);
		expect(h.recorder.attempts).toBe(1);

		const third = await h.engine.syncServerScheduled(now + SCHEDULE_BACKOFF_BASE_MS + 1);
		expect(third.sent).toHaveLength(1);
		expect(third.deferred).toEqual([]);
		expect(h.recorder.attempts).toBe(2);

		// The success is remembered: a later pass leaves the registration alone,
		// because ntfy.sh delivers a repeat publish as a second push rather than
		// replacing the pending one.
		const fourth = await h.engine.syncServerScheduled(now + 2 * SCHEDULE_BACKOFF_BASE_MS);
		expect(fourth.deferred).toEqual([]);
		expect(fourth.sent).toEqual([]);
		expect(h.recorder.attempts).toBe(2);
	});

	it("doubles the delay per refusal and never exceeds the cap", async () => {
		// A horizon wide enough that the reminder is still ahead of the clock while
		// the backoff ladder is walked to its ceiling.
		const now = DUE - 7 * DAY;
		const h = harness({ now, horizonDays: 7 });
		await h.engine.sync([parsedReminder({ dueLocal: "2026-09-11T09:00" })]);
		h.recorder.failNext = 20;

		let at = now;
		await h.engine.syncServerScheduled(at);
		expect((await h.engine.syncServerScheduled(at + SCHEDULE_BACKOFF_BASE_MS - 1)).deferred).toHaveLength(1);

		at += SCHEDULE_BACKOFF_BASE_MS;
		await h.engine.syncServerScheduled(at);
		// The second delay is twice the first, so a wait of one base unit is inside it.
		expect((await h.engine.syncServerScheduled(at + SCHEDULE_BACKOFF_BASE_MS)).deferred).toHaveLength(1);
		expect(h.recorder.attempts).toBe(2);

		for (let attempt = 2; attempt < 12; attempt += 1) {
			at += SCHEDULE_BACKOFF_MAX_MS;
			await h.engine.syncServerScheduled(at);
		}
		expect(h.recorder.attempts).toBe(12);

		// The delay never grows past the cap: a jump of exactly the cap retries.
		const withinCap = await h.engine.syncServerScheduled(at + SCHEDULE_BACKOFF_MAX_MS - 1);
		expect(withinCap.deferred).toHaveLength(1);
		const atCap = await h.engine.syncServerScheduled(at + SCHEDULE_BACKOFF_MAX_MS);
		expect(atCap.failed).toHaveLength(1);
		expect(h.recorder.attempts).toBe(13);
	});

	it("stops tracking an instance once it leaves the index", async () => {
		const now = DUE - HOUR;
		const h = harness({ now });
		const reminder = parsedReminder({ dueLocal: "2026-09-11T09:00" });
		await h.engine.sync([reminder]);
		h.recorder.failNext = 1;
		await h.engine.syncServerScheduled(now);

		await h.engine.sync([]);
		const after = await h.engine.syncServerScheduled(now + 1000);
		expect(after.deferred).toEqual([]);
		// Leaving the index cancels the instance through `sync`; the registration
		// that failed left nothing on the server for the pass to withdraw.
		expect(after.cleared).toEqual([]);
		expect(h.cleared).toContain(h.engine.instanceIdOf(reminder));
	});

	it("never delays the next attempt past the due time", async () => {
		// Ten minutes of lead. The ladder reaches an 8-minute wait after four
		// refusals, which would land after the due time — the registration would
		// never succeed and, with the app closed, the alert would never arrive.
		const MINUTE = 60 * 1000;
		const now = DUE - 10 * MINUTE;
		const h = harness({ now });
		await h.engine.sync([parsedReminder({ dueLocal: "2026-09-11T09:00" })]);
		h.recorder.failNext = 20;

		await h.engine.syncServerScheduled(now); // 1, waits 1 min
		expect((await h.engine.syncServerScheduled(DUE - 9 * MINUTE - 1)).deferred).toHaveLength(1);
		await h.engine.syncServerScheduled(DUE - 9 * MINUTE); // 2, waits 2 min
		await h.engine.syncServerScheduled(DUE - 7 * MINUTE); // 3, waits 4 min
		expect(h.recorder.attempts).toBe(3);
		expect((await h.engine.syncServerScheduled(DUE - 5 * MINUTE)).deferred).toHaveLength(1);

		// The next wait would be 8 minutes, which overshoots the due time, so the
		// attempt happens here instead and the wait is clamped to the deadline.
		await h.engine.syncServerScheduled(DUE - 3 * MINUTE); // 4
		expect(h.recorder.attempts).toBe(4);
		expect((await h.engine.syncServerScheduled(DUE - 2 * MINUTE)).deferred).toHaveLength(1);

		// The clamped attempt lands one minute before due, so it still has a chance.
		const deadline = DUE - SCHEDULE_RETRY_MARGIN_MS;
		expect((await h.engine.syncServerScheduled(deadline)).failed).toHaveLength(1);
		expect(h.recorder.attempts).toBe(5);

		// Inside the final margin the deadline is gone, so attempts continue at once
		// and the due time is what ends them.
		await h.engine.syncServerScheduled(deadline);
		expect(h.recorder.attempts).toBe(6);
		const afterDue = await h.engine.syncServerScheduled(DUE);
		expect(afterDue.failed).toEqual([]);
		expect(afterDue.deferred).toEqual([]);
		expect(h.recorder.attempts).toBe(6);
	});
});
