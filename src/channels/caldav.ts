/**
 * Push channel: a CalDAV collection of tasks (docs/recipes/caldav-reminders.md).
 *
 * This is the only path into an iPhone's Reminders app that needs no Mac and no
 * native app: iCloud's own CalDAV does not carry Reminders (2Do: "Reminders does
 * not read or write CalDAV task lists"), but a third-party CalDAV account does
 * surface its lists there (Nextcloud Tasks lists "Apple Reminders (iOS, MacOS)";
 * iOS: Settings → Reminders → Reminders Accounts → Add Account → Other → Add
 * CalDAV Account, with Reminders ticked). Whatever the account holds shows up as
 * a list, and a task with an alarm fires the phone's own alert with Kairos closed.
 *
 * Each reminder is one `VTODO`, and its identity is *derived*, not minted:
 * `kairos-<instanceId>` names the resource. Two things follow. Re-registering the
 * same instance rewrites the same resource, so a pass that could not tell whether
 * its predecessor landed cannot leave two tasks behind. And a registration can be
 * withdrawn from the instance id alone, which is what makes an untracked one still
 * removable.
 *
 * An *edited* due time is not this case: the instance id is derived from the due
 * time as well as the line, so a new time is a new instance. The engine withdraws
 * the old entry by its stored id and registers the new one, which is why the
 * derived name has to make both operations exact rather than approximate.
 *
 * The alarm is an absolute `VALARM` trigger at the due instant. Whether iOS
 * honours a `VALARM` inside a `VTODO` is *not* verified here — no one involved can
 * measure it from outside an iPhone — and that is the one link in this chain that
 * a device has to confirm (docs/risks.md, R15).
 */

import type { KairosSettings } from "../settings";
import { describeError, type ChannelContext, type DeliveryChannel, type DeliveryResult, type OutboundMessage } from "./types";
import { requestUrlTransport, type HttpRequest } from "./http";
import { escapeIcsText, foldLine, icalUtc } from "./ical";

/** The UID of an instance's task. Derived, so it survives a lost state file. */
export function caldavUid(instanceId: string): string {
	return `kairos-${instanceId}`;
}

/** The collection's URL, normalised to end in exactly one slash; empty stays empty. */
export function caldavCollectionUrl(settings: KairosSettings): string {
	const url = settings.caldavUrl.trim().replace(/\/+$/u, "");
	return url.length === 0 ? "" : `${url}/`;
}

/** The absolute URL of an instance's task, recomputable from the collection alone. */
export function caldavTaskUrl(settings: KairosSettings, instanceId: string): string {
	const collection = caldavCollectionUrl(settings);
	return collection.length > 0 ? `${collection}${encodeURIComponent(`${caldavUid(instanceId)}.ics`)}` : "";
}

function configured(settings: KairosSettings): boolean {
	return settings.caldavEnabled && settings.caldavUrl.trim().length > 0;
}

/**
 * Basic credentials, UTF-8 safe. `btoa` alone throws on any character above
 * U+00FF, and an app password is not guaranteed to be ASCII.
 */
function basicAuth(user: string, password: string): string {
	const bytes = new TextEncoder().encode(`${user}:${password}`);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return `Basic ${btoa(binary)}`;
}

function authHeaders(settings: KairosSettings): Record<string, string> {
	const user = settings.caldavUser.trim();
	return user.length > 0 ? { Authorization: basicAuth(user, settings.caldavPassword) } : {};
}

export interface VtodoOptions {
	/** Include the note name in the description, as the other channels do. */
	includeNoteName: boolean;
	/**
	 * The instant the task is being written. `DTSTAMP` and `LAST-MODIFIED` are
	 * creation and modification times (RFC 5545 §3.8.7), not the due time: stamping
	 * them with a due date two months out would tell every CalDAV client the task
	 * was last modified in the future, which is what they compare to decide whose
	 * copy is newer.
	 */
	now: number;
}

/**
 * The task body. `DUE` carries the exact instant and the `VALARM` an absolute
 * trigger for it, because a Reminders entry is only an alarm if it has one; the
 * `STATUS` is what lets a completed task be recognised as such if it is ever
 * written the other way round.
 */
export function buildVtodo(message: OutboundMessage, options: VtodoOptions): string {
	const uid = caldavUid(message.instanceId);
	const due = icalUtc(message.dueEpochMs);
	const written = icalUtc(options.now);
	const description = options.includeNoteName && message.noteName ? message.noteName : message.title;
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Kairos//Obsidian plugin//EN",
		"CALSCALE:GREGORIAN",
		"BEGIN:VTODO",
		`UID:${uid}`,
		`DTSTAMP:${written}`,
		`LAST-MODIFIED:${written}`,
		`DUE:${due}`,
		`SUMMARY:${escapeIcsText(message.title)}`,
		`DESCRIPTION:${escapeIcsText(description)}`,
		"STATUS:NEEDS-ACTION",
		"BEGIN:VALARM",
		"ACTION:DISPLAY",
		`DESCRIPTION:${escapeIcsText(message.title)}`,
		`TRIGGER;VALUE=DATE-TIME:${due}`,
		"END:VALARM",
		"END:VTODO",
		"END:VCALENDAR",
	];
	// CRLF between lines and a trailing one: the format requires it, and a server
	// that stores what it is given would otherwise hand clients a file with no
	// final newline.
	return `${lines.flatMap((line) => foldLine(line)).join("\r\n")}\r\n`;
}

/**
 * A `MKCALENDAR` body declaring a tasks calendar.
 *
 * Radicale answers a `PUT` into a collection that does not exist with `409`, and
 * a fresh server has no collection at all; requiring the user to create one by
 * hand first would put a setup step between writing a reminder and having it ring.
 * Declaring the component set keeps the collection a tasks list rather than one
 * that Reminders would show for events.
 */
export function buildMkcalendar(displayName: string): string {
	return [
		'<?xml version="1.0" encoding="utf-8" ?>',
		'<mkcalendar xmlns="urn:ietf:params:xml:ns:caldav">',
		"  <set>",
		"    <prop>",
		`      <displayname>${escapeIcsText(displayName)}</displayname>`,
		'      <supported-calendar-component-set><comp name="VTODO"/></supported-calendar-component-set>',
		"    </prop>",
		"  </set>",
		"</mkcalendar>",
	].join("\n");
}

const CALENDAR_TYPE = "text/calendar; charset=utf-8";

/**
 * Writes the task, creating the collection first when the server says it is not
 * there. One retry, never a loop: a wrong URL fails the same way twice, and that
 * failure is reported rather than hidden behind a second attempt.
 */
async function putTask(
	request: HttpRequest,
	settings: KairosSettings,
	url: string,
	body: string,
): Promise<{ status: number }> {
	const headers = { ...authHeaders(settings), "Content-Type": CALENDAR_TYPE };
	const response = await request({ url, method: "PUT", headers, body });
	if (response.status !== 409 && response.status !== 404) {
		return response;
	}
	await request({
		url: caldavCollectionUrl(settings),
		method: "MKCALENDAR",
		headers: { ...authHeaders(settings), "Content-Type": "application/xml; charset=utf-8" },
		body: buildMkcalendar("Kairos"),
	});
	return request({ url, method: "PUT", headers, body });
}

export function createCalDavChannel(dependencies: { request?: HttpRequest } = {}): DeliveryChannel {
	const request = dependencies.request ?? requestUrlTransport;
	return {
		id: "caldav",
		name: "CalDAV tasks",
		mode: "server-scheduled",
		isConfigured: configured,
		// A collection of its own has no delay limit — the three-day default is
		// ntfy.sh's — so a reminder months out is registered now, not when it comes
		// inside someone else's horizon.
		scheduleHorizonDays: 365,
		// A task entry is a real entry: once its due time has passed and the record
		// has stopped wanting it, it is deleted, or a list would fill with reminders
		// that fired weeks ago.
		deleteAfterDue: true,
		send: async (message: OutboundMessage, ctx: ChannelContext): Promise<DeliveryResult> => {
			if (!configured(ctx.settings)) {
				return { ok: false, detail: "caldav: no collection URL configured" };
			}
			try {
				// PUT replaces the resource at this URL, so writing the same instance
				// twice leaves one task rather than two — the property that makes a
				// retried registration harmless. A collection that does not exist yet is
				// created on the way (Radicale answers 409).
				const response = await putTask(
					request,
					ctx.settings,
					caldavTaskUrl(ctx.settings, message.instanceId),
					buildVtodo(message, { includeNoteName: ctx.settings.includeNoteName, now: ctx.now }),
				);
				if (response.status < 200 || response.status >= 300) {
					return { ok: false, detail: `caldav returned ${response.status}${response.status === 409 ? " (collection refused?)" : ""}` };
				}
				return { ok: true, detail: String(response.status), id: caldavUid(message.instanceId) };
			} catch (error) {
				return { ok: false, detail: describeError(error) };
			}
		},
		/**
		 * Deletes the task. The id is optional here and that is the point of the
		 * derived UID: a registration from before ids were stored, or one the engine
		 * never learned an id for, is still removable from the instance alone.
		 * A `404` is success — the task is not there, which is what was wanted.
		 */
		clear: async (instanceId: string, ctx: ChannelContext, pushId?: string): Promise<void> => {
			// Deliberately not gated on `isConfigured`: switching the channel off must
			// not strand the tasks it already wrote, or the user's list keeps a
			// reminder they cancelled. The stored collection URL is all that is needed.
			if (ctx.settings.caldavUrl.trim().length === 0) {
				return;
			}
			const collection = caldavCollectionUrl(ctx.settings);
			const resource = pushId === undefined ? `${caldavUid(instanceId)}.ics` : `${pushId}.ics`;
			try {
				await request({
					url: `${collection}${encodeURIComponent(resource)}`,
					method: "DELETE",
					headers: authHeaders(ctx.settings),
					body: "",
				});
			} catch {
				// A failed cancellation is not worth an alert.
			}
		},
	};
}
