import { describe, expect, it } from "vitest";
import { addMinutesToWallClock, offsetMinutesAt, wallClockAt, zonedWallToEpoch } from "../src/schedule/time";

const BERLIN = "Europe/Berlin";

describe("zonedWallToEpoch", () => {
	it("resolves an ordinary wall clock to the instant a clock in that zone reads it", () => {
		expect(zonedWallToEpoch("2026-09-11T09:00", "UTC")).toBe(Date.UTC(2026, 8, 11, 9, 0));
		expect(zonedWallToEpoch("2026-09-11T09:00", BERLIN)).toBe(Date.UTC(2026, 8, 11, 7, 0));
		expect(zonedWallToEpoch("2026-01-15T09:00", BERLIN)).toBe(Date.UTC(2026, 0, 15, 8, 0));
		expect(wallClockAt(zonedWallToEpoch("2026-09-11T09:00", BERLIN), BERLIN)).toBe("2026-09-11T09:00");
	});

	it("reports the zone offset that instant actually has", () => {
		expect(offsetMinutesAt(BERLIN, zonedWallToEpoch("2026-09-11T09:00", BERLIN))).toBe(120);
		expect(offsetMinutesAt(BERLIN, zonedWallToEpoch("2026-01-15T09:00", BERLIN))).toBe(60);
		expect(offsetMinutesAt(BERLIN, Date.UTC(2026, 2, 29, 0, 59))).toBe(60);
		expect(offsetMinutesAt(BERLIN, Date.UTC(2026, 2, 29, 1, 0))).toBe(120);
	});

	it("lands on the far side of a spring-forward gap", () => {
		// 2026-03-29 02:00 CET jumps to 03:00 CEST, so 02:30 never happens.
		expect(wallClockAt(Date.UTC(2026, 2, 29, 0, 59), BERLIN)).toBe("2026-03-29T01:59");
		expect(wallClockAt(Date.UTC(2026, 2, 29, 1, 0), BERLIN)).toBe("2026-03-29T03:00");
		const resolved = zonedWallToEpoch("2026-03-29T02:30", BERLIN);
		expect(wallClockAt(resolved, BERLIN)).toBe("2026-03-29T03:30");
		expect(resolved).toBe(Date.UTC(2026, 2, 29, 1, 30));
	});

	it("takes the earlier instant of a fall-back overlap", () => {
		// 2026-10-25 03:00 CEST falls back to 02:00 CET, so 02:30 happens twice.
		const earlier = zonedWallToEpoch("2026-10-25T02:30", BERLIN);
		expect(earlier).toBe(Date.UTC(2026, 9, 25, 0, 30));
		expect(wallClockAt(earlier, BERLIN)).toBe("2026-10-25T02:30");
		expect(offsetMinutesAt(BERLIN, earlier)).toBe(120);
		const later = earlier + 60 * 60 * 1000;
		expect(wallClockAt(later, BERLIN)).toBe("2026-10-25T02:30");
		expect(offsetMinutesAt(BERLIN, later)).toBe(60);
	});

	it("refuses a string that is not a wall clock", () => {
		expect(zonedWallToEpoch("2026-09-11", BERLIN)).toBeNaN();
		expect(zonedWallToEpoch("", "UTC")).toBeNaN();
	});
});

describe("addMinutesToWallClock", () => {
	it("crosses midnight, month and year boundaries", () => {
		expect(addMinutesToWallClock("2026-09-11T23:59", 2)).toBe("2026-09-12T00:01");
		expect(addMinutesToWallClock("2026-09-11T00:00", -1)).toBe("2026-09-10T23:59");
		expect(addMinutesToWallClock("2026-12-31T23:30", 45)).toBe("2027-01-01T00:15");
		expect(addMinutesToWallClock("2028-02-28T23:50", 20)).toBe("2028-02-29T00:10");
	});

	it("keeps the wall clock subject to no zone at all", () => {
		// A snooze across the fall-back night must move the wall clock by exactly
		// the requested minutes, not by an offset change.
		expect(addMinutesToWallClock("2026-10-25T01:50", 20)).toBe("2026-10-25T02:10");
		expect(addMinutesToWallClock("2026-03-29T01:50", 20)).toBe("2026-03-29T02:10");
	});

	it("leaves an unparseable value untouched", () => {
		expect(addMinutesToWallClock("tomorrow", 10)).toBe("tomorrow");
	});
});
