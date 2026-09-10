import { describe, expect, it } from "vitest";
import { getLocalePack } from "../src/parse/locales/index";
import { resolveNoteDate, type NoteDateInput, type NoteDateResolution } from "../src/parse/noteDate";
import { toIsoDate, type DateParseContext } from "../src/parse/timeTokens";

const CTX: DateParseContext = { pack: getLocalePack("en"), today: { y: 2026, m: 9, d: 11 }, defaultYear: 2026 };
const FORMATS = ["YYYY-MM-DD", "DD-MM-YYYY", "YYYY/MM/DD-MM-YYYY-dddd", "DD.MM.YYYY", "YYYYMMDD"];

function input(overrides: Partial<NoteDateInput> = {}): NoteDateInput {
	const base: NoteDateInput = {
		fileName: "scratch",
		folderPath: "notes",
		frontmatter: null,
		headings: [],
		itemLine: 0,
		formats: FORMATS,
		dailyNotesFolder: "",
		toggles: { frontmatter: true, heading: true, filename: true, dailyNotesFolder: true },
		ctx: CTX,
	};
	return { ...base, ...overrides };
}

function resolvedDate(resolution: NoteDateResolution): string | undefined {
	return resolution.ok ? toIsoDate(resolution.ymd) : undefined;
}

describe("resolveNoteDate", () => {
	it("takes the frontmatter date first, whichever key carries it", () => {
		const fromDate = resolveNoteDate(input({ frontmatter: { date: "2026-09-11" } }));
		expect(resolvedDate(fromDate)).toBe("2026-09-11");
		expect(fromDate.ok && fromDate.source).toBe("frontmatter");

		const fromJournalDate = resolveNoteDate(input({ frontmatter: { "journal-date": "2026-09-12" } }));
		expect(resolvedDate(fromJournalDate)).toBe("2026-09-12");

		const fromYamlDate = resolveNoteDate(input({ frontmatter: { created: new Date(2026, 8, 13) } }));
		expect(resolvedDate(fromYamlDate)).toBe("2026-09-13");
	});

	it("falls back to the H1 when the frontmatter has no date", () => {
		const resolution = resolveNoteDate(input({ headings: [{ line: 0, level: 1, text: "Fri, Sep 11" }], itemLine: 2 }));
		expect(resolvedDate(resolution)).toBe("2026-09-11");
		expect(resolution.ok && resolution.source).toBe("h1");
	});

	it("uses the nearest preceding date heading in a one-note-per-month journal", () => {
		const resolution = resolveNoteDate(
			input({
				fileName: "2026-09",
				folderPath: "journal",
				headings: [
					{ line: 0, level: 1, text: "September 2026" },
					{ line: 4, level: 2, text: "2026-09-11" },
					{ line: 9, level: 2, text: "2026-09-12" },
				],
				itemLine: 6,
			}),
		);
		expect(resolvedDate(resolution)).toBe("2026-09-11");
		expect(resolution.ok && resolution.source).toBe("heading");
	});

	it("resolves a day-first file name through the configured Daily Notes format", () => {
		const resolution = resolveNoteDate(
			input({
				fileName: "11-09-2026-Friday",
				folderPath: "journal/2026",
				formats: ["YYYY/DD-MM-YYYY-dddd"],
				dailyNotesFolder: "journal",
			}),
		);
		expect(resolvedDate(resolution)).toBe("2026-09-11");
		expect(resolution.ok && resolution.source).toBe("daily-notes");
	});

	it("refuses a file name whose day and month cannot be told apart", () => {
		const resolution = resolveNoteDate(input({ fileName: "08-09-2026", folderPath: "notes" }));
		expect(resolution).toEqual({ ok: false, reason: "ambiguous" });
	});

	it("accepts a date from a parent folder when the file name carries none", () => {
		const resolution = resolveNoteDate(input({ fileName: "standup", folderPath: "journal/2026-09-11" }));
		expect(resolvedDate(resolution)).toBe("2026-09-11");
	});

	it("reports no date for a note that never mentions one", () => {
		const resolution = resolveNoteDate(input({ fileName: "scratch", folderPath: "notes" }));
		expect(resolution.ok).toBe(false);
		expect(resolution.ok ? undefined : resolution.reason).toBe("no-date");
	});

	it("refuses an impossible day rather than rolling it over", () => {
		const resolution = resolveNoteDate(input({ fileName: "2026-02-30", folderPath: "notes" }));
		expect(resolution.ok).toBe(false);
	});
});
