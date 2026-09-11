import { beforeEach, describe, expect, it } from "vitest";
import { MIN_SERVER_DELAY_SECONDS, buildNtfyRequest, createNtfyChannel } from "../src/channels/ntfy";
import type { KairosSettings } from "../src/settings";
import { channelContext, outboundMessage, testSettings } from "./support";
import { requestUrlStub } from "./stubs/obsidian";

const DUE = Date.UTC(2026, 8, 11, 9, 0);

function ntfySettings(overrides: Partial<KairosSettings> = {}): KairosSettings {
	return testSettings({
		ntfyEnabled: true,
		ntfyServer: "https://ntfy.sh",
		ntfyTopic: "kairos-topic",
		ntfyPriority: 4,
		...overrides,
	});
}

beforeEach(() => {
	requestUrlStub.reset();
});

describe("buildNtfyRequest", () => {
	it("posts the title to the topic with the schedule headers", () => {
		const now = DUE - 60 * 60 * 1000;
		const request = buildNtfyRequest(ntfySettings(), outboundMessage(), { now, includeNoteName: false });
		expect(request.url).toBe("https://ntfy.sh/kairos-topic");
		expect(request.method).toBe("POST");
		expect(request.headers["X-Title"]).toBe("msg to dentist");
		expect(request.headers["X-Priority"]).toBe("4");
		expect(request.headers["X-At"]).toBe(String(Math.round(DUE / 1000)));
		// A message published with X-Sequence-ID cannot be cancelled on ntfy.sh:
		// deletes by message id and by sequence id both answer `200` and the push
		// still arrives, so the publish deliberately carries no sequence id.
		expect(request.headers["X-Sequence-ID"]).toBeUndefined();
		expect(request.body).toBe("msg to dentist");
	});

	it("schedules at an absolute time, not a bare count of seconds", () => {
		// The header has to be a Unix timestamp or a duration with a unit. A count of
		// seconds is neither: `X-At: 3600` is a moment in 1970, and the server answers
		// `400 invalid delay parameter`, so nothing is ever scheduled — which is how a
		// phone quietly stops ringing. Asserting the number is ahead of now is what
		// makes this test fail for that form.
		const now = DUE - 60 * 60 * 1000;
		const header = Number(buildNtfyRequest(ntfySettings(), outboundMessage(), { now, includeNoteName: false }).headers["X-At"]);
		expect(Number.isInteger(header)).toBe(true);
		expect(header).toBeGreaterThan(Math.floor(now / 1000));
		expect(header).toBe(Math.round(DUE / 1000));
	});

	it("never schedules a push closer than the server accepts", () => {
		const now = DUE - 2000;
		const request = buildNtfyRequest(ntfySettings(), outboundMessage(), { now, includeNoteName: false });
		expect(Number(request.headers["X-At"])).toBe(Math.floor(now / 1000) + MIN_SERVER_DELAY_SECONDS);
	});

	it("sends the title alone unless the note name is opted in", () => {
		const settings = ntfySettings();
		const message = outboundMessage();
		const plain = buildNtfyRequest(settings, message, { now: DUE, includeNoteName: false });
		expect(plain.body).toBe(message.title);
		expect(plain.body).not.toContain(message.noteName ?? "");
		expect(plain.body).not.toContain("journal/");
		expect(plain.body).not.toContain("2026-09-11");

		const named = buildNtfyRequest(settings, message, { now: DUE, includeNoteName: true });
		expect(named.body).toBe(`${message.title} · ${message.noteName ?? ""}`);
	});

	it("carries a bearer token only when one is configured", () => {
		const message = outboundMessage();
		expect(buildNtfyRequest(ntfySettings(), message, { now: DUE, includeNoteName: false }).headers["Authorization"]).toBeUndefined();
		const withToken = buildNtfyRequest(ntfySettings({ ntfyToken: " tk_secret " }), message, { now: DUE, includeNoteName: false });
		expect(withToken.headers["Authorization"]).toBe("Bearer tk_secret");
	});
});

describe("createNtfyChannel", () => {
	it("posts the alert through the Obsidian request API", async () => {
		const settings = ntfySettings();
		const now = DUE - 60 * 60 * 1000;
		const result = await createNtfyChannel().send(outboundMessage(), channelContext(settings, now));
		expect(result.ok).toBe(true);
		expect(requestUrlStub.calls).toHaveLength(1);
		const call = requestUrlStub.calls[0];
		expect(call?.url).toBe("https://ntfy.sh/kairos-topic");
		expect(call?.method).toBe("POST");
		expect(call?.headers?.["X-Title"]).toBe("msg to dentist");
		expect(call?.headers?.["X-Priority"]).toBe("4");
		expect(call?.headers?.["X-At"]).toBe(String(Math.round(DUE / 1000)));
		// No X-Sequence-ID: a message published with one cannot be cancelled, so
		// the publish that the channel actually makes must not carry it either.
		expect(call?.headers?.["X-Sequence-ID"]).toBeUndefined();
		expect(call?.body).toBe("msg to dentist");
	});

	it("surfaces the message id from the publish response", async () => {
		requestUrlStub.handler = () => ({
			status: 200,
			text: '{"id":"WzI0MzE1NQ","time":1789203600}',
			json: { id: "WzI0MzE1NQ", time: 1789203600 },
			arrayBuffer: new ArrayBuffer(0),
			headers: {},
		});
		const result = await createNtfyChannel().send(outboundMessage(), channelContext(ntfySettings(), DUE));
		expect(result.ok).toBe(true);
		expect(result.id).toBe("WzI0MzE1NQ");
	});

	it("accepts a publish response with no JSON body, reporting no id", async () => {
		// A self-hosted server may answer with an empty body; the delivered push
		// must not turn into a failure just because there is no id to parse.
		const result = await createNtfyChannel().send(outboundMessage(), channelContext(ntfySettings(), DUE));
		expect(result.ok).toBe(true);
		expect(result.id).toBeUndefined();
	});

	it("cancels the push by deleting the message id the publish returned", async () => {
		const channel = createNtfyChannel();
		await channel.clear?.("instance-1", channelContext(ntfySettings({ ntfyToken: " tk_secret " }), DUE), "WzI0MzE1NQ");
		expect(requestUrlStub.calls).toHaveLength(1);
		const call = requestUrlStub.calls[0];
		expect(call?.url).toBe("https://ntfy.sh/kairos-topic/WzI0MzE1NQ");
		expect(call?.method).toBe("DELETE");
		expect(call?.headers?.["Authorization"]).toBe("Bearer tk_secret");
		// No body, and no X-Sequence-ID: a repeat publish published a blank
		// notification instead of cancelling anything.
		expect(call?.body).toBe("");
		expect(call?.headers?.["X-Sequence-ID"]).toBeUndefined();
	});

	it("falls back to the sequence id when the record carries no message id", async () => {
		const channel = createNtfyChannel();
		await channel.clear?.("instance-1", channelContext(ntfySettings(), DUE));
		expect(requestUrlStub.calls).toHaveLength(1);
		const call = requestUrlStub.calls[0];
		expect(call?.url).toBe("https://ntfy.sh/kairos-topic/instance-1");
		expect(call?.method).toBe("DELETE");
		expect(call?.body).toBe("");
	});

	it("reports a server error instead of claiming delivery", async () => {
		requestUrlStub.status = 500;
		const result = await createNtfyChannel().send(outboundMessage(), channelContext(ntfySettings(), DUE));
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("500");
	});

	it("withdraws a scheduled push even after the channel is switched off", async () => {
		// Switching the channel off must not strand the push it already scheduled:
		// the record still holds the message id, and the alert the user thought they
		// had cancelled would arrive with nothing left able to withdraw it. The
		// stored server and topic are all the delete needs.
		const channel = createNtfyChannel();
		expect(typeof channel.clear).toBe("function");
		await channel.clear?.("instance-1", channelContext(ntfySettings({ ntfyEnabled: false }), DUE), "push-1");
		expect(requestUrlStub.calls).toHaveLength(1);
		expect(requestUrlStub.calls[0]?.method).toBe("DELETE");
		expect(requestUrlStub.calls[0]?.url).toBe("https://ntfy.sh/kairos-topic/push-1");
	});
});
