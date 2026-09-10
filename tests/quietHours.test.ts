/**
 * Quiet hours decide an item's severity, which decides whether it interrupts or
 * waits for a digest window. The whole unit suite and the smoke vault run with
 * quiet hours off, so before this file the rule had no coverage at all and a
 * change to it would have downgraded alarms silently.
 *
 * The rule is applied by the parser, from the time written in the note — not at
 * delivery time — so these assertions go through `parseNote`, which is the
 * contract a user sees.
 */

import { describe, expect, it } from "vitest";
import { getLocalePack } from "../src/parse/locales/index";
import { parseNote, type ParseInput, type ParseListItem } from "../src/parse/parseNote";
import { makeEngine, parseSettings, parsedReminder } from "./support";

const pack = getLocalePack("en");
const QUIET = { quietHoursEnabled: true, quietHoursStart: "22:00", quietHoursEnd: "07:00" } as const;

function listItemsOf(content: string): ParseListItem[] {
	const items: ParseListItem[] = [];
	content.split("\n").forEach((line, index) => {
		const match = /^(?:\s*>\s*)*(?:[-*+]|\d+[.)])\s+\[([^\]])\]/u.exec(line);
		if (match) {
			items.push({ line: index, status: match[1] ?? " " });
		}
	});
	return items;
}

/** One line at `time`, in a note dated by its own file name. */
function severityAt(time: string, settings: Partial<ParseInput["settings"]> = {}): string | undefined {
	const content = `- [ ] msg to dentist ${time}`;
	const input: ParseInput = {
		path: "journal/2026-09-11.md",
		content,
		frontmatter: null,
		headings: [],
		listItems: listItemsOf(content),
		settings: parseSettings({ ...QUIET, ...settings }),
		pack,
		tzId: "UTC",
		today: { y: 2026, m: 9, d: 11 },
	};
	return parseNote(input).reminders[0]?.severity;
}

describe("quiet hours decide severity", () => {
	it("splits exactly at both ends of a window that wraps midnight", () => {
		// The window is 22:00 → 07:00, so it wraps. Both boundaries are exclusive
		// at the start and inclusive at the end of the quiet side.
		expect(severityAt("21:59")).toBe("alarm");
		expect(severityAt("22:00")).toBe("digest");
		expect(severityAt("23:30")).toBe("digest");
		expect(severityAt("00:00")).toBe("digest");
		expect(severityAt("06:59")).toBe("digest");
		expect(severityAt("07:00")).toBe("alarm");
		expect(severityAt("12:00")).toBe("alarm");
	});

	it("treats a window inside one day the same way", () => {
		const day = { quietHoursStart: "13:00", quietHoursEnd: "14:00" } as const;
		expect(severityAt("12:59", day)).toBe("alarm");
		expect(severityAt("13:00", day)).toBe("digest");
		expect(severityAt("13:59", day)).toBe("digest");
		expect(severityAt("14:00", day)).toBe("alarm");
	});

	it("does not suppress an alarm when the window is off, blank or malformed", () => {
		expect(severityAt("23:30", { quietHoursEnabled: false })).toBe("alarm");
		expect(severityAt("23:30", { quietHoursStart: "" })).toBe("alarm");
		expect(severityAt("23:30", { quietHoursEnd: "" })).toBe("alarm");
		expect(severityAt("23:30", { quietHoursStart: "nonsense" })).toBe("alarm");
		expect(severityAt("23:30", { quietHoursEnd: "25:99" })).toBe("alarm");
		// A zero-length window covers nothing, rather than covering everything.
		expect(severityAt("23:30", { quietHoursStart: "22:00", quietHoursEnd: "22:00" })).toBe("alarm");
	});

	it("leaves a digest reminder as a digest even outside the window", () => {
		expect(severityAt("09:00", { defaultSeverity: "digest" })).toBe("digest");
	});
});

describe("a digest reminder waits for a window", () => {
	it("is not delivered at its due time, and is delivered at the next window", async () => {
		const due = Date.UTC(2026, 8, 10, 23, 30);
		const h = makeEngine({ now: due, settings: { digestTimes: "08:00\n18:00", quietHoursEnabled: false } });
		await h.engine.sync([parsedReminder({ dueLocal: "2026-09-10T23:30", severity: "digest" })]);

		const atDue = await h.engine.tick(due);
		expect(atDue.fired).toEqual([]);
		expect(atDue.digested).toEqual([]);
		expect(h.sent).toEqual([]);

		// 18:00 has already passed at 23:30, so the next window is 08:00 tomorrow.
		const window = Date.UTC(2026, 8, 11, 8, 0);
		h.setNow(window);
		const atWindow = await h.engine.tick(window);
		expect(atWindow.digested).toHaveLength(1);
		expect(atWindow.fired).toEqual([]);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.message.severity).toBe("digest");
	});
});
