/**
 * The two directions of the daily-note date contract, driven end to end.
 *
 * `formatDailyNoteName` renders a path for a date; the parser reads a date back
 * out of a path. They are written as inverses ("the inverse of the format matcher
 * ... lands in the note the index will read back", `dailyNotePath.ts`), and the
 * pair is how **Add reminder** can create a note the index then refuses.
 *
 * These go through `parseNote` rather than assembling a matcher input by hand: a
 * hand-built input is how this file first reported "no-date" for every format,
 * against a matcher that works, because the reconstruction disagreed with the
 * production wiring.
 */

import { describe, expect, it } from "vitest";
import { dailyNotePath } from "../src/parse/dailyNotePath";
import { getLocalePack, listLocaleTags, type LocalePack } from "../src/parse/locales/index";
import { parseNote, type ParseInput, type ParseListItem } from "../src/parse/parseNote";
import type { Ymd } from "../src/parse/timeTokens";
import { DEFAULT_FORMATS } from "../src/settings";
import { parseSettings } from "./support";

const pack = getLocalePack("en");
const FOLDER = "04 - Journal";

function listItemsOf(content: string): ParseListItem[] {
	const items: ParseListItem[] = [];
	content.split("\n").forEach((line, index) => {
		const match = /^(?:\s*>\s*)*(?:[-*+]|\d+[.)])\s+\[([^\]])\]/u.exec(line);
		if (match) items.push({ line: index, status: match[1] ?? " " });
	});
	return items;
}

/** Walks a rendered path through the parser exactly as the index does. */
function parseAt(path: string, format: string, year: number, localePack: LocalePack = pack) {
	const content = "- [ ] Ping 09:00";
	const input: ParseInput = {
		path,
		content,
		frontmatter: null,
		headings: [],
		listItems: listItemsOf(content),
		settings: parseSettings({ dailyNotesFolder: FOLDER, dailyNoteFormats: [format, ...DEFAULT_FORMATS].join("\n") }),
		pack: localePack,
		tzId: "Europe/Istanbul",
		today: { y: year, m: 1, d: 1 },
	};
	return parseNote(input);
}

function iso(date: Ymd): string {
	return `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
}

describe("daily note paths", () => {
	it("renders the name the format asks for", () => {
		expect(dailyNotePath(FOLDER, "YYYY/MM/DD-MM-YYYY-dddd", { y: 2026, m: 9, d: 11 }, pack)).toBe(
			"04 - Journal/2026/09/11-09-2026-Friday.md",
		);
		expect(dailyNotePath(FOLDER, "YYYY-MM-DD", { y: 2026, m: 1, d: 1 }, pack)).toBe("04 - Journal/2026-01-01.md");
		expect(dailyNotePath("", "YYYY-MM-DD", { y: 2026, m: 1, d: 1 }, pack)).toBe("2026-01-01.md");
	});

	it("round-trips every default format through the parser", () => {
		const dates = [
			{ y: 2026, m: 9, d: 11 },
			{ y: 2026, m: 1, d: 1 },
			{ y: 2026, m: 12, d: 31 },
			{ y: 2028, m: 2, d: 29 },
		];
		// A day-first numeric format is genuinely ambiguous for a date whose day and
		// month both read as a month, which the parser refuses by design. Covered on
		// its own below.
		const ambiguousByNature = new Set(["DD-MM-YYYY", "DD.MM.YYYY"]);
		const failures: string[] = [];
		for (const format of ["YYYY/MM/DD-MM-YYYY-dddd", ...DEFAULT_FORMATS]) {
			if (ambiguousByNature.has(format)) {
				continue;
			}
			for (const date of dates) {
				const path = dailyNotePath(FOLDER, format, date, pack);
				const result = parseAt(path, format, date.y);
				const reminder = result.reminders[0];
				if (!reminder) {
					failures.push(`${format}: ${path} → no reminder`);
				} else if (reminder.dueLocal !== `${iso(date)}T09:00`) {
					failures.push(`${format}: ${path} → ${reminder.dueLocal}`);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it("round-trips the weekday name in every shipped locale", () => {
		// The display table is per locale, and a locale whose spelling or casing is
		// wrong writes a note its own parser cannot read back.
		const failures: string[] = [];
		const friday = { y: 2026, m: 9, d: 11 };
		for (const tag of listLocaleTags()) {
			const localePack = getLocalePack(tag);
			const path = dailyNotePath(FOLDER, "YYYY/MM/DD-MM-YYYY-dddd", friday, localePack);
			const reminder = parseAt(path, "YYYY/MM/DD-MM-YYYY-dddd", friday.y, localePack).reminders[0];
			if (!reminder || reminder.dueLocal !== `${iso(friday)}T09:00`) {
				failures.push(`${tag}: ${path} → ${reminder?.dueLocal ?? "no reminder"}`);
			}
		}
		expect(failures).toEqual([]);
	});

	it("refuses the name a day-first format renders when both readings are valid", () => {
		// `DD-MM-YYYY` renders 11-09-2026: readable by a person, refused rather than
		// guessed. The same format is fine for a date that only reads one way, which
		// is the case below it.
		expect(dailyNotePath(FOLDER, "DD-MM-YYYY", { y: 2026, m: 9, d: 11 }, pack)).toBe("04 - Journal/11-09-2026.md");
		const ambiguous = parseAt("04 - Journal/11-09-2026.md", "DD-MM-YYYY", 2026);
		expect(ambiguous.reminders).toEqual([]);
		expect(ambiguous.ambiguous).toBe(true);

		const unambiguous = parseAt(dailyNotePath(FOLDER, "DD-MM-YYYY", { y: 2026, m: 12, d: 31 }, pack), "DD-MM-YYYY", 2026);
		expect(unambiguous.reminders[0]?.dueLocal).toBe("2026-12-31T09:00");
	});
});
