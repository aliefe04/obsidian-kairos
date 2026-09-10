/**
 * Lease, arming and supersede invariants (docs/spec/state-model.md §3, §5).
 *
 * `leadMinutes` opens an *arming* window, it is not an early alert: inside
 * `[due - lead, due)` the record is claimed — and re-claimed on every pass, so a
 * lead longer than the lease TTL still reserves the alarm — while the alert
 * itself lands at `due`. A claim held by another device neither fires nor goes
 * silent, and a snoozed predecessor stays inert however the note is annotated.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_LEASE_TTL_MS, messageSummary } from "../src/schedule/engine";
import { DEVICE_ID, MemoryStore, makeEngine, outboundMessage, parsedReminder, type SentMessage } from "./support";

const DUE = Date.UTC(2026, 8, 11, 9, 0);
const DUE_LOCAL = "2026-09-11T09:00";
const MINUTE = 60 * 1000;
const LATER_LOCAL = "2026-09-11T09:50";
const OTHER_DEVICE = "device-2";

describe("arming window", () => {
	it("delivers nothing before the due time and exactly once at it", async () => {
		const h = makeEngine({ now: DUE - 5 * MINUTE, settings: { leadMinutes: 10 } });
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);

		const inside = await h.engine.tick();
		expect(inside.fired).toEqual([]);
		expect(inside.blockedByLease).toEqual([]);
		expect(h.sent).toEqual([]);
		expect(h.store.fired).toEqual([]);
		expect(h.store.instances.get(id)?.state).toBe("armed");
		expect(h.store.leases.get(id)?.deviceId).toBe(DEVICE_ID);

		// One second of lead left is still only an armed claim.
		h.setNow(DUE - 1000);
		const lastSecond = await h.engine.tick();
		expect(lastSecond.fired).toEqual([]);
		expect(h.sent).toEqual([]);
		expect(h.store.instances.get(id)?.state).toBe("armed");

		h.setNow(DUE);
		const onTime = await h.engine.tick();
		expect(onTime.fired).toEqual([id]);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.message.instanceId).toBe(id);
		expect(h.store.fired).toHaveLength(1);
	});

	it("renews the claim on every pass so it outlives the lease TTL", async () => {
		// The invariant only bites when the window is longer than the lease.
		expect(DEFAULT_LEASE_TTL_MS).toBeLessThan(10 * MINUTE);
		const h = makeEngine({ now: DUE - 10 * MINUTE, settings: { leadMinutes: 10 } });
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);

		await h.engine.tick();
		// Armed at the window's edge, the claim would lapse five minutes before the
		// alarm is due.
		expect(h.store.leases.get(id)?.expiresAt).toBe(DUE - 10 * MINUTE + DEFAULT_LEASE_TTL_MS);

		h.setNow(DUE - 4 * MINUTE);
		const stillArmed = await h.engine.tick();
		expect(stillArmed.fired).toEqual([]);
		expect(h.store.leases.get(id)?.expiresAt).toBe(DUE - 4 * MINUTE + DEFAULT_LEASE_TTL_MS);
		expect(h.store.leases.get(id)?.expiresAt ?? 0).toBeGreaterThan(DUE);

		h.setNow(DUE);
		const onTime = await h.engine.tick();
		expect(onTime.fired).toEqual([id]);
		expect(h.sent).toHaveLength(1);
		expect(h.store.fired).toHaveLength(1);
	});

	it("keeps a record scheduled when another device owns the claim, and fires once it lapses", async () => {
		const h = makeEngine({ now: DUE, settings: { leadMinutes: 10 } });
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		h.store.leases.set(id, { deviceId: OTHER_DEVICE, seq: 1, expiresAt: DUE + MINUTE });

		const blocked = await h.engine.tick();
		expect(blocked.fired).toEqual([]);
		expect(blocked.blockedByLease).toEqual([id]);
		expect(h.sent).toEqual([]);
		expect(h.store.fired).toEqual([]);
		expect(h.store.instances.get(id)?.state).toBe("scheduled");
		expect(h.store.leases.get(id)?.deviceId).toBe(OTHER_DEVICE);

		// The other device's claim lapses: the instance is still owed an alert.
		h.setNow(DUE + MINUTE + 1);
		const afterLapse = await h.engine.tick();
		expect(afterLapse.blockedByLease).toEqual([]);
		expect(afterLapse.fired).toEqual([id]);
		expect(h.sent).toHaveLength(1);
		expect(h.store.fired).toHaveLength(1);
	});

	it("fires an instance once when two ticks overlap around a slow channel", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const delivered: SentMessage[] = [];
		const h = makeEngine({
			now: DUE,
			settings: { leadMinutes: 10 },
			send: async (message, record) => {
				delivered.push({ message, record });
				await gate;
				return { ok: true };
			},
		});
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);

		// Both ticks run in the same turn; the channel does not resolve until the
		// second one is already in flight.
		const first = h.engine.tick();
		const second = h.engine.tick();
		release();
		const [a, b] = await Promise.all([first, second]);

		expect(a.fired).toEqual([id]);
		expect(b.fired).toEqual([id]);
		expect(delivered.map((entry) => entry.message.instanceId)).toEqual([id]);
		expect(h.store.fired).toHaveLength(1);
	});
});

describe("snooze durability", () => {
	it("keeps the predecessor inert, spares the successor, then drops the predecessor once the note drops the old time", async () => {
		const h = makeEngine({ now: DUE - MINUTE, settings: { leadMinutes: 10 } });
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		await h.engine.sync([reminder]);
		const predecessorId = h.engine.instanceIdOf(reminder);

		const snoozed = await h.engine.snooze(predecessorId, 50);
		expect(snoozed?.dueLocal).toBe(LATER_LOCAL);
		const successorId = snoozed?.newInstanceId ?? "";
		expect(successorId).not.toBe(predecessorId);
		expect(h.store.instances.get(predecessorId)?.state).toBe("snoozed");
		expect(h.store.instances.get(successorId)?.state).toBe("scheduled");
		expect(h.store.instances.get(successorId)?.supersedes).toBe(predecessorId);
		expect(h.store.instances.get(successorId)?.snoozeCount).toBe(1);

		// Several passes across the old due time must not wake the predecessor up.
		for (const offset of [0, MINUTE, 5 * MINUTE]) {
			h.setNow(DUE + offset);
			const tick = await h.engine.tick();
			expect(tick.fired).toEqual([]);
			expect(h.sent).toEqual([]);
		}
		expect(h.store.instances.get(predecessorId)?.state).toBe("snoozed");

		// Annotation off: the note still shows the old time, so the index keeps
		// offering the instance the successor took over. The successor is owned by
		// state and must survive the rescan.
		const rescanned = await h.engine.sync([reminder]);
		expect(rescanned.cancelled).toBe(0);
		expect(h.store.instances.get(predecessorId)?.state).toBe("snoozed");
		expect(h.store.instances.get(successorId)?.state).toBe("scheduled");

		h.setNow(DUE + 50 * MINUTE);
		const atNewTime = await h.engine.tick();
		expect(atNewTime.fired).toEqual([successorId]);
		expect(h.sent.map((entry) => entry.message.instanceId)).toEqual([successorId]);

		// The note has been rewritten with the new time: the old one can never come
		// back, so the predecessor is dropped instead of staying inert forever.
		const rewritten = parsedReminder({ dueLocal: LATER_LOCAL });
		const afterRewrite = await h.engine.sync([rewritten]);
		expect(afterRewrite.created).toBe(0);
		const live = h.engine.snapshot().map((record) => record.instanceId);
		expect(live).not.toContain(predecessorId);
		expect(live).toContain(successorId);
	});

	it("forces a re-created superseded instance back to snoozed so it never fires", async () => {
		const store = new MemoryStore();
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		const first = makeEngine({ store, now: DUE - MINUTE, settings: { leadMinutes: 10 } });
		await first.engine.sync([reminder]);
		const predecessorId = first.engine.instanceIdOf(reminder);
		const snoozed = await first.engine.snooze(predecessorId, 50);
		const successorId = snoozed?.newInstanceId ?? "";

		// State lost the predecessor (fresh device, cleared cache) while the note
		// still carries the old time, so the index offers it again.
		store.instances.delete(predecessorId);
		expect(store.instances.has(successorId)).toBe(true);

		const rebuilt = makeEngine({ store, now: DUE - MINUTE, settings: { leadMinutes: 10 } });
		await rebuilt.engine.load();
		await rebuilt.engine.sync([reminder]);
		expect(rebuilt.store.instances.get(predecessorId)?.state).toBe("snoozed");

		rebuilt.setNow(DUE);
		const atOldTime = await rebuilt.engine.tick();
		expect(atOldTime.fired).toEqual([]);
		expect(rebuilt.sent).toEqual([]);

		rebuilt.setNow(DUE + 50 * MINUTE);
		const atNewTime = await rebuilt.engine.tick();
		expect(atNewTime.fired).toEqual([successorId]);
		expect(rebuilt.sent.map((entry) => entry.message.instanceId)).toEqual([successorId]);
	});
});

describe("messageSummary", () => {
	it("stays title-free and carries the time, the age and the note name", () => {
		const onTime = messageSummary(outboundMessage({ title: "msg to dentist" }));
		expect(onTime).toBe("09:00 · 11-09-2026-Friday");
		expect(onTime).not.toContain("msg to dentist");

		const late = messageSummary(outboundMessage({ title: "msg to dentist", ageMinutes: 5 }));
		expect(late).toBe("09:00 · 5 min late · 11-09-2026-Friday");
		expect(late).not.toContain("msg to dentist");

		// A note-less instance keeps the time without a dangling separator.
		expect(messageSummary(outboundMessage({ title: "msg to dentist", noteName: "" }))).toBe("09:00");
	});
});
