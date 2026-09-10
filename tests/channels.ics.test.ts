import { describe, expect, it } from "vitest";
import { buildIcs, escapeIcsText, foldLine, type IcsEvent } from "../src/channels/ics";

const EVENT: IcsEvent = {
	uid: "9f2c0a7d",
	title: "msg to dentist",
	dueLocal: "2026-09-11T09:00",
	tzId: "Europe/Berlin",
	noteName: "journal/2026/11-09-2026-Friday.md",
	alarmMinutesBefore: 10,
	createdMs: Date.UTC(2026, 8, 10, 12, 0),
};

const OPTIONS = { calName: "Kairos", nowMs: Date.UTC(2026, 8, 10, 12, 0) };

function octets(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** Rejoins RFC 5545 continuation lines, undoing the single leading space. */
function unfold(body: string): string[] {
	const logical: string[] = [];
	for (const line of body.split("\r\n")) {
		if (line.startsWith(" ")) {
			logical[logical.length - 1] = `${logical[logical.length - 1] ?? ""}${line.slice(1)}`;
			continue;
		}
		logical.push(line);
	}
	return logical;
}

describe("buildIcs", () => {
	it("uses CRLF line endings throughout", () => {
		const body = buildIcs([EVENT], OPTIONS);
		expect(body.endsWith("END:VCALENDAR\r\n")).toBe(true);
		expect(/[^\r]\n/u.test(body)).toBe(false);
		expect(body.split("\r\n").slice(0, 5)).toEqual([
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Kairos//Kairos reminders//EN",
			"CALSCALE:GREGORIAN",
			"METHOD:PUBLISH",
		]);
	});

	it("writes the due time as a zoned local time and stamps the build in UTC", () => {
		const body = buildIcs([EVENT], OPTIONS);
		expect(body).toContain(`DTSTART;TZID=${EVENT.tzId}:20260911T090000`);
		expect(body).toContain("DTSTAMP:20260910T120000Z");
	});

	it("gives the event a VALARM with a trigger and the instance id as UID", () => {
		const body = buildIcs([EVENT], OPTIONS);
		expect(body).toContain(`UID:${EVENT.uid}@kairos`);
		expect(body).toContain("BEGIN:VALARM");
		expect(body).toContain("TRIGGER:-PT10M");
		expect(body).toContain("END:VALARM");
		expect(body.indexOf("BEGIN:VALARM")).toBeLessThan(body.indexOf("END:VEVENT"));
		expect(buildIcs([{ ...EVENT, alarmMinutesBefore: 0 }], OPTIONS)).toContain("TRIGGER:PT0M");
	});

	it("folds a long line at 75 octets without splitting a multi-byte character", () => {
		const pieces = foldLine(`SUMMARY:${"ü".repeat(60)}`);
		expect(pieces.length).toBeGreaterThan(1);
		for (const piece of pieces) {
			expect(octets(piece)).toBeLessThanOrEqual(75);
		}
		for (const piece of pieces.slice(1)) {
			expect(piece.startsWith(" ")).toBe(true);
		}
		expect(pieces.map((piece) => (piece.startsWith(" ") ? piece.slice(1) : piece)).join("")).toBe(`SUMMARY:${"ü".repeat(60)}`);
		expect(foldLine("SUMMARY:short")).toEqual(["SUMMARY:short"]);
	});

	it("keeps every physical line of a long title within the octet limit", () => {
		const title = `msg to dentist ${"a".repeat(120)}`;
		const body = buildIcs([{ ...EVENT, title }], OPTIONS);
		for (const line of body.split("\r\n")) {
			expect(octets(line)).toBeLessThanOrEqual(75);
		}
		expect(unfold(body)).toContain(`SUMMARY:${title}`);
	});

	it("escapes the characters RFC 5545 reserves and keeps the note name as the description", () => {
		expect(escapeIcsText("call A, B; C\\D")).toBe("call A\\, B\\; C\\\\D");
		const body = buildIcs([{ ...EVENT, title: "call A, B" }], OPTIONS);
		expect(unfold(body)).toContain("SUMMARY:call A\\, B");
		expect(unfold(body)).toContain(`DESCRIPTION:${EVENT.noteName}`);
	});

	it("is byte-identical across two runs of the same input", () => {
		const first = new TextEncoder().encode(buildIcs([EVENT], OPTIONS));
		const second = new TextEncoder().encode(buildIcs([EVENT], OPTIONS));
		expect(Array.from(first)).toEqual(Array.from(second));
		expect(buildIcs([EVENT], OPTIONS)).toBe(buildIcs([EVENT], OPTIONS));
	});
});
