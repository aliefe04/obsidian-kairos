/**
 * The CalDAV task channel: identity, escaping and the two operations.
 *
 * The property that matters most is not that a PUT happens but *where*: the
 * resource name is derived from the instance id, so an edited due time rewrites
 * one task instead of leaving the old one to fire beside the new one, and a
 * withdrawal does not need an id at all. A real round trip against a Radicale
 * container is what proves that against a server (docs/recipes/caldav-reminders.md).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { buildVtodo, caldavCollectionUrl, caldavTaskUrl, caldavUid, createCalDavChannel } from "../src/channels/caldav";
import { escapeIcsText, foldLine, icalUtc } from "../src/channels/ical";
import type { KairosSettings } from "../src/settings";
import { channelContext, outboundMessage, testSettings } from "./support";
import { requestUrlStub } from "./stubs/obsidian";

const DUE = Date.UTC(2026, 8, 11, 9, 0);
/** An hour before the due time: the instant the task is written. */
const NOW = DUE - 3600_000;
const COLLECTION = "https://cloud.example.com/remote.php/dav/calendars/me/tasks/";

function caldavSettings(overrides: Partial<KairosSettings> = {}): KairosSettings {
	return testSettings({ caldavEnabled: true, caldavUrl: COLLECTION, ...overrides });
}

beforeEach(() => {
	requestUrlStub.reset();
});

describe("task identity", () => {
	it("derives the resource from the instance, so a changed due time updates in place", () => {
		const settings = caldavSettings();
		const url = caldavTaskUrl(settings, "abc123");
		expect(url).toBe(`${COLLECTION}kairos-abc123.ics`);
		// Nothing about the due time is in the name: editing the time rewrites this
		// resource rather than creating a second task that would fire on its own.
		expect(caldavTaskUrl(settings, "abc123")).toBe(url);
		expect(caldavUid("abc123")).toBe("kairos-abc123");
	});

	it("normalises the collection, and refuses to build a task without one", () => {
		expect(caldavCollectionUrl(caldavSettings({ caldavUrl: "https://host/dav/tasks" }))).toBe("https://host/dav/tasks/");
		expect(caldavCollectionUrl(caldavSettings({ caldavUrl: "https://host/dav/tasks//" }))).toBe("https://host/dav/tasks/");
		expect(caldavTaskUrl(caldavSettings({ caldavUrl: "  " }), "abc")).toBe("");
	});
});

describe("the task body", () => {
	it("carries the due instant and an alarm for it", () => {
		const body = buildVtodo(outboundMessage(), { includeNoteName: false, now: NOW });
		expect(body).toContain("BEGIN:VTODO");
		expect(body).toContain("UID:kairos-instance-1");
		expect(body).toContain("DUE:20260911T090000Z");
		// The write instant, not the due time: a future LAST-MODIFIED would make
		// every CalDAV client treat this copy as the newest forever.
		expect(body).toContain("DTSTAMP:20260911T080000Z");
		expect(body).toContain("LAST-MODIFIED:20260911T080000Z");
		expect(body).toContain("SUMMARY:msg to dentist");
		// An entry with no alarm is just a line in a list: the phone would never
		// alert, which is the whole point of writing it.
		expect(body).toContain("BEGIN:VALARM");
		expect(body).toContain("TRIGGER;VALUE=DATE-TIME:20260911T090000Z");
		// CRLF line endings, as the format requires.
		expect(body.split("\r\n").length).toBeGreaterThan(10);
		expect(body.endsWith("\r\n")).toBe(true);
	});

	it("escapes what a title can contain, and folds a line too long for the format", () => {
		expect(escapeIcsText("a, b; c\\d\ne")).toBe("a\\, b\\; c\\\\d\\ne");
		const title = "Dişçiyi ara, sonra eczaneden ilaçları al ve anneme de uğra";
		const body = buildVtodo(outboundMessage({ title }), { includeNoteName: false, now: NOW });
		for (const line of body.split("\r\n")) {
			expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
		}
		// The folded title is still one value once unfolded.
		expect(body.replace(/\r\n /gu, "")).toContain(`SUMMARY:${escapeIcsText(title)}`);
	});

	it("keeps the note name out unless asked for it", () => {
		const withName = buildVtodo(outboundMessage(), { includeNoteName: true, now: NOW });
		expect(withName).toContain("DESCRIPTION:11-09-2026-Friday");
		const without = buildVtodo(outboundMessage(), { includeNoteName: false, now: NOW });
		expect(without).toContain("DESCRIPTION:msg to dentist");
	});

	it("folds on octet boundaries, not characters", () => {
		// Two bytes per character here: a fold that counted characters would hand a
		// server a line of 150 octets while believing it had written 75.
		const folded = foldLine(`SUMMARY:${"ü".repeat(60)}`);
		// Every physical line, continuation space included, is within the limit.
		for (const line of folded) {
			expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
		}
		expect(folded.map((line) => (line.startsWith(" ") ? line.slice(1) : line)).join("")).toBe(`SUMMARY:${"ü".repeat(60)}`);
	});

	it("formats an instant as UTC", () => {
		expect(icalUtc(DUE)).toBe("20260911T090000Z");
	});
});

describe("createCalDavChannel", () => {
	it("puts the task at its derived URL with credentials", async () => {
		const channel = createCalDavChannel();
		const settings = caldavSettings({ caldavUser: "me", caldavPassword: "app-password" });
		const result = await channel.send(outboundMessage(), channelContext(settings, DUE - 3600_000));

		expect(result.ok).toBe(true);
		// The UID is the handle a later withdrawal can recompute.
		expect(result.id).toBe("kairos-instance-1");
		const call = requestUrlStub.calls[0];
		expect(call?.method).toBe("PUT");
		expect(call?.url).toBe(`${COLLECTION}kairos-instance-1.ics`);
		expect(call?.headers?.["Content-Type"]).toBe("text/calendar; charset=utf-8");
		expect(call?.headers?.["Authorization"]).toBe("Basic bWU6YXBwLXBhc3N3b3Jk");
		expect(call?.body).toContain("BEGIN:VTODO");
	});

	it("drops a trailing line break from the password, which a copy always brings", async () => {
		// Read out of a file, or echoed by a terminal, every source of a password
		// ends the line with one, and the settings field shows nothing. Left in, it
		// answers 401 for a correct password — verified against a real server, where
		// the same credential with and without it differs by exactly that.
		const channel = createCalDavChannel();
		const settings = caldavSettings({ caldavUser: "me", caldavPassword: "app-password\n" });
		await channel.send(outboundMessage(), channelContext(settings, DUE - 3600_000));

		// The same base64 the clean password produces.
		expect(requestUrlStub.calls[0]?.headers?.["Authorization"]).toBe("Basic bWU6YXBwLXBhc3N3b3Jk");
	});

	it("does not claim delivery when the collection is missing", async () => {
		requestUrlStub.status = 404;
		const channel = createCalDavChannel();
		const result = await channel.send(outboundMessage(), channelContext(caldavSettings(), DUE - 3600_000));
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("404");
	});

	it("refuses without a collection URL rather than sending nowhere", async () => {
		const channel = createCalDavChannel();
		const result = await channel.send(outboundMessage(), channelContext(caldavSettings({ caldavUrl: "" }), DUE));
		expect(result.ok).toBe(false);
		expect(requestUrlStub.calls).toEqual([]);
	});

	it("creates the collection when the server says it is not there", async () => {
		// Radicale answers a PUT into a collection that does not exist with 409, and a
		// fresh server has none: writing a reminder has to be enough, or setup stands
		// between the user and a ringing phone. Verified against a real container.
		let put = 0;
		requestUrlStub.handler = (init) => {
			if (init.method === "PUT") {
				put += 1;
				return { status: put === 1 ? 409 : 201, text: "", json: null, arrayBuffer: new ArrayBuffer(0), headers: {} };
			}
			return { status: 201, text: "", json: null, arrayBuffer: new ArrayBuffer(0), headers: {} };
		};
		const channel = createCalDavChannel();
		const result = await channel.send(outboundMessage(), channelContext(caldavSettings(), DUE));
		expect(result.ok).toBe(true);
		const mkcalendar = requestUrlStub.calls.find((call) => call.method === "MKCALENDAR");
		expect(mkcalendar?.url).toBe(COLLECTION);
		expect(JSON.stringify(mkcalendar?.body)).toContain("VTODO");
		expect(requestUrlStub.calls.filter((call) => call.method === "PUT")).toHaveLength(2);
	});

	it("reports a collection the server keeps refusing instead of retrying forever", async () => {
		requestUrlStub.status = 409;
		const channel = createCalDavChannel();
		const result = await channel.send(outboundMessage(), channelContext(caldavSettings(), DUE));
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("409");
		expect(requestUrlStub.calls.filter((call) => call.method === "PUT")).toHaveLength(2);
	});

	it("withdraws by the derived resource when no id was stored", async () => {
		const channel = createCalDavChannel();
		await channel.clear?.("instance-1", channelContext(caldavSettings({ caldavEnabled: false }), DUE));
		const call = requestUrlStub.calls[0];
		expect(call?.method).toBe("DELETE");
		// Derived, not stored: an untracked registration is still removable. And the
		// channel being switched off is no reason to leave the task behind.
		expect(call?.url).toBe(`${COLLECTION}kairos-instance-1.ics`);
	});

	it("withdraws the id it was handed when there is one", async () => {
		const channel = createCalDavChannel();
		await channel.clear?.("instance-1", channelContext(caldavSettings(), DUE), "kairos-other");
		expect(requestUrlStub.calls[0]?.url).toBe(`${COLLECTION}kairos-other.ics`);
	});
});
