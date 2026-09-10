import { describe, expect, it } from "vitest";
import { getLocalePack } from "../src/parse/locales/index";
import { classifyTimePosition, formatHm, scanTimes, type TimeMatch, type TimePosition } from "../src/parse/timeTokens";

const pack = getLocalePack("en");

function onlyMatch(text: string): TimeMatch {
	const match = scanTimes(text, pack)[0];
	if (!match) {
		throw new Error(`no time token found in ${JSON.stringify(text)}`);
	}
	return match;
}

function positionOf(text: string): TimePosition {
	const match = onlyMatch(text);
	return classifyTimePosition(text, match, pack);
}

describe("scanTimes", () => {
	const forms: Array<[string, string]> = [
		["9:00", "09:00"],
		["09:00", "09:00"],
		["9:00am", "09:00"],
		["09:00 PM", "21:00"],
		["9.30", "09:30"],
		["9am", "09:00"],
		["12:00am", "00:00"],
		["12:00pm", "12:00"],
	];

	for (const [written, expected] of forms) {
		it(`reads ${written} as ${expected}`, () => {
			const match = onlyMatch(`call the dentist ${written}`);
			expect(formatHm(match)).toBe(expected);
		});
	}

	it("keeps a time range whole and reports its end", () => {
		for (const written of ["standup 09:00-10:00", "standup 09:00 – 10:00", "standup 09:00 to 10:00"]) {
			const matches = scanTimes(written, pack);
			expect(matches).toHaveLength(1);
			expect(formatHm(onlyMatch(written))).toBe("09:00");
			expect(matches[0]?.rangeEnd).toEqual({ hour: 10, minute: 0 });
		}
	});

	it("finds both times when a line carries two", () => {
		const matches = scanTimes("09:00 standup 17:00", pack);
		expect(matches.map((match) => formatHm(match))).toEqual(["09:00", "17:00"]);
		expect(classifyTimePosition("09:00 standup 17:00", matches[0]!, pack)).toBe("start-of-line");
		expect(classifyTimePosition("09:00 standup 17:00", matches[1]!, pack)).toBe("end-of-line");
	});

	it("refuses a time inside a URL or an inline code span", () => {
		expect(scanTimes("see https://x/9:00 for the agenda", pack)).toEqual([]);
		expect(scanTimes("run `9:00` before the standup", pack)).toEqual([]);
	});

	it("refuses an hour that cannot exist", () => {
		expect(scanTimes("meet at 24:00", pack)).toEqual([]);
		expect(scanTimes("meet at 09:75", pack)).toEqual([]);
		expect(scanTimes("meet at 13:00 PM", pack)).toEqual([]);
	});
});

describe("classifyTimePosition", () => {
	it("accepts the end of a line, past a trailing tag or block id", () => {
		expect(positionOf("msg to dentist 09:00")).toBe("end-of-line");
		expect(positionOf("msg to dentist 09:00 #health")).toBe("end-of-line");
		expect(positionOf("msg to dentist 09:00 ^dentist-2026")).toBe("end-of-line");
		expect(positionOf("msg to dentist 09:00.")).toBe("end-of-line");
	});

	it("accepts the first token of a line", () => {
		expect(positionOf("09:00 standup with the team")).toBe("start-of-line");
	});

	it("accepts a time introduced by `at` or `@`", () => {
		expect(positionOf("call the bank at 09:00")).toBe("at-prefix");
		expect(positionOf("call the bank @ 09:00")).toBe("at-prefix");
		expect(positionOf("make an appointment (@ 09:00)")).toBe("at-prefix");
	});

	it("ignores a time in the middle of prose", () => {
		expect(positionOf("discuss whether 09:00 works for the call")).toBe("mid-line");
		expect(positionOf("move the 09:00 meeting")).toBe("mid-line");
	});
});
