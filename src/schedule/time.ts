/**
 * Timezone math (docs/spec/state-model.md §1).
 *
 * Reminders are stored as local wall clock plus an IANA zone, so every firing
 * decision needs the inverse of "what does the clock read here": given a wall
 * clock and a zone, find the instant. `Intl` is the only zone database we have
 * and the only one we need.
 */

import type { Hm, Ymd } from "../parse/timeTokens";

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(tzId: string): Intl.DateTimeFormat | null {
	const cached = formatters.get(tzId);
	if (cached !== undefined) {
		return cached;
	}
	let formatter: Intl.DateTimeFormat | null = null;
	try {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: tzId,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
	} catch {
		formatter = null;
	}
	formatters.set(tzId, formatter);
	return formatter;
}

export function isValidTimeZone(tzId: string): boolean {
	return formatterFor(tzId) !== null;
}

/** The zone this device is in right now, or UTC when the runtime cannot say. */
export function deviceTimeZone(): string {
	try {
		const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return resolved && resolved.length > 0 ? resolved : "UTC";
	} catch {
		return "UTC";
	}
}

interface WallParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

function partsAt(tzId: string, epochMs: number): WallParts | null {
	const formatter = formatterFor(tzId);
	if (!formatter) {
		return null;
	}
	const parts = formatter.formatToParts(new Date(epochMs));
	const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
	return {
		year: read("year"),
		month: read("month"),
		day: read("day"),
		hour: read("hour"),
		minute: read("minute"),
		second: read("second"),
	};
}

export function offsetMinutesAt(tzId: string, epochMs: number): number {
	const parts = partsAt(tzId, epochMs);
	if (!parts) {
		return 0;
	}
	const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
	return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60000);
}

export function pad(value: number, width = 2): string {
	return String(value).padStart(width, "0");
}

/** 'YYYY-MM-DDTHH:mm' as read on a clock in `tzId`. */
export function wallClockAt(epochMs: number, tzId: string): string {
	const parts = partsAt(tzId, epochMs);
	if (!parts) {
		const utc = new Date(epochMs);
		return `${pad(utc.getUTCFullYear(), 4)}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}T${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}`;
	}
	return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;

export function isValidWallClock(value: string): boolean {
	return WALL_CLOCK_RE.test(value);
}

export function wallClockParts(wallClock: string): { ymd: Ymd; time: Hm } | null {
	const match = WALL_CLOCK_RE.exec(wallClock);
	if (!match) {
		return null;
	}
	return {
		ymd: { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) },
		time: { hour: Number(match[4]), minute: Number(match[5]) },
	};
}

export function minutesOfDay(wallClock: string): number {
	const parsed = wallClockParts(wallClock);
	return parsed ? parsed.time.hour * 60 + parsed.time.minute : 0;
}

/**
 * The instant at which a clock in `tzId` reads `wallClock`.
 *
 * Spring-forward gaps have no instant: the result lands on the far side of the
 * jump (02:30 → 03:30). Fall-back overlaps have two: the first is returned.
 */
export function zonedWallToEpoch(wallClock: string, tzId: string): number {
	const parsed = wallClockParts(wallClock);
	if (!parsed) {
		return Number.NaN;
	}
	const guess = Date.UTC(parsed.ymd.y, parsed.ymd.m - 1, parsed.ymd.d, parsed.time.hour, parsed.time.minute);
	// Probe the zone offset a day either side of the target instant: the standard
	// two-probe resolution. One match is the ordinary case. Two matches are a
	// fall-back overlap, and the FIRST (earlier) instant is the one a clock
	// reading that wall time means. Zero matches are a spring-forward gap, which
	// has no instant at all, so the result lands on the far side of the jump
	// (02:30 → 03:30, as documented above).
	const DAY_MS = 24 * 60 * 60 * 1000;
	const before = guess - offsetMinutesAt(tzId, guess - DAY_MS) * 60000;
	const after = guess - offsetMinutesAt(tzId, guess + DAY_MS) * 60000;
	const beforeMatches = wallClockAt(before, tzId) === wallClock;
	const afterMatches = wallClockAt(after, tzId) === wallClock;
	if (beforeMatches && afterMatches) {
		return Math.min(before, after);
	}
	if (beforeMatches) {
		return before;
	}
	if (afterMatches) {
		return after;
	}
	return Math.max(before, after);
}

/** Calendar arithmetic on a local date: zone-free, so it never lands on DST. */
export function shiftYmd(date: Ymd, days: number): Ymd {
	const shifted = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
	return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

/** Naive wall-clock arithmetic, used by snooze and by range ends. */
export function addMinutesToWallClock(wallClock: string, minutes: number): string {
	const parsed = wallClockParts(wallClock);
	if (!parsed) {
		return wallClock;
	}
	const base = new Date(Date.UTC(parsed.ymd.y, parsed.ymd.m - 1, parsed.ymd.d, parsed.time.hour, parsed.time.minute + minutes));
	return `${pad(base.getUTCFullYear(), 4)}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}T${pad(base.getUTCHours())}:${pad(base.getUTCMinutes())}`;
}

export function localToday(nowMs: number, tzId: string): Ymd {
	const clock = wallClockAt(nowMs, tzId);
	const parsed = wallClockParts(clock);
	return parsed ? parsed.ymd : { y: 1970, m: 1, d: 1 };
}

/** Local calendar stamp used for per-device fired logs. */
export function dateStamp(nowMs: number, tzId: string): string {
	const today = localToday(nowMs, tzId);
	return `${today.y}${pad(today.m)}${pad(today.d)}`;
}
