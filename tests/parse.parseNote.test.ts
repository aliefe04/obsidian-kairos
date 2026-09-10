import { describe, expect, it } from "vitest";
import { getLocalePack } from "../src/parse/locales/index";
import { parseNote, rewriteTimeToken, type ParseInput, type ParseListItem, type ParsedReminder } from "../src/parse/parseNote";
import { parseSettings } from "./support";

const pack = getLocalePack("en");

/** The metadata cache reports list items by line; this mirrors that, in memory. */
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

/** A note whose own file name is the date, which is the form A/B precondition. */
function noteInput(content: string, overrides: Partial<ParseInput> = {}): ParseInput {
	const base: ParseInput = {
		path: "journal/2026-09-11.md",
		content,
		frontmatter: null,
		headings: [],
		listItems: listItemsOf(content),
		settings: parseSettings(),
		pack,
		tzId: "UTC",
		today: { y: 2026, m: 9, d: 11 },
	};
	return { ...base, ...overrides };
}

function onlyReminder(content: string, overrides: Partial<ParseInput> = {}): ParsedReminder {
	const result = parseNote(noteInput(content, overrides));
	expect(result.reminders).toHaveLength(1);
	return result.reminders[0]!;
}

describe("parseNote", () => {
	it("resolves a bare end-of-line time against the note's own date", () => {
		const reminder = onlyReminder("- [ ] msg to dentist 09:00");
		expect(reminder.dueLocal).toBe("2026-09-11T09:00");
		expect(reminder.syntax).toBe("bare-end");
		expect(reminder.title).toBe("msg to dentist");
		expect(reminder.statusChar).toBe(" ");
		expect(reminder.sourcePath).toBe("journal/2026-09-11.md");
	});

	it("resolves a bare start-of-line time and keeps the rest as the title", () => {
		const reminder = onlyReminder("- [ ] 09:00 standup with the team");
		expect(reminder.dueLocal).toBe("2026-09-11T09:00");
		expect(reminder.syntax).toBe("bare-start");
		expect(reminder.title).toBe("standup with the team");
	});

	it("takes an explicit date and time over the note's own date", () => {
		const at = onlyReminder("- [ ] call the bank @ 2026-09-11 09:00");
		expect(at.dueLocal).toBe("2026-09-11T09:00");
		expect(at.syntax).toBe("explicit-at");
		expect(at.title).toBe("call the bank");
	});

	it("refuses a line whose checkbox is completed", () => {
		expect(parseNote(noteInput("- [x] msg to dentist 09:00")).reminders).toEqual([]);
		expect(parseNote(noteInput("- [X] msg to dentist 09:00")).reminders).toEqual([]);
		expect(parseNote(noteInput("- [-] msg to dentist 09:00")).reminders).toEqual([]);
	});

	it("keeps a reminder on any other status character", () => {
		const reminder = onlyReminder("- [>] msg to dentist 09:00");
		expect(reminder.statusChar).toBe(">");
		expect(reminder.dueLocal).toBe("2026-09-11T09:00");
	});

	it("prefers the bell over the calendar field when a line carries both", () => {
		const reminder = onlyReminder("- [ ] report 📅 2026-09-12 08:00 ⏰ 2026-09-11 15:00");
		expect(reminder.dueLocal).toBe("2026-09-11T15:00");
		expect(reminder.syntax).toBe("emoji-token");
		expect(reminder.title).toContain("report");
		expect(reminder.title).not.toContain("⏰");
	});

	it("reads the Reminder plugin's own parenthesised form", () => {
		const reminder = onlyReminder("- [ ] pay rent (@2026-10-01 08:30)");
		expect(reminder.dueLocal).toBe("2026-10-01T08:30");
		expect(reminder.syntax).toBe("reminder-paren");
	});

	it("skips a list item inside a fenced code block", () => {
		const content = [
			"# 2026-09-11",
			"",
			"```text",
			"- [ ] inside fence 09:00",
			"```",
			"",
			"- [ ] outside fence 10:00",
		].join("\n");
		const result = parseNote(noteInput(content));
		expect(result.reminders).toHaveLength(1);
		expect(result.reminders[0]?.title).toBe("outside fence");
		expect(result.reminders[0]?.dueLocal).toBe("2026-09-11T10:00");
	});

	it("parses a checkbox inside a callout", () => {
		const content = ["> [!note] Today", "> - [ ] call the dentist 09:00"].join("\n");
		const reminder = onlyReminder(content);
		expect(reminder.dueLocal).toBe("2026-09-11T09:00");
		expect(reminder.syntax).toBe("bare-end");
		expect(reminder.title).toBe("call the dentist");
		expect(reminder.line).toBe(1);
	});

	it("ignores a mid-line time and a time in a URL or an inline code span", () => {
		expect(parseNote(noteInput("- [ ] discuss whether 09:00 works for the call")).reminders).toEqual([]);
		expect(parseNote(noteInput("- [ ] see https://x/9:00 for the agenda")).reminders).toEqual([]);
		expect(parseNote(noteInput("- [ ] run `9:00` before the standup")).reminders).toEqual([]);
	});

	it("needs a date from somewhere: a bare time in an undated note sets nothing", () => {
		const result = parseNote(noteInput("- [ ] msg to dentist 09:00", { path: "notes/scratch.md" }));
		expect(result.reminders).toEqual([]);
	});
});

describe("rewriteTimeToken", () => {
	it("rewrites the time in place and keeps a meridiem suffix", () => {
		const rewritten = rewriteTimeToken("- [ ] call the dentist 9:00am", { hour: 9, minute: 0 }, { hour: 9, minute: 50 }, pack);
		expect(rewritten).toBe("- [ ] call the dentist 09:50am");
	});

	it("keeps the end of a time range instead of deleting it", () => {
		expect(rewriteTimeToken("- [ ] standup 09:00-10:00", { hour: 9, minute: 0 }, { hour: 9, minute: 50 }, pack)).toBe(
			"- [ ] standup 09:50-10:00",
		);
		expect(rewriteTimeToken("- [ ] standup 09:00 to 10:00", { hour: 9, minute: 0 }, { hour: 9, minute: 50 }, pack)).toBe(
			"- [ ] standup 09:50-10:00",
		);
	});

	it("keeps the twelve-hour form the author wrote, and corrects the half of the day", () => {
		expect(rewriteTimeToken("- [ ] call at 09:00 PM", { hour: 21, minute: 0 }, { hour: 21, minute: 50 }, pack)).toBe(
			"- [ ] call at 09:50 PM",
		);
		expect(rewriteTimeToken("- [ ] lunch 11:50am", { hour: 11, minute: 50 }, { hour: 12, minute: 10 }, pack)).toBe(
			"- [ ] lunch 12:10pm",
		);
		expect(rewriteTimeToken("- [ ] wind down 11:50pm", { hour: 23, minute: 50 }, { hour: 0, minute: 10 }, pack)).toBe(
			"- [ ] wind down 12:10am",
		);
	});

	it("leaves the rest of the line alone and reports a line with no such time", () => {
		expect(rewriteTimeToken("- [ ] standup 09:00 #work ^standup", { hour: 9, minute: 0 }, { hour: 9, minute: 50 }, pack)).toBe(
			"- [ ] standup 09:50 #work ^standup",
		);
		expect(rewriteTimeToken("- [ ] standup", { hour: 9, minute: 0 }, { hour: 9, minute: 50 }, pack)).toBeNull();
		expect(rewriteTimeToken("- [ ] standup 11:00", { hour: 9, minute: 0 }, { hour: 9, minute: 50 }, pack)).toBeNull();
	});
});
