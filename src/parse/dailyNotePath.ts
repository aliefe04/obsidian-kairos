/**
 * Daily-note path from the configured folder and format (docs/spec/syntax.md §2).
 *
 * The inverse of the format matcher in `noteDate.ts`: the same token set read
 * the other way round, so a reminder added from the command palette lands in the
 * note the index will read back.
 */

import { weekdayOf, type Ymd } from "./timeTokens";
import type { LocalePack } from "./locales/index";

/** Longest first, so `MMMM` wins over `MM` and `dddd` over `dd`. */
const TOKEN_ORDER = ["YYYY", "MMMM", "MMM", "dddd", "YY", "MM", "DD", "ddd", "dd", "M", "D"] as const;

const TOKEN_PATTERN = new RegExp(`^(${TOKEN_ORDER.join("|")})`, "u");

export const DEFAULT_DAILY_NOTE_FORMAT = "YYYY-MM-DD";

function pad(value: number, width = 2): string {
	return String(value).padStart(width, "0");
}

/** Long form = the longest key for that number; short form = the 3-letter key. */
function nameFor(table: Record<string, number>, value: number, form: "long" | "short"): string | null {
	let longest: string | null = null;
	for (const [name, number] of Object.entries(table)) {
		if (number !== value) {
			continue;
		}
		if (form === "short" && name.length === 3) {
			return name;
		}
		if (longest === null || name.length > longest.length) {
			longest = name;
		}
	}
	return longest;
}

function renderToken(token: string, date: Ymd, pack: LocalePack): string {
	switch (token) {
		case "YYYY":
			return pad(date.y, 4);
		case "YY":
			return pad(date.y % 100);
		case "MMMM":
			return nameFor(pack.months, date.m, "long") ?? pad(date.m);
		case "MMM":
			return nameFor(pack.months, date.m, "short") ?? pad(date.m);
		case "MM":
			return pad(date.m);
		case "M":
			return String(date.m);
		case "DD":
			return pad(date.d);
		case "D":
			return String(date.d);
		case "dddd":
			return nameFor(pack.weekdays, weekdayOf(date), "long") ?? "";
		// The packs carry no two-letter weekday names, so `ddd` and `dd` render the
		// same three-letter form rather than dropping the day from the path.
		case "ddd":
		case "dd":
			return nameFor(pack.weekdays, weekdayOf(date), "short") ?? "";
		default:
			return "";
	}
}

/** Renders a moment-style format against a calendar date, e.g. `YYYY/DD-MM-YYYY-dddd`. */
export function formatDailyNoteName(format: string, date: Ymd, pack: LocalePack): string {
	const source = format.trim().length > 0 ? format.trim() : DEFAULT_DAILY_NOTE_FORMAT;
	let index = 0;
	let out = "";
	while (index < source.length) {
		const token = TOKEN_PATTERN.exec(source.slice(index));
		if (token) {
			out += renderToken(token[1] ?? "", date, pack);
			index += token[0].length;
			continue;
		}
		out += source[index] ?? "";
		index += 1;
	}
	return out;
}

/** Vault-relative path of the daily note for `date`, `.md` included. */
export function dailyNotePath(folder: string, format: string, date: Ymd, pack: LocalePack): string {
	const name = formatDailyNoteName(format, date, pack);
	const file = name.endsWith(".md") ? name : `${name}.md`;
	const clean = folder.trim().replace(/^\/+|\/+$/gu, "");
	return clean.length === 0 ? file : `${clean}/${file}`;
}
