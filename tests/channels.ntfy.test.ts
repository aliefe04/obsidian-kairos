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
	it("posts the title to the topic with the schedule and dedupe headers", () => {
		const request = buildNtfyRequest(ntfySettings(), outboundMessage(), { now: DUE - 60 * 60 * 1000, includeNoteName: false });
		expect(request.url).toBe("https://ntfy.sh/kairos-topic");
		expect(request.method).toBe("POST");
		expect(request.headers["X-Title"]).toBe("msg to dentist");
		expect(request.headers["X-Priority"]).toBe("4");
		expect(request.headers["X-At"]).toBe("3600");
		expect(request.headers["X-Sequence-ID"]).toBe("instance-1");
		expect(request.body).toBe("msg to dentist");
	});

	it("never schedules a push closer than the server accepts", () => {
		const request = buildNtfyRequest(ntfySettings(), outboundMessage(), { now: DUE - 2000, includeNoteName: false });
		expect(Number(request.headers["X-At"])).toBe(MIN_SERVER_DELAY_SECONDS);
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
		const result = await createNtfyChannel().send(outboundMessage(), channelContext(settings, DUE - 60 * 60 * 1000));
		expect(result.ok).toBe(true);
		expect(requestUrlStub.calls).toHaveLength(1);
		const call = requestUrlStub.calls[0];
		expect(call?.url).toBe("https://ntfy.sh/kairos-topic");
		expect(call?.method).toBe("POST");
		expect(call?.headers?.["X-Title"]).toBe("msg to dentist");
		expect(call?.headers?.["X-Priority"]).toBe("4");
		expect(call?.headers?.["X-At"]).toBe("3600");
		expect(call?.headers?.["X-Sequence-ID"]).toBe("instance-1");
		expect(call?.body).toBe("msg to dentist");
	});

	it("clears a scheduled push by re-publishing its sequence id with an empty body", async () => {
		const settings = ntfySettings();
		const channel = createNtfyChannel();
		expect(typeof channel.clear).toBe("function");
		await channel.clear?.("instance-1", channelContext(settings, DUE));
		expect(requestUrlStub.calls).toHaveLength(1);
		const call = requestUrlStub.calls[0];
		expect(call?.url).toBe("https://ntfy.sh/kairos-topic");
		expect(call?.headers?.["X-Sequence-ID"]).toBe("instance-1");
		expect(call?.body).toBe("");
	});

	it("reports a server error instead of claiming delivery", async () => {
		requestUrlStub.status = 500;
		const result = await createNtfyChannel().send(outboundMessage(), channelContext(ntfySettings(), DUE));
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("500");
	});

	it("clears nothing when the channel is not configured", async () => {
		const channel = createNtfyChannel();
		expect(typeof channel.clear).toBe("function");
		await channel.clear?.("instance-1", channelContext(ntfySettings({ ntfyEnabled: false }), DUE));
		expect(requestUrlStub.calls).toEqual([]);
	});
});
