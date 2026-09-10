/**
 * Locale packs: hand-written dictionaries, no dependency.
 *
 * A pack is data only. Adding a language is a data PR plus a fixture test
 * against the same cases the `en` pack covers.
 */

import { en } from "./en";
import { tr } from "./tr";

export type RelativeDay = "today" | "tomorrow" | "yesterday" | "tonight";

export interface LocalePack {
	tag: string;
	/** Lower-cased relative words, including multi-word phrases such as "bu gece". */
	relative: Record<string, RelativeDay>;
	/** Lower-cased weekday names and abbreviations, 0 = Sunday. */
	weekdays: Record<string, number>;
	/** Lower-cased month names and abbreviations, 1 = January. */
	months: Record<string, number>;
	meridiem: { am: string[]; pm: string[] };
	/** Words that introduce a time, e.g. "at" / "saat". */
	atWords: string[];
}

export const DEFAULT_LOCALE_TAG = "en";

const packs: Record<string, LocalePack> = { en, tr };

/** Ships packs are keyed by their primary subtag, so "tr-TR" finds "tr". */
export function getLocalePack(tag: string): LocalePack {
	const primary = tag.split(/[-_]/)[0]?.toLowerCase() ?? DEFAULT_LOCALE_TAG;
	return packs[primary] ?? en;
}

export function listLocaleTags(): string[] {
	return Object.keys(packs).sort();
}

/**
 * Lower-cases a word the way the pack's language does.
 * Turkish needs this: "I" folds to "ı" and "İ" folds to "i".
 */
export function foldWord(word: string, tag: string): string {
	try {
		return word.toLocaleLowerCase(tag);
	} catch {
		return word.toLowerCase();
	}
}
