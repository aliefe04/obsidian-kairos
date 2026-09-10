/**
 * Date-source cascade (docs/spec/syntax.md §2).
 *
 * Ambiguity is resolved by corroboration, never guessed: a numeric day-first
 * versus month-first date is only accepted when the path shape, the configured
 * daily-notes format or a weekday name settles the order.
 */

import type { DateParseContext, Ymd } from "./timeTokens";
import { isValidYmd, parseDateExpression, weekdayOf } from "./timeTokens";
import { foldWord, type LocalePack } from "./locales/index";

export type DateSourceName = "frontmatter" | "h1" | "heading" | "filename" | "daily-notes";

export interface NoteHeading {
	line: number;
	level: number;
	text: string;
}

export interface NoteDateInput {
	fileName: string;
	folderPath: string;
	frontmatter: Record<string, unknown> | null;
	headings: NoteHeading[];
	itemLine: number;
	formats: string[];
	dailyNotesFolder: string;
	toggles: { frontmatter: boolean; heading: boolean; filename: boolean; dailyNotesFolder: boolean };
	ctx: DateParseContext;
}

export type NoteDateResolution =
	| { ok: true; ymd: Ymd; source: DateSourceName }
	| { ok: false; reason: "no-date" | "ambiguous" | "invalid" };

export interface FormatMatch {
	ymd: Ymd;
	/** The other reading of the same digits, when the shape allows both. */
	alternative: Ymd | null;
	/** Order declared by the configured format itself. */
	order: "day-first" | "month-first";
	/** The matched text can only be read one way (ISO, `YYYYMMDD`, weekday present). */
	shapePinned: boolean;
	weekday: number | null;
}

const TOKEN_PATTERN: Record<string, string> = {
	YYYY: "(\\d{4})",
	YY: "(\\d{2})",
	MMMM: "([\\p{L}]{3,})",
	MMM: "([\\p{L}]{3})",
	MM: "(\\d{2})",
	M: "(\\d{1,2})",
	DD: "(\\d{2})",
	D: "(\\d{1,2})",
	dddd: "([\\p{L}]{3,})",
	ddd: "([\\p{L}]{3})",
	dd: "([\\p{L}]{2})",
};

/** Longest first: `MMMM` must win over `MM`, `dddd` over `dd`. */
const TOKEN_ORDER = ["YYYY", "MMMM", "dddd", "YY", "MM", "DD", "ddd", "dd", "M", "D"];

function buildFormatRegex(format: string): { regex: RegExp; tokens: string[] } | null {
	const tokens: string[] = [];
	let pattern = "^";
	let index = 0;
	while (index < format.length) {
		const rest = format.slice(index);
		const token = TOKEN_ORDER.find((candidate) => rest.startsWith(candidate));
		if (token) {
			const body = TOKEN_PATTERN[token];
			if (body === undefined) {
				return null;
			}
			tokens.push(token);
			pattern += body;
			index += token.length;
			continue;
		}
		const char = format[index];
		if (char === undefined) {
			break;
		}
		if (/[\p{L}\p{N}]/u.test(char)) {
			pattern += char.replace(/[.*+?^${}()|[\]\\\\]/gu, "\\\\$&");
		} else {
			pattern += "[-_. /]";
		}
		index += 1;
	}
	try {
		return { regex: new RegExp(`${pattern}$`, "iu"), tokens };
	} catch {
		return null;
	}
}

function monthFromName(word: string, pack: LocalePack): number | null {
	return pack.months[foldWord(word.replace(/\./gu, ""), pack.tag)] ?? null;
}

/** Matches one configured format against a file name or a vault-relative path. */
export function matchFormat(text: string, format: string, pack: LocalePack): FormatMatch | null {
	const built = buildFormatRegex(format);
	if (!built) {
		return null;
	}
	const match = built.regex.exec(text);
	if (!match) {
		return null;
	}
	let year: number | null = null;
	let month: number | null = null;
	let day: number | null = null;
	let weekday: number | null = null;
	let monthIndex = -1;
	let dayIndex = -1;
	built.tokens.forEach((token, position) => {
		const raw = match[position + 1] ?? "";
		if (token === "YYYY" || token === "YY") {
			year = token === "YY" ? 2000 + Number(raw) : Number(raw);
			return;
		}
		if (token === "MMMM" || token === "MM" || token === "MMM") {
			const value = /^\d+$/u.test(raw) ? Number(raw) : monthFromName(raw, pack);
			if (value !== null && value >= 1 && value <= 12) {
				month = value;
				monthIndex = position;
			}
			return;
		}
		if (token === "DD" || token === "D") {
			day = Number(raw);
			dayIndex = position;
			return;
		}
		const named = pack.weekdays[foldWord(raw, pack.tag)];
		if (named !== undefined) {
			weekday = named;
		}
	});
	if (year === null || month === null || day === null || monthIndex < 0 || dayIndex < 0) {
		return null;
	}
	const order: "day-first" | "month-first" = dayIndex < monthIndex ? "day-first" : "month-first";
	const primary: Ymd = { y: year, m: month, d: day };
	const swapped: Ymd = { y: year, m: day, d: month };
	const alternative = isValidYmd(swapped) && (swapped.m !== primary.m || swapped.d !== primary.d) ? swapped : null;
	const shapePinned = /^\d{4}/u.test(match[0]) || /^\d{8}$/u.test(match[0]) || weekday !== null;
	if (!isValidYmd(primary)) {
		if (!alternative) {
			return null;
		}
		return {
			ymd: alternative,
			alternative: primary,
			order: order === "day-first" ? "month-first" : "day-first",
			shapePinned,
			weekday,
		};
	}
	return { ymd: primary, alternative, order, shapePinned, weekday };
}

function earliestFormatMatch(text: string, formats: string[], pack: LocalePack): FormatMatch | null {
	for (const format of formats) {
		const match = matchFormat(text, format, pack);
		if (match) {
			return match;
		}
	}
	return null;
}

function folderCorroborates(candidate: Ymd, folders: string[], pack: LocalePack): boolean {
	for (const folder of folders) {
		if (folder === String(candidate.m).padStart(2, "0") || folder === String(candidate.m)) {
			return true;
		}
		if (monthFromName(folder, pack) === candidate.m) {
			return true;
		}
	}
	return false;
}

function weekdayCorroborates(candidate: Ymd, weekday: number | null): boolean {
	return weekday !== null && weekdayOf(candidate) === weekday;
}

/** Accept only when the order is settled; otherwise the note stays unresolved. */
function accept(match: FormatMatch, folders: string[], pack: LocalePack, source: DateSourceName): NoteDateResolution {
	const alternative = match.alternative;
	if (alternative === null || match.shapePinned) {
		return { ok: true, ymd: match.ymd, source };
	}
	if (weekdayCorroborates(match.ymd, match.weekday) && !weekdayCorroborates(alternative, match.weekday)) {
		return { ok: true, ymd: match.ymd, source };
	}
	if (folderCorroborates(match.ymd, folders, pack) && !folderCorroborates(alternative, folders, pack)) {
		return { ok: true, ymd: match.ymd, source };
	}
	return { ok: false, reason: "ambiguous" };
}

function parseDateValue(value: string, ctx: DateParseContext): Ymd | null {
	const cleaned = value.trim().replace(/^['"]|['"]$/gu, "");
	if (cleaned.length === 0) {
		return null;
	}
	const iso = /^(\d{4})-(\d{2})-(\d{2})/u.exec(cleaned);
	if (iso) {
		const candidate: Ymd = { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
		return isValidYmd(candidate) ? candidate : null;
	}
	return parseDateExpression(cleaned, ctx);
}

function frontmatterDate(frontmatter: Record<string, unknown>, ctx: DateParseContext): Ymd | null {
	for (const key of ["date", "day", "created", "journal-date"]) {
		const value = frontmatter[key];
		if (typeof value === "string") {
			const parsed = parseDateValue(value, ctx);
			if (parsed) {
				return parsed;
			}
		}
		if (value instanceof Date) {
			return { y: value.getFullYear(), m: value.getMonth() + 1, d: value.getDate() };
		}
	}
	return null;
}

export function resolveNoteDate(input: NoteDateInput): NoteDateResolution {
	const { ctx, toggles } = input;
	const folders = input.folderPath
		.split("/")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (toggles.frontmatter && input.frontmatter) {
		const fromFrontmatter = frontmatterDate(input.frontmatter, ctx);
		if (fromFrontmatter) {
			return { ok: true, ymd: fromFrontmatter, source: "frontmatter" };
		}
	}
	if (toggles.heading) {
		const first = input.headings.find((heading) => heading.level === 1);
		const parsed = first ? parseDateValue(first.text, ctx) : null;
		if (parsed) {
			return { ok: true, ymd: parsed, source: "h1" };
		}
		const preceding = [...input.headings]
			.filter((heading) => heading.line < input.itemLine)
			.sort((a, b) => b.line - a.line)
			.map((heading) => parseDateValue(heading.text, ctx))
			.find((value): value is Ymd => value !== null);
		if (preceding) {
			return { ok: true, ymd: preceding, source: "heading" };
		}
	}
	if (toggles.dailyNotesFolder) {
		const folder = input.dailyNotesFolder.trim().replace(/^\/+|\/+$/gu, "");
		const inside = folder.length === 0 || input.folderPath === folder || input.folderPath.startsWith(`${folder}/`);
		if (inside) {
			const relativeFolder = folder.length === 0 ? input.folderPath : input.folderPath.slice(folder.length).replace(/^\/+|\/+$/gu, "");
			const relativePath = relativeFolder.length === 0 ? input.fileName : `${relativeFolder}/${input.fileName}`;
			const match = earliestFormatMatch(relativePath, input.formats, ctx.pack);
			if (match) {
				const accepted = accept(match, folders, ctx.pack, "daily-notes");
				if (accepted.ok) {
					return accepted;
				}
			}
		}
	}
	if (toggles.filename) {
		const match = earliestFormatMatch(input.fileName, input.formats, ctx.pack);
		if (match) {
			const accepted = accept(match, folders, ctx.pack, "filename");
			return accepted.ok ? accepted : { ok: false, reason: "ambiguous" };
		}
		const fromFolder = folders.map((folder) => parseDateValue(folder, ctx)).find((value): value is Ymd => value !== null);
		if (fromFolder) {
			return { ok: true, ymd: fromFolder, source: "filename" };
		}
	}
	return { ok: false, reason: "no-date" };
}
