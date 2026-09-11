/**
 * The HTTP seam the network channels use.
 *
 * Inside the plugin the only transport is Obsidian's `requestUrl`, and it is not
 * interchangeable with node's `fetch`: it is Electron/Chromium's stack, and the
 * difference is measured, not theoretical — a `DELETE` that `curl` and Bun both
 * honoured, ntfy.sh answered `200` to while still delivering, on node's undici
 * build (ADR 12). Keeping the call behind this seam is also what lets a test or a
 * verification script hand in its own client and drive a real request builder
 * without a network.
 */

import { requestUrl } from "obsidian";

export interface HttpRequestInit {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

export interface HttpResponse {
	status: number;
	text?: string;
	/** The parsed body, when the transport read one. */
	json?: unknown;
}

export type HttpRequest = (init: HttpRequestInit) => Promise<HttpResponse>;

export const requestUrlTransport: HttpRequest = async (init) => {
	const response = await requestUrl({ url: init.url, method: init.method, headers: init.headers, body: init.body, throw: false });
	let json: unknown;
	try {
		// Obsidian parses the body, and an empty or plain-text reply is normal
		// (`throw: false`), so a body that is not JSON must not become an exception.
		json = response.json;
	} catch {
		json = undefined;
	}
	return { status: response.status, text: response.text, json };
};
