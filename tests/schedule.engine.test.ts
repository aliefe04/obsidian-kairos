import { describe, expect, it } from "vitest";
import { wallClockAt, zonedWallToEpoch } from "../src/schedule/time";
import { DEVICE_ID, MemoryStore, makeEngine, parsedReminder } from "./support";

const DUE = Date.UTC(2026, 8, 11, 9, 0);
const DUE_LOCAL = "2026-09-11T09:00";

describe("ScheduleEngine tick", () => {
	it("fires once at the due time and never again for the same instance", async () => {
		const h = makeEngine({ now: DUE });
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);

		const first = await h.engine.tick();
		expect(first.fired).toEqual([id]);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.message.instanceId).toBe(id);
		expect(h.sent[0]?.message.title).toBe("msg to dentist");
		expect(h.sent[0]?.message.ageMinutes).toBe(0);
		expect(h.store.fired).toHaveLength(1);

		const second = await h.engine.tick();
		expect(second.fired).toEqual([]);
		expect(h.sent).toHaveLength(1);
	});

	it("arms inside the lead window and delivers only at the due time", async () => {
		const h = makeEngine({ now: DUE - 10 * 60 * 1000, settings: { leadMinutes: 30 } });
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);

		const armed = await h.engine.tick();
		expect(armed.fired).toEqual([]);
		expect(h.sent).toEqual([]);
		expect(h.store.instances.get(id)?.state).toBe("armed");
		expect(h.store.leases.get(id)?.deviceId).toBe(DEVICE_ID);

		h.setNow(DUE);
		const onTime = await h.engine.tick();
		expect(onTime.fired).toEqual([id]);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.message.dueLocal).toBe(DUE_LOCAL);
	});

	it("does not re-fire an instance whose fire is already in the fired log", async () => {
		const store = new MemoryStore();
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		const first = makeEngine({ store, now: DUE });
		await first.engine.sync([reminder]);
		const id = first.engine.instanceIdOf(reminder);
		expect((await first.engine.tick()).fired).toEqual([id]);

		// The same device restarts a few seconds later and rescans the vault.
		const rebuilt = makeEngine({ store, now: DUE + 5000 });
		await rebuilt.engine.load();
		await rebuilt.engine.sync([reminder]);
		const repeat = await rebuilt.engine.tick();
		expect(repeat.fired).toEqual([]);
		expect(rebuilt.sent).toEqual([]);
		expect(store.fired.filter((entry) => entry.instanceId === id)).toHaveLength(1);
	});

	it("catches up on a missed alarm with its age, and can mark it missed instead", async () => {
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		const late = makeEngine({ now: DUE + 120 * 60 * 1000 });
		await late.engine.sync([reminder]);
		const caught = await late.engine.tick();
		expect(caught.fired).toEqual([late.engine.instanceIdOf(reminder)]);
		expect(late.sent[0]?.message.ageMinutes).toBe(120);

		const missedEngine = makeEngine({ now: DUE + 120 * 60 * 1000, settings: { catchUpPolicy: "skip_and_mark_missed" } });
		await missedEngine.engine.sync([reminder]);
		const id = missedEngine.engine.instanceIdOf(reminder);
		const missed = await missedEngine.engine.tick();
		expect(missed.missed).toEqual([id]);
		expect(missed.fired).toEqual([]);
		expect(missedEngine.sent).toEqual([]);
		expect(missedEngine.store.instances.get(id)?.state).toBe("missed");
	});

	it("holds a catch-up set to fold into a digest until the next window", async () => {
		// An alarm due at 09:00, missed by fourteen hours. The policy says not to
		// interrupt late, so it waits for the next window instead of arriving as a
		// notification the moment the app opens.
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		const h = makeEngine({
			now: DUE + 14 * 60 * 60 * 1000,
			settings: { catchUpPolicy: "fold_into_digest", digestTimes: "08:00\n18:00" },
		});
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);

		const atOpen = await h.engine.tick();
		expect(atOpen.fired).toEqual([]);
		expect(atOpen.digested).toEqual([]);
		expect(h.sent).toEqual([]);
		// The wake is armed at the window; without it nothing would deliver later.
		expect(atOpen.nextWakeAt).toBe(Date.UTC(2026, 8, 12, 8, 0));

		// 18:00 has passed by 23:00, so the window is 08:00 the next morning. The tick
		// lands twenty milliseconds after it, because an interval or a wake timer never
		// fires exactly on the instant — a plan that re-derived the window from `now`
		// would pick 18:00 here, then 08:00 tomorrow, and never deliver at all.
		h.setNow(Date.UTC(2026, 8, 12, 8, 0) + 20);
		const atWindow = await h.engine.tick();
		expect(atWindow.digested).toEqual([id]);
		expect(atWindow.fired).toEqual([]);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.message.severity).toBe("digest");
		// The policy reclassifies the record, which is what a digest means: it was
		// delivered as one, so it is recorded as one.
		expect(h.store.instances.get(id)?.severity).toBe("digest");
	});

	it("keeps a snoozed predecessor quiet and fires its successor at the new time", async () => {
		const h = makeEngine({ now: DUE });
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);
		expect((await h.engine.tick()).fired).toEqual([id]);

		const snoozed = await h.engine.snooze(id, 50);
		expect(snoozed?.dueLocal).toBe("2026-09-11T09:50");
		expect(h.store.instances.get(id)?.state).toBe("snoozed");
		expect(h.store.instances.get(snoozed?.newInstanceId ?? "")?.snoozeCount).toBe(1);

		h.setNow(Date.UTC(2026, 8, 11, 9, 50));
		const atNewTime = await h.engine.tick();
		expect(atNewTime.fired).toEqual([snoozed?.newInstanceId]);
		expect(h.store.instances.get(id)?.state).toBe("snoozed");
		expect(h.sent).toHaveLength(2);
	});

	it("spares a snooze successor from cancellation but cancels a plain record that left the index", async () => {
		const h = makeEngine({ now: DUE });
		const kept = parsedReminder({ dueLocal: DUE_LOCAL });
		const gone = parsedReminder({ dueLocal: "2026-09-11T10:00", sourcePath: "journal/2026/12-09-2026-Saturday.md" });
		await h.engine.sync([kept, gone]);
		const keptId = h.engine.instanceIdOf(kept);
		const goneId = h.engine.instanceIdOf(gone);
		expect((await h.engine.tick()).fired).toEqual([keptId]);

		const snoozed = await h.engine.snooze(keptId, 50);
		const after = await h.engine.sync([kept]);

		expect(after.cancelled).toBe(1);
		expect(h.store.instances.get(goneId)?.state).toBe("cancelled");
		expect(h.cleared).toContain(goneId);
		expect(h.store.instances.get(snoozed?.newInstanceId ?? "")?.state).toBe("scheduled");
	});

	it("never fires a reminder whose checkbox was completed", async () => {
		const h = makeEngine({ now: DUE });
		const reminder = parsedReminder({ dueLocal: DUE_LOCAL });
		await h.engine.sync([reminder]);
		const id = h.engine.instanceIdOf(reminder);

		// The user ticks the box, so the line stops producing a reminder.
		const after = await h.engine.sync([]);
		expect(after.cancelled).toBe(1);
		expect(h.store.instances.get(id)?.state).toBe("cancelled");

		const tick = await h.engine.tick();
		expect(tick.fired).toEqual([]);
		expect(h.sent).toEqual([]);
	});

	it("keeps the wall-clock hour across the spring-forward and fall-back days", async () => {
		const cases = [
			{ dueLocal: "2026-03-29T09:00", instant: Date.UTC(2026, 2, 29, 7, 0) },
			{ dueLocal: "2026-10-25T09:00", instant: Date.UTC(2026, 9, 25, 8, 0) },
		];
		for (const { dueLocal, instant } of cases) {
			const h = makeEngine({ tzId: "Europe/Berlin", now: instant - 60 * 1000 });
			const reminder = parsedReminder({ dueLocal, tzId: "Europe/Berlin" });
			await h.engine.sync([reminder]);
			const id = h.engine.instanceIdOf(reminder);

			const early = await h.engine.tick();
			expect(early.fired).toEqual([]);
			expect(h.sent).toEqual([]);

			h.setNow(instant);
			const onTime = await h.engine.tick();
			expect(onTime.fired).toEqual([id]);
			expect(h.sent[0]?.message.dueLocal).toBe(dueLocal);
			expect(wallClockAt(instant, "Europe/Berlin")).toBe(dueLocal);
		}
	});

	it("fires at 00:00 and at 23:59 without sliding a day", async () => {
		for (const dueLocal of ["2026-09-11T00:00", "2026-09-11T23:59"]) {
			const instant = zonedWallToEpoch(dueLocal, "UTC");
			const h = makeEngine({ now: instant - 60 * 1000 });
			const reminder = parsedReminder({ dueLocal });
			await h.engine.sync([reminder]);
			const id = h.engine.instanceIdOf(reminder);

			expect((await h.engine.tick()).fired).toEqual([]);
			h.setNow(instant);
			expect((await h.engine.tick()).fired).toEqual([id]);
			expect(h.sent[0]?.message.dueLocal).toBe(dueLocal);
		}
	});
});
