/**
 * The iCalendar primitives the calendar file is written with (RFC 5545).
 *
 * One implementation of the format, so the escaping and folding rules cannot drift
 * apart from themselves — the exact drift this module exists to prevent. Named
 * `ical` rather than `ics` because the channel that owns the file is a caller of
 * this module, not the format.
 */

/** Escapes a text value: backslash, semicolon, comma, newline (§3.3.11). */
export function escapeIcsText(text: string): string {
	return text
		.replace(/\\/gu, "\\\\")
		.replace(/;/gu, "\\;")
		.replace(/,/gu, "\\,")
		.replace(/\r?\n/gu, "\\n");
}

function utf8Length(text: string): number {
	return new TextEncoder().encode(text).length;
}

/**
 * Folds a content line to 75 octets, continuing with a leading space (§3.1).
 *
 * Octets, not characters: a Turkish title is full of two-byte letters, and a
 * client that counts octets would otherwise cut one in half. The continuation
 * space is reserved out of the count, so every returned piece is within the limit
 * as written. A surrogate pair (an emoji title) is kept whole.
 */
export function foldLine(line: string): string[] {
	if (utf8Length(line) <= 75) {
		return [line];
	}
	const pieces: string[] = [];
	let current = "";
	let length = 0;
	for (const char of line) {
		const size = utf8Length(char);
		if (length + size > 75) {
			pieces.push(current);
			current = char;
			length = 1 + size;
			continue;
		}
		current += char;
		length += size;
	}
	if (current.length > 0) {
		pieces.push(current);
	}
	return pieces.map((piece, index) => (index === 0 ? piece : ` ${piece}`));
}

/** A whole content line, escaped and folded. */
export function icsText(value: string): string {
	return foldLine(escapeIcsText(value)).join("\r\n");
}

/**
 * `YYYYMMDDTHHMMSSZ` for an instant.
 *
 * UTC rather than a local time with a `TZID`: the phone, the Mac and the server
 * can each hold a different zone, and an absolute instant cannot be reinterpreted
 * by any of them.
 */
export function icalUtc(epochMs: number): string {
	const date = new Date(epochMs);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}
