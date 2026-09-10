/**
 * Note to reminders (docs/spec/syntax.md §1, §3, §4).
 *
 * The list items come from the metadata cache; the text comes from the cached
 * read. Everything below is pure so the whole parser is testable headlessly.
 */

import type { NoteHeading } from "./noteDate";
import { resolveNoteDate, type DateSourceName } from "./noteDate";
import { foldWord, type LocalePack } from "./locales/index";
import type { DateParseContext, Hm, ReminderSyntax, TimeMatch, Ymd } from "./timeTokens";
import { classifyTimePosition, findExplicitReminder, formatHm, isValidYmd, parseHm, scanTimes, toWallClock } from "./timeTokens";

export interface ParsedReminder {
	sourcePath: string;
	line: number;
	blockId?: string;
	statusChar: string;
	title: string;
	/** 'YYYY-MM-DDTHH:mm' local wall clock. */
	dueLocal: string;
	tzId: string;
	syntax: ReminderSyntax;
	severity: "alarm" | "digest";
}

export interface ParseListItem {
	line: number;
	/** The character between the brackets, or undefined when the item has no checkbox. */
	status: string | undefined;
}

export interface ParseSettings {
	dailyNotesFolder: string;
	dailyNoteFormats: string;
	useFrontmatterDate: boolean;
	useHeadingDate: boolean;
	useFilenameDate: boolean;
	useDailyNotesFolderDate: boolean;
	defaultReminderTime: string;
	defaultSeverity: "alarm" | "digest";
	quietHoursEnabled: boolean;
	quietHoursStart: string;
	quietHoursEnd: string;
	aggressiveMidLine: boolean;
	completingStatusChars: string;
}

export interface ParseInput {
	path: string;
	content: string;
	frontmatter: Record<string, unknown> | null;
	headings: NoteHeading[];
	listItems: ParseListItem[];
	settings: ParseSettings;
	pack: LocalePack;
	tzId: string;
	today: Ymd;
}

export interface ParseNoteResult {
	reminders: ParsedReminder[];
	ambiguous: boolean;
	dateSource: DateSourceName | null;
}

const CHECKBOX = /^(?:\s*>\s*)*(?:[-*+]|\d+[.)])\s+\[([^\]])\]\s?/u;
const BLOCK_ID = /\s*\^([\p{L}\p{N}_-]+)\s*$/u;
const CALLOUT_PREFIX = /^\s*(?:>\s*)+/u;

/** Length of the leading blockquote marker run, so the scan starts after `> `. */
function stripCalloutPrefix(line: string): number {
	const match = CALLOUT_PREFIX.exec(line);
	return match === null ? 0 : match[0].length;
}

function blockedLines(content: string): Set<number> {
	const lines = content.split(/\r?\n/u);
	const blocked = new Set<number>();
	let index = 0;
	if ((lines[0] ?? "").trim() === "---") {
		blocked.add(0);
		index = 1;
		while (index < lines.length && (lines[index] ?? "").trim() !== "---") {
			blocked.add(index);
			index += 1;
		}
		blocked.add(index);
	}
	let fence: string | null = null;
	lines.forEach((line, position) => {
		const trimmed = line.trim();
		const fenceMatch = /^(```+|~~~+)/u.exec(trimmed);
		if (fence) {
			blocked.add(position);
			if (fenceMatch && trimmed.startsWith(fence)) {
				fence = null;
			}
			return;
		}
		if (fenceMatch) {
			fence = fenceMatch[1] ?? "```";
			blocked.add(position);
			return;
		}
		if (/^\|.*\|\s*$/u.test(trimmed)) {
			blocked.add(position);
		}
	});
	return blocked;
}

function minutesOfDayOf(time: Hm): number {
	return time.hour * 60 + time.minute;
}

function inQuietHours(time: Hm, settings: ParseSettings): boolean {
	if (!settings.quietHoursEnabled) {
		return false;
	}
	const start = parseHm(settings.quietHoursStart);
	const end = parseHm(settings.quietHoursEnd);
	if (!start || !end) {
		return false;
	}
	const from = minutesOfDayOf(start);
	const to = minutesOfDayOf(end);
	const value = minutesOfDayOf(time);
	if (from === to) {
		return false;
	}
	return from < to ? value >= from && value < to : value >= from || value < to;
}

function severityFor(time: Hm, settings: ParseSettings): "alarm" | "digest" {
	return inQuietHours(time, settings) ? "digest" : settings.defaultSeverity;
}

function tidyTitle(text: string): string {
	return text
		.replace(/\s+/gu, " ")
		.replace(/\s+([,.;:!?])/gu, "$1")
		.trim()
		.replace(/[\s·]+$/u, "")
		.trim();
}

function cut(text: string, from: number, to: number): string {
	return tidyTitle(`${text.slice(0, from)} ${text.slice(Math.max(from, to))}`);
}

/** One line of a note, resolved to a reminder when the syntax says so. */
export function parseReminderLine(
	body: string,
	context: { path: string; line: number; statusChar: string; noteDate: Ymd | null; input: ParseInput },
): ParsedReminder | null {
	const { input } = context;
	const ctx: DateParseContext = { pack: input.pack, today: input.today, defaultYear: context.noteDate?.y ?? input.today.y };
	const blockIdMatch = BLOCK_ID.exec(body);
	const blockId = blockIdMatch ? blockIdMatch[1] : undefined;
	const withoutBlockId = blockIdMatch ? body.slice(0, blockIdMatch.index) : body;
	const explicit = findExplicitReminder(withoutBlockId, ctx);
	if (explicit) {
		const ymd = explicit.ymd ?? context.noteDate;
		if (!ymd || !isValidYmd(ymd)) {
			return null;
		}
		const time = explicit.time ?? parseHm(input.settings.defaultReminderTime) ?? { hour: 9, minute: 0 };
		return {
			sourcePath: context.path,
			line: context.line,
			...(blockId === undefined ? {} : { blockId }),
			statusChar: context.statusChar,
			title: cut(withoutBlockId, explicit.start, explicit.end),
			dueLocal: toWallClock(ymd, time),
			tzId: input.tzId,
			syntax: explicit.syntax,
			severity: severityFor(time, input.settings),
		};
	}
	const matches = scanTimes(withoutBlockId, input.pack);
	const chosen = matches
		.map((match) => ({ match, position: classifyTimePosition(withoutBlockId, match, input.pack) }))
		.find((candidate) => input.settings.aggressiveMidLine || candidate.position !== "mid-line");
	if (!chosen) {
		return null;
	}
	if (!context.noteDate) {
		return null;
	}
	const time: Hm = { hour: chosen.match.hour, minute: chosen.match.minute };
	const syntax: ReminderSyntax = chosen.position === "start-of-line" ? "bare-start" : chosen.position === "end-of-line" ? "bare-end" : "at-prefix";
	const atWord = /(?:^|[\s([])(?:[\p{L}]+|@)\s*$/u.exec(withoutBlockId.slice(0, chosen.match.start));
	const stripFrom = chosen.position === "at-prefix" && atWord ? chosen.match.start - atWord[0].length : chosen.match.start;
	return {
		sourcePath: context.path,
		line: context.line,
		...(blockId === undefined ? {} : { blockId }),
		statusChar: context.statusChar,
		title: cut(withoutBlockId, stripFrom, chosen.match.end),
		dueLocal: toWallClock(context.noteDate, time),
		tzId: input.tzId,
		syntax,
		severity: severityFor(time, input.settings),
	};
}

export function parseNote(input: ParseInput): ParseNoteResult {
	const lines = input.content.split(/\r?\n/u);
	const blocked = blockedLines(input.content);
	const toggles = {
		frontmatter: input.settings.useFrontmatterDate,
		heading: input.settings.useHeadingDate,
		filename: input.settings.useFilenameDate,
		dailyNotesFolder: input.settings.useDailyNotesFolderDate,
	};
	const formats = input.settings.dailyNoteFormats
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const slash = input.path.lastIndexOf("/");
	const folderPath = slash < 0 ? "" : input.path.slice(0, slash);
	const fileName = (slash < 0 ? input.path : input.path.slice(slash + 1)).replace(/\.md$/u, "");
	const reminders: ParsedReminder[] = [];
	let ambiguous = false;
	let dateSource: DateSourceName | null = null;
	let noteDate: Ymd | null = null;
	for (const item of input.listItems) {
		const line = lines[item.line] ?? "";
		if (blocked.has(item.line) || item.status === undefined) {
			continue;
		}
		const prefix = stripCalloutPrefix(line);
		const stripped = line.slice(prefix);
		const checkbox = CHECKBOX.exec(stripped);
		if (!checkbox) {
			continue;
		}
		const statusChar = checkbox[1] ?? " ";
		if (input.settings.completingStatusChars.includes(statusChar)) {
			continue;
		}
		const body = stripped.slice(checkbox[0].length - 0);
		const resolution = resolveNoteDate({
			fileName,
			folderPath,
			frontmatter: input.frontmatter,
			headings: input.headings,
			itemLine: item.line,
			formats,
			dailyNotesFolder: input.settings.dailyNotesFolder,
			toggles,
			ctx: { pack: input.pack, today: input.today, defaultYear: input.today.y },
		});
		if (resolution.ok) {
			noteDate = resolution.ymd;
			dateSource = resolution.source;
		} else if (resolution.reason === "ambiguous") {
			ambiguous = true;
		}
		const reminder = parseReminderLine(body, { path: input.path, line: item.line, statusChar, noteDate, input });
		if (reminder) {
			reminders.push(reminder);
		}
	}
	return { reminders, ambiguous, dateSource };
}

const WRITTEN_DIGITS = /^\d{1,2}(?:[:.]\d{2})?/u;

/** The `am`/`pm` marker a token was written with, or null when it is 24-hour. */
function meridiemTail(written: string, pack: LocalePack): string | null {
	const digits = WRITTEN_DIGITS.exec(written);
	const tail = digits ? written.slice(digits[0].length) : "";
	const word = foldWord(tail.trim().replace(/\./gu, ""), pack.tag);
	const known = pack.meridiem.am.includes(word) || pack.meridiem.pm.includes(word);
	return word.length > 0 && known ? tail : null;
}

/**
 * The new start of a single token. A token written with `am`/`pm` stays in the
 * twelve-hour form the author wrote: `match.end` covers the marker, so emitting
 * `formatHm(to)` alone would delete it and rewrite `9:00am` as `09:50`. Crossing
 * noon or midnight changes the half of the day, and then the marker is replaced
 * rather than kept — `11:50am` plus twenty minutes is `12:10pm`, never `12:10am`.
 */
function rewrittenStart(written: string, to: Hm, meridiem: "am" | "pm" | null, pack: LocalePack): string {
	if (meridiem === null) {
		return formatHm(to);
	}
	const kind: "am" | "pm" = to.hour < 12 ? "am" : "pm";
	const tail = meridiemTail(written, pack);
	const marker = kind === meridiem && tail !== null ? tail : pack.meridiem[kind][0];
	if (marker === undefined) {
		return formatHm(to);
	}
	const hour12 = to.hour % 12 === 0 ? 12 : to.hour % 12;
	return `${formatHm({ hour: hour12, minute: to.minute })}${marker}`;
}

/**
 * Rewrites the time token a reminder came from (spec §5). Returns null when no
 * writable token exists, so the caller can decide where to put the new time.
 */
export function rewriteTimeToken(lineText: string, from: Hm, to: Hm, pack: LocalePack): string | null {
	const match: TimeMatch | undefined = scanTimes(lineText, pack).find((candidate) => candidate.hour === from.hour && candidate.minute === from.minute);
	if (!match) {
		return null;
	}
	// `match.end` spans any range end, so a range has to be re-emitted or the
	// `-10:00` half of `09:00-10:00` would be deleted. The separator is
	// normalised to a hyphen; the times themselves are preserved.
	const replacement =
		match.rangeEnd === null
			? rewrittenStart(lineText.slice(match.start, match.end), to, match.meridiem, pack)
			: `${formatHm(to)}-${formatHm(match.rangeEnd)}`;
	return `${lineText.slice(0, match.start)}${replacement}${lineText.slice(match.end)}`;
}
