/**
 * Push channel: ntfy over HTTP (docs/spec/state-model.md §5).
 *
 * The payload is the task title only by default. Scheduling is delegated to the
 * server with `X-At`, so a closed laptop still gets the push. Cancellation
 * deletes the message id the publish returned (`DELETE /<topic>/<id>`), and it
 * is best-effort: a `200` is not proof the message was deleted. Probed against
 * `ntfy.sh` on 2026-09-11, `curl` (5 of 5) and Bun (6 of 6) cancelled, while
 * node's `fetch` (undici) cancelled 0 of 3 — a `200 message_delete` each time,
 * delivery each time. `requestUrl` is Electron/Chromium's stack, not undici
 * ([INFERENCE], ADR 12, R14).
 *
 * The publish deliberately carries no `X-Sequence-ID`: a message published with
 * one cannot be cancelled — a delete by message id and a delete by sequence id
 * both answer `200` while the push still arrives (verified 2026-09-11, ADR 12).
 */

import { describeError, type ChannelContext, type DeliveryChannel, type DeliveryResult, type OutboundMessage } from "./types";
import { requestUrlTransport, type HttpRequest, type HttpRequestInit, type HttpResponse } from "./http";
import type { KairosSettings } from "../settings";

export interface NtfyRequestOptions {
	now: number;
	includeNoteName: boolean;
}

export function topicUrl(server: string, topic: string): string {
	return `${server.replace(/\/+$/u, "")}/${encodeURIComponent(topic)}`;
}

/** ntfy refuses a schedule closer than a few seconds; ten is the floor we ship. */
export const MIN_SERVER_DELAY_SECONDS = 10;

export function buildNtfyRequest(settings: KairosSettings, message: OutboundMessage, options: NtfyRequestOptions): HttpRequestInit {
	// No `X-Sequence-ID`: a message published with one cannot be cancelled on
	// ntfy.sh — deletes by message id and by sequence id both answer `200` and
	// the push still arrives (verified 2026-09-11) — and the record's `pushFor`
	// already keeps an unchanged reminder from being published again.
	const headers: Record<string, string> = {
		"X-Title": message.title,
		"X-Priority": String(settings.ntfyPriority),
		"X-Tags": message.severity === "alarm" ? "alarm_clock" : "inbox_tray",
		"Content-Type": "text/plain; charset=utf-8",
	};
	// The server holds the push until the due time, so it survives a closed app.
	// `X-At` takes an absolute Unix timestamp or a duration carrying a unit; a bare
	// integer is neither, and sending a count of seconds answered `400 invalid delay
	// parameter`, so every registration this channel made was refused and the phone
	// never rang. An absolute time is also what the server compares against, so a
	// device clock that is a few seconds out cannot move the alert.
	const dueSeconds = Math.round(message.dueEpochMs / 1000);
	const soonest = Math.floor(options.now / 1000) + MIN_SERVER_DELAY_SECONDS;
	headers["X-At"] = String(Math.max(dueSeconds, soonest));
	if (settings.ntfyToken.trim().length > 0) {
		headers["Authorization"] = `Bearer ${settings.ntfyToken.trim()}`;
	}
	const body = options.includeNoteName && message.noteName ? `${message.title} · ${message.noteName}` : message.title;
	return { url: topicUrl(settings.ntfyServer, settings.ntfyTopic), method: "POST", headers, body };
}

/** The id ntfy assigned the message; the only handle observed to cancel a delivery (see the file header — the delete is best-effort). */
function messageIdOf(response: HttpResponse): string | undefined {
	const payload = response.json ?? bodyJson(response.text);
	if (typeof payload !== "object" || payload === null || !("id" in payload)) {
		return undefined;
	}
	const id = payload.id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function bodyJson(text: string | undefined): unknown {
	if (text === undefined || text.length === 0) {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function createNtfyChannel(dependencies: { request?: HttpRequest } = {}): DeliveryChannel {
	const request = dependencies.request ?? requestUrlTransport;
	const configured = (settings: KairosSettings): boolean =>
		settings.ntfyEnabled && settings.ntfyServer.trim().length > 0 && settings.ntfyTopic.trim().length > 0;
	return {
		id: "ntfy",
		name: "ntfy",
		mode: "server-scheduled",
		isConfigured: configured,
		send: async (message: OutboundMessage, ctx: ChannelContext): Promise<DeliveryResult> => {
			try {
				const init = buildNtfyRequest(ctx.settings, message, { now: ctx.now, includeNoteName: ctx.settings.includeNoteName });
				const response = await request(init);
				if (response.status < 200 || response.status >= 300) {
					return { ok: false, detail: `ntfy returned ${response.status}` };
				}
				// The publish response carries the id that cancels this push; an
				// empty or unparsable body still counts as delivered, just untracked.
				const id = messageIdOf(response);
				return id === undefined ? { ok: true, detail: String(response.status) } : { ok: true, detail: String(response.status), id };
			} catch (error) {
				return { ok: false, detail: describeError(error) };
			}
		},
		/**
		 * Deletes the pending push by the id the publish returned. Without one — a
		 * record from before ids were stored — the sequence-id form is the last
		 * resort; it is unverified on any server, and `ntfy.sh` answers `200` to it
		 * while still delivering the message (ADR 12). Whether the message-id delete
		 * lands depends on the HTTP client, too: Obsidian's `requestUrl` is
		 * Electron/Chromium's stack, not the undici build that cancelled nothing.
		 */
		clear: async (instanceId: string, ctx: ChannelContext, pushId?: string): Promise<void> => {
			// Deliberately not gated on `isConfigured`: switching the channel off must
			// not strand a push it already scheduled, or the alert the user thought
			// they had cancelled still arrives with nothing left able to withdraw it.
			// The prerequisites, not the enable flag: the stored server and topic are
			// all a delete needs, and `ntfyEnabled` off is precisely the case where
			// the user expects the pending alert to go away.
			if (ctx.settings.ntfyServer.trim().length === 0 || ctx.settings.ntfyTopic.trim().length === 0) {
				return;
			}
			try {
				await request({
					url: `${topicUrl(ctx.settings.ntfyServer, ctx.settings.ntfyTopic)}/${encodeURIComponent(pushId ?? instanceId)}`,
					method: "DELETE",
					headers: ctx.settings.ntfyToken.trim().length > 0 ? { Authorization: `Bearer ${ctx.settings.ntfyToken.trim()}` } : {},
					body: "",
				});
			} catch {
				// A failed cancellation is not worth an alert.
			}
		},
	};
}
