/**
 * The two directions of the daily-note date contract.
 *
 * `formatDailyNoteName` renders a path for a date, and the matcher reads a date
 * back out of a path. They are written as inverses ("the inverse of the format
 * matcher ... lands in the note the index will read back", `dailyNotePath.ts`),
 * but nothing tested that, and the pair is how a reminder written by the plugin's
 * own **Add reminder** command could land in a note the index then refuses.
 */

import { describe, expect, it } from "vitest";
import { dailyNotePath } from "../src/parse/dailyNotePath";
import { getLocalePack } from "../src/parse/locales/index";
import { resolveNoteDate, type NoteDateResolution } from "../src/parse/noteDate";
import { DEFAULT_FORMATS } from "../src/settings";

const pack = getLocalePack("en");
const FOLDER = "04 - Journal";

/** Reads a rendered path back, exactly as the index does. */
function resolveBack(path: string, format: string, year: number): NoteDateResolution {
	const slash = path.lastIndexOf("/");
	const folderPath = slash < 0 ? "" : path.slice(0, slash);
	const fileName = (slash < 0 ? path : path.slice(slash + 1)).replace(/\.md$/u, "");
	return resolveNoteDate({
		fileName,
		folderPath,
		frontmatter: null,
		headings: [],
		itemLine: 0,
		formats: [format],
		dailyNotesFolder: FOLDER,
		toggles: { frontmatter: true, heading: true, filename: true, dailyNotesFolder: true },
		ctx: { pack, today: { y: year, m: 1, d: 1 }, defaultYear: year },
	});
}

describe("daily note paths", () => {
	it("renders the name the format asks for", () => {
		expect(dailyNotePath(FOLDER, "YYYY/MM/DD-MM-YYYY-dddd", { y: 2026, m: 9, d: 11 }, pack)).toBe(
			"04 - Journal/2026/09/11-09-2026-Friday.md",
		);
		expect(dailyNotePath(FOLDER, "YYYY-MM-DD", { y: 2026, m: 1, d: 1 }, pack)).toBe("04 - Journal/2026-01-01.md");
		expect(dailyNotePath("", "YYYY-MM-DD", { y: 2026, m: 1, d: 1 }, pack)).toBe("2026-01-01.md");
	});

	it("round-trips every default format through the matcher", () => {
		const dates = [
			{ y: 2026, m: 9, d: 11 },
			{ y: 2026, m: 1, d: 1 },
			{ y: 2026, m: 12, d: 31 },
			{ y: 2028, m: 2, d: 29 },
		];
		// A day-first numeric format is genuinely ambiguous for a date whose day and
		// month are both readable as a month, which the matcher refuses by design.
		// Covered on its own below.
		const ambiguousByNature = new Set(["DD-MM-YYYY", "DD.MM.YYYY"]);
		const failures: string[] = [];
		for (const format of ["YYYY/MM/DD-MM-YYYY-dddd", ...DEFAULT_FORMATS]) {
			if (ambiguousByNature.has(format)) {
				continue;
			}
			for (const date of dates) {
				const path = dailyNotePath(FOLDER, format, date, pack);
				const resolved = resolveBack(path, format, date.y);
				if (!resolved.ok) {
					failures.push(`${format}: ${path} → ${resolved.reason}`);
				} else if (resolved.ymd.y !== date.y || resolved.ymd.m !== date.m || resolved.ymd.d !== date.d) {
					failures.push(`${format}: ${path} → ${JSON.stringify(resolved.ymd)}`);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it("refuses the name a day-first format renders when both readings are valid", () => {
		// `DD-MM-YYYY` renders 11-09-2026: readable, and refused rather than guessed.
		// That is the documented behaviour, and it is why the folder cross-check
		// exists — with a format like this, a name Kairos itself would write can come
		// back as unschedulable.
		expect(dailyNotePath(FOLDER, "DD-MM-YYYY", { y: 2026, m: 9, d: 11 }, pack)).toBe("04 - Journal/11-09-2026.md");
		expect(resolveBack("04 - Journal/11-09-2026.md", "DD-MM-YYYY", 2026)).toEqual({ ok: false, reason: "ambiguous" });
		// The same format is fine for a date that only reads one way.
		expect(resolveBack(dailyNotePath(FOLDER, "DD-MM-YYYY", { y: 2026, m: 12, d: 31 }, pack), "DD-MM-YYYY", 2026)).toMatchObject({
			ok: true,
			ymd: { y: 2026, m: 12, d: 31 },
		});
	});
});
