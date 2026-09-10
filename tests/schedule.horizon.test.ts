/**
 * The provider horizon and the retry policy for server-side scheduling.
 *
 * These pin two defects that a plain "did it send?" assertion cannot see: a
 * horizon longer than the provider's delay limit, which makes every registration
 * of a far-off reminder fail, and a retry on every pass, which spends the
 * provider's quota on requests that are known to fail.
 */

import { describe, expect, it } from "vitest";
import type { DeliveryResult, OutboundMessage } from "../src/channels/types";
import { DEFAULT_SETTINGS } from "../src/settings";
import { SCHEDULE_BACKOFF_BASE_MS, SCHEDULE_BACKOFF_MAX_MS } from "../src/schedule/engine";
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
		sendScheduled: (_message: OutboundMessage): Promise<DeliveryResult> => {
			recorder.attempts += 1;
			if (recorder.failNext > 0) {
				recorder.failNext -= 1;
				return Promise.resolve({ ok: false, detail: "ntfy returned 400" });
			}
			return Promise.resolve({ ok: true });
		},
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

		// A success clears the record, so later passes re-register as usual. A
		// repeated registration is idempotent: the payload carries the instance id.
		const fourth = await h.engine.syncServerScheduled(now + 2 * SCHEDULE_BACKOFF_BASE_MS);
		expect(fourth.deferred).toEqual([]);
		expect(fourth.sent).toHaveLength(1);
		expect(h.recorder.attempts).toBe(3);
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
		expect(after.cleared).toContain(h.engine.instanceIdOf(reminder));
	});
});
