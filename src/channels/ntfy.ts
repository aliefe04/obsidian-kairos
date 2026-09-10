/**
 * Push channel: ntfy over HTTP (docs/spec/state-model.md §5).
 *
 * The payload is the task title only by default. Scheduling is delegated to the
 * server with `X-At`, so a closed laptop still gets the push, and
 * `X-Sequence-ID` lets a later message replace or clear it.
 */

import { requestUrl } from "obsidian";
import { describeError, type ChannelContext, type DeliveryChannel, type DeliveryResult, type OutboundMessage } from "./types";
import type { KairosSettings } from "../settings";

export interface HttpRequestInit {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

export interface HttpResponse {
	status: number;
	text?: string;
}

export type HttpRequest = (init: HttpRequestInit) => Promise<HttpResponse>;

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
	const headers: Record<string, string> = {
		"X-Title": message.title,
		"X-Priority": String(settings.ntfyPriority),
		"X-Tags": message.severity === "alarm" ? "alarm_clock" : "inbox_tray",
		"X-Sequence-ID": message.instanceId,
		"Content-Type": "text/plain; charset=utf-8",
	};
	// The server holds the push until the due time, so it survives a closed app.
	const secondsUntilDue = Math.round((message.dueEpochMs - options.now) / 1000);
	headers["X-At"] = String(Math.max(MIN_SERVER_DELAY_SECONDS, secondsUntilDue));
	if (settings.ntfyToken.trim().length > 0) {
		headers["Authorization"] = `Bearer ${settings.ntfyToken.trim()}`;
	}
	const body = options.includeNoteName && message.noteName ? `${message.title} · ${message.noteName}` : message.title;
	return { url: topicUrl(settings.ntfyServer, settings.ntfyTopic), method: "POST", headers, body };
}

const defaultRequest: HttpRequest = async (init) => {
	const response = await requestUrl({ url: init.url, method: init.method, headers: init.headers, body: init.body, throw: false });
	return { status: response.status, text: response.text };
};

export function createNtfyChannel(dependencies: { request?: HttpRequest } = {}): DeliveryChannel {
	const request = dependencies.request ?? defaultRequest;
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
				return response.status >= 200 && response.status < 300
					? { ok: true, detail: String(response.status) }
					: { ok: false, detail: `ntfy returned ${response.status}` };
			} catch (error) {
				return { ok: false, detail: describeError(error) };
			}
		},
		/** Re-publishing the same sequence id with an empty body clears the scheduled push. */
		clear: async (instanceId: string, ctx: ChannelContext): Promise<void> => {
			if (!configured(ctx.settings)) {
				return;
			}
			try {
				await request({
					url: topicUrl(ctx.settings.ntfyServer, ctx.settings.ntfyTopic),
					method: "POST",
					headers: {
						"X-Sequence-ID": instanceId,
						"X-Tags": "no_entry_sign",
						...(ctx.settings.ntfyToken.trim().length > 0 ? { Authorization: `Bearer ${ctx.settings.ntfyToken.trim()}` } : {}),
					},
					body: "",
				});
			} catch {
				// A failed cancellation is not worth an alert.
			}
		},
	};
}
