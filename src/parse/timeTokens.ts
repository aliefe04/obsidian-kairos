/**
 * Time and date token grammar (docs/spec/syntax.md §1).
 *
 * Pure: no Obsidian imports, no clock reads. Every offset returned is an index
 * into the string that was scanned, so callers can strip matched tokens when
 * they build a reminder title.
 */

import { foldWord, type LocalePack, type RelativeDay } from "./locales/index";

export interface Ymd {
	y: number;
	m: number;
	d: number;
}

export interface Hm {
	hour: number;
	minute: number;
}

export type ReminderSyntax =
	| "bare-end"
	| "bare-start"
	| "at-prefix"
	| "explicit-at"
	| "emoji-token"
	| "reminder-paren"
	| "tasks-due";

export type TimePosition = "end-of-line" | "start-of-line" | "at-prefix" | "mid-line";

export interface TimeMatch {
	/** Index of the first digit of the token. */
	start: number;
	/** Exclusive end of the token, including any range end. */
	end: number;
	hour: number;
	minute: number;
	meridiem: "am" | "pm" | null;
	/** Set when the token opens a time range (`09:00-10:00`). */
	rangeEnd: Hm | null;
}

export interface DateToken {
	ymd: Ymd;
	start: number;
	end: number;
}

export interface ExplicitMatch {
	syntax: ReminderSyntax;
	/** null means "the note's own date"; only possible for a time-only `⏰`. */
	ymd: Ymd | null;
	/** null means "the configured default reminder time". */
	time: Hm | null;
	start: number;
	end: number;
}

export interface DateParseContext {
	pack: LocalePack;
	/** Local today, injected so parsing is deterministic in tests. */
	today: Ymd;
	/** Used for year-less tokens such as `Sep 11`. */
	defaultYear: number;
}

const WORD_EDGE = "[^\\p{L}\\p{N}]";
const WORD_EDGE_RE = /[^\p{L}\p{N}]/u;
const MERIDIEM_SUFFIX = /^\s*([\p{L}.]+)/u;
const RANGE_SEPARATOR = /^\s*(?:-|–|—|to)\s*/u;
const TIME_ATOM = /(\d{1,2})(?:([:.])(\d{2}))?/uy;

/** Calendar helpers ----------------------------------------------------- */

export function daysInMonth(year: number, month: number): number {
	if (month < 1 || month > 12) {
		return 0;
	}
	const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	const base = lengths[month - 1] ?? 0;
	if (month !== 2) {
		return base;
	}
	const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	return leap ? 29 : base;
}

export function isValidYmd(value: Ymd): boolean {
	if (!Number.isInteger(value.y) || !Number.isInteger(value.m) || !Number.isInteger(value.d)) {
		return false;
	}
	if (value.y < 1000 || value.y > 9999) {
		return false;
	}
	return value.d >= 1 && value.d <= daysInMonth(value.y, value.m);
}

/** 0 = Sunday, matching `Date.getUTCDay` for the same calendar date. */
export function weekdayOf(value: Ymd): number {
	return new Date(Date.UTC(value.y, value.m - 1, value.d)).getUTCDay();
}

export function toIsoDate(value: Ymd): string {
	const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
	return `${pad(value.y, 4)}-${pad(value.m)}-${pad(value.d)}`;
}

export function toWallClock(ymd: Ymd, time: Hm): string {
	return `${toIsoDate(ymd)}T${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

/** Time tokens ---------------------------------------------------------- */

function meridiemAt(text: string, index: number, pack: LocalePack): { kind: "am" | "pm"; end: number } | null {
	const match = MERIDIEM_SUFFIX.exec(text.slice(index));
	if (!match) {
		return null;
	}
	const word = foldWord(match[1] ?? "", pack.tag);
	const raw = match[1] === undefined ? "" : match[1];
	// A word must be a meridiem marker, not the start of an ordinary word.
	const isMarker =
		pack.meridiem.am.includes(word) || pack.meridiem.pm.includes(word) || pack.meridiem.am.includes(raw) || pack.meridiem.pm.includes(raw);
	if (!isMarker || match[0].trim().length !== raw.length) {
		return null;
	}
	const after = index + match[0].length;
	const next = text.slice(after, after + 1);
	if (next !== "" && /[\p{L}\p{N}]/u.test(next)) {
		return null;
	}
	const kind = pack.meridiem.am.includes(word) || pack.meridiem.am.includes(raw) ? "am" : "pm";
	return { kind, end: after };
}

function normalizeHour(hour: number, meridiem: "am" | "pm" | null): number | null {
	if (meridiem === null) {
		return hour >= 0 && hour <= 23 ? hour : null;
	}
	if (hour < 1 || hour > 12) {
		return null;
	}
	if (meridiem === "am") {
		return hour === 12 ? 0 : hour;
	}
	return hour === 12 ? 12 : hour + 12;
}

function readTimeAtom(text: string, index: number, pack: LocalePack): TimeMatch | null {
	TIME_ATOM.lastIndex = index;
	const atom = TIME_ATOM.exec(text);
	if (!atom || atom.index !== index) {
		return null;
	}
	const hasMinutes = atom[3] !== undefined;
	let cursor = index + atom[0].length;
	let meridiem: "am" | "pm" | null = null;
	const suffix = meridiemAt(text, cursor, pack);
	if (suffix) {
		meridiem = suffix.kind;
		cursor = suffix.end;
	}
	if (!hasMinutes && meridiem === null) {
		return null;
	}
	const hour = normalizeHour(Number(atom[1]), meridiem);
	if (hour === null) {
		return null;
	}
	const minute = hasMinutes ? Number(atom[3]) : 0;
	if (minute > 59) {
		return null;
	}
	return { start: index, end: cursor, hour, minute, meridiem, rangeEnd: null };
}

function isRejectedPredecessor(char: string | undefined): boolean {
	return char === "/" || char === ":";
}

/** Spans that must never be scanned: inline code, URLs, wikilinks. */
function maskedSpans(text: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	const push = (start: number, end: number): void => {
		spans.push([start, end]);
	};
	const inlineCode = /(`+)[\s\S]*?\1/gu;
	for (let match = inlineCode.exec(text); match; match = inlineCode.exec(text)) {
		push(match.index, match.index + match[0].length);
	}
	const urls = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/giu;
	for (let match = urls.exec(text); match; match = urls.exec(text)) {
		push(match.index, match.index + match[0].length);
	}
	const wikilinks = /\[\[[\s\S]*?\]\]/gu;
	for (let match = wikilinks.exec(text); match; match = wikilinks.exec(text)) {
		push(match.index, match.index + match[0].length);
	}
	return spans;
}

function inMaskedSpan(spans: Array<[number, number]>, index: number): boolean {
	for (const [start, end] of spans) {
		if (index >= start && index < end) {
			return true;
		}
	}
	return false;
}

/**
 * All plausible times on a line, in order. A time that opens a range swallows
 * the range end, so `09:00-10:00` yields a single match.
 */
export function scanTimes(text: string, pack: LocalePack): TimeMatch[] {
	const spans = maskedSpans(text);
	const results: TimeMatch[] = [];
	let index = 0;
	while (index < text.length) {
		const next = text.slice(index).search(/\d/u);
		if (next < 0) {
			break;
		}
		index += next;
		const predecessor = index === 0 ? undefined : text.slice(index - 1, index);
		const predecessorOk = index === 0 || WORD_EDGE_RE.test(predecessor ?? "");
		if (!predecessorOk || isRejectedPredecessor(predecessor) || inMaskedSpan(spans, index)) {
			index += 1;
			continue;
		}
		const match = readTimeAtom(text, index, pack);
		if (!match) {
			index += 1;
			continue;
		}
		const separator = RANGE_SEPARATOR.exec(text.slice(match.end));
		if (separator) {
			const rangeStart = match.end + separator[0].length;
			const rangeEndMatch = readTimeAtom(text, rangeStart, pack);
			if (rangeEndMatch) {
				match.rangeEnd = { hour: rangeEndMatch.hour, minute: rangeEndMatch.minute };
				match.end = rangeEndMatch.end;
			}
		}
		results.push(match);
		index = match.end;
	}
	return results;
}

/** Trailing tags, block ids and closing punctuation do not end a reminder line. */
const TRAILING_NOISE = /^(?:[\s.,;:!?)\]}"'”’…]|[-–—#^][\p{L}\p{N}_/-]*)*$/u;

function isAtPrefix(before: string, pack: LocalePack): boolean {
	const match = /(?:^|[\s([])([\p{L}]+|@)\s*$/u.exec(before);
	if (!match) {
		return false;
	}
	const lead = match[1] ?? "";
	return lead === "@" || pack.atWords.includes(foldWord(lead, pack.tag));
}

/** Spec §1 boundary rules: end of line, first token after the checkbox, or after `at`/`@`. */
export function classifyTimePosition(text: string, match: TimeMatch, pack: LocalePack): TimePosition {
	const before = text.slice(0, match.start);
	if (before.trim() === "") {
		return "start-of-line";
	}
	if (isAtPrefix(before, pack)) {
		return "at-prefix";
	}
	if (TRAILING_NOISE.test(text.slice(match.end))) {
		return "end-of-line";
	}
	return "mid-line";
}

/** Date tokens --------------------------------------------------------- */

function relativeDate(phrase: string, ctx: DateParseContext): Ymd | null {
	const words = phrase.trim().split(/\s+/);
	const attempts = [words.join(" "), words[0] ?? ""].filter((candidate) => candidate.length > 0);
	let kind: RelativeDay | undefined;
	for (const attempt of attempts) {
		kind = ctx.pack.relative[foldWord(attempt, ctx.pack.tag)] ?? ctx.pack.relative[attempt.toLowerCase()];
		if (kind) {
			break;
		}
	}
	if (!kind) {
		return null;
	}
	const shift = kind === "tomorrow" ? 1 : kind === "yesterday" ? -1 : 0;
	const base = new Date(Date.UTC(ctx.today.y, ctx.today.m - 1, ctx.today.d + shift));
	return { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() };
}

function monthFromWord(word: string, ctx: DateParseContext): number | null {
	const key = foldWord(word.replace(/\./g, ""), ctx.pack.tag);
	return ctx.pack.months[key] ?? null;
}

function buildDate(year: number | undefined, month: number, day: number, ctx: DateParseContext): Ymd | null {
	const candidate: Ymd = { y: year ?? ctx.defaultYear, m: month, d: day };
	return isValidYmd(candidate) ? candidate : null;
}

/** Day-first first, month-first only when day-first cannot be a date (spec §1 grammar). */
function numericTriple(a: number, b: number, year: number, ctx: DateParseContext): Ymd | null {
	const dayFirst = buildDate(year, b, a, ctx);
	if (dayFirst) {
		return dayFirst;
	}
	return buildDate(year, a, b, ctx);
}

const RELATIVE_PHRASE = new RegExp(`(^|${WORD_EDGE})([\\p{L}]+(?:\\s+[\\p{L}]+)?)`, "gu");

/** First valid date token anywhere in `text`. */
export function findDateToken(text: string, ctx: DateParseContext): DateToken | null {
	const spans = maskedSpans(text);
	const candidates: DateToken[] = [];
	const consider = (start: number, end: number, ymd: Ymd | null): void => {
		if (!ymd || inMaskedSpan(spans, start)) {
			return;
		}
		candidates.push({ ymd, start, end });
	};

	const patterns: RegExp[] = [
		new RegExp(`(^|${WORD_EDGE})(\\d{4})-(\\d{1,2})-(\\d{1,2})(?!\\d)`, "gu"),
		new RegExp(`(^|${WORD_EDGE})(\\d{4})(\\d{2})(\\d{2})(?!\\d)`, "gu"),
		new RegExp(`(^|${WORD_EDGE})(\\d{1,2})[.\\-/](\\d{1,2})[.\\-/](\\d{4})(?!\\d)`, "gu"),
	];
	for (const pattern of patterns) {
		for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
			const lead = match[1] ?? "";
			const start = match.index + lead.length;
			const end = match.index + match[0].length;
			const a = Number(match[2]);
			const b = Number(match[3]);
			const c = Number(match[4]);
			const ymd = pattern === patterns[0] ? buildDate(a, b, c, ctx) : pattern === patterns[1] ? buildDate(a, b, c, ctx) : numericTriple(a, b, c, ctx);
			consider(start, end, ymd);
		}
	}

	const dayMonthYear = new RegExp(`(^|${WORD_EDGE})(\\d{1,2})\\s+([\\p{L}]{3,})\\.?\\s*,?\\s*(\\d{4})?(?!\\d)`, "gu");
	for (let match = dayMonthYear.exec(text); match; match = dayMonthYear.exec(text)) {
		const lead = match[1] ?? "";
		const month = monthFromWord(match[3] ?? "", ctx);
		const year = match[4] === undefined ? undefined : Number(match[4]);
		const start = match.index + lead.length;
		consider(start, match.index + match[0].trimEnd().length, month === null ? null : buildDate(year, month, Number(match[2]), ctx));
	}

	const monthDayYear = new RegExp(`(^|${WORD_EDGE})([\\p{L}]{3,})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})?(?!\\d)`, "gu");
	for (let match = monthDayYear.exec(text); match; match = monthDayYear.exec(text)) {
		const lead = match[1] ?? "";
		const month = monthFromWord(match[2] ?? "", ctx);
		const year = match[4] === undefined ? undefined : Number(match[4]);
		const start = match.index + lead.length;
		consider(start, match.index + match[0].trimEnd().length, month === null ? null : buildDate(year, month, Number(match[3]), ctx));
	}

	for (let match = RELATIVE_PHRASE.exec(text); match; match = RELATIVE_PHRASE.exec(text)) {
		const lead = match[1] ?? "";
		const phrase = match[2] ?? "";
		const start = match.index + lead.length;
		const ymd = relativeDate(phrase, ctx);
		if (ymd) {
			consider(start, start + phrase.length, ymd);
		}
	}

	if (candidates.length === 0) {
		return null;
	}
	const first = candidates.reduce((best, item) => (item.start < best.start ? item : best));
	return first;
}

/** Strict parse: the whole string (minus a weekday prefix and punctuation) must be a date. */
export function parseDateExpression(text: string, ctx: DateParseContext): Ymd | null {
	const trimmed = text.trim().replace(/^[#>*\-\s]+/u, "").replace(/[\s.,;:]+$/u, "");
	const direct = parseCoveringDate(trimmed, ctx);
	if (direct) {
		return direct;
	}
	// `# Fri, Sep 11`, `Friday 2026-09-11`: a weekday name may lead the date.
	const parts = trimmed.split(/\s+/);
	const head = foldWord((parts[0] ?? "").replace(/[.,]/g, ""), ctx.pack.tag);
	if (parts.length > 1 && ctx.pack.weekdays[head] !== undefined) {
		return parseCoveringDate(parts.slice(1).join(" "), ctx);
	}
	return null;
}

function parseCoveringDate(text: string, ctx: DateParseContext): Ymd | null {
	const token = findDateToken(text, ctx);
	if (!token) {
		return null;
	}
	const covered = text.slice(token.start, token.end).trim();
	const remainder = text.slice(0, token.start) + text.slice(token.end);
	return covered.length > 0 && remainder.trim() === "" ? token.ymd : null;
}

/** Explicit and interop forms ------------------------------------------ */

const EMOJI_MARKERS = ["⏰", "📅", "⏳", "🛫", "🔁", "➕", "✅"];

function firstTime(text: string, pack: LocalePack): { time: Hm; start: number; end: number } | null {
	const match = scanTimes(text, pack)[0];
	if (!match) {
		return null;
	}
	return { time: { hour: match.hour, minute: match.minute }, start: match.start, end: match.end };
}

function emojiFields(text: string): Array<{ marker: string; start: number; end: number; body: string }> {
	const fields: Array<{ marker: string; start: number; end: number; body: string }> = [];
	const positions: Array<{ marker: string; index: number }> = [];
	for (const marker of EMOJI_MARKERS) {
		let index = text.indexOf(marker);
		while (index >= 0) {
			positions.push({ marker, index });
			index = text.indexOf(marker, index + marker.length);
		}
	}
	positions.sort((a, b) => a.index - b.index);
	positions.forEach((position, order) => {
		const next = positions[order + 1];
		const end = next ? next.index : text.length;
		fields.push({
			marker: position.marker,
			start: position.index,
			end,
			body: text.slice(position.index + position.marker.length, end),
		});
	});
	return fields;
}

/**
 * Explicit date/time forms, in the precedence order of spec §4:
 * `⏰` > `📅` > `⏳` > `🛫`, then the Reminder plugin's own forms, then Kanban.
 */
export function findExplicitReminder(text: string, ctx: DateParseContext): ExplicitMatch | null {
	const fields = emojiFields(text);
	for (const marker of ["⏰", "📅", "⏳", "🛫"]) {
		const field = fields.find((candidate) => candidate.marker === marker);
		if (!field) {
			continue;
		}
		const date = findDateToken(field.body, ctx);
		const time = firstTime(field.body, ctx.pack);
		if (!date && !time) {
			continue;
		}
		const bodyStart = field.end - field.body.length;
		const tokenEnd = Math.max(date ? date.end : 0, time ? time.end : 0);
		return {
			syntax: marker === "⏰" ? "emoji-token" : "tasks-due",
			ymd: date ? date.ymd : null,
			time: time ? time.time : null,
			start: field.start,
			end: bodyStart + tokenEnd,
		};
	}

	const reminderParen = /\(@\s*([^)]*)\)/u.exec(text);
	if (reminderParen) {
		const body = reminderParen[1] ?? "";
		const date = findDateToken(body, ctx);
		const time = firstTime(body, ctx.pack);
		if (date || time) {
			return {
				syntax: "reminder-paren",
				ymd: date ? date.ymd : null,
				time: time ? time.time : null,
				start: reminderParen.index,
				end: reminderParen.index + reminderParen[0].length,
			};
		}
	}

	const dataview = /\[reminder::\s*([^\]]*)\]/iu.exec(text);
	if (dataview) {
		const body = dataview[1] ?? "";
		const date = findDateToken(body, ctx);
		const time = firstTime(body, ctx.pack);
		if (date || time) {
			return {
				syntax: "reminder-paren",
				ymd: date ? date.ymd : null,
				time: time ? time.time : null,
				start: dataview.index,
				end: dataview.index + dataview[0].length,
			};
		}
	}

	const kanban = /@\{([^}]*)\}/u.exec(text);
	if (kanban) {
		const date = findDateToken(kanban[1] ?? "", ctx);
		if (date) {
			return {
				syntax: "tasks-due",
				ymd: date.ymd,
				time: null,
				start: kanban.index,
				end: kanban.index + kanban[0].length,
			};
		}
	}

	const atPrefix = /(?:^|\s)@\s*(?!\{|\()([^\n]*)$/u.exec(text);
	if (atPrefix) {
		const body = atPrefix[1] ?? "";
		const date = findDateToken(body, ctx);
		if (date) {
			const time = firstTime(body, ctx.pack);
			const bodyStart = atPrefix.index + atPrefix[0].length - body.length;
			return {
				syntax: "explicit-at",
				ymd: date.ymd,
				time: time ? time.time : null,
				start: atPrefix.index,
				end: bodyStart + Math.max(date.end, time ? time.end : 0),
			};
		}
	}

	return null;
}

/** Formatting helpers -------------------------------------------------- */

export function formatHm(time: Hm): string {
	return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

export function parseHm(text: string): Hm | null {
	const match = /^(\d{1,2}):(\d{2})$/u.exec(text.trim());
	if (!match) {
		return null;
	}
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour > 23 || minute > 59) {
		return null;
	}
	return { hour, minute };
}
