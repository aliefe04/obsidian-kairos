/**
 * Desktop channel: OS notification, alert window, and the fallbacks.
 *
 * Mobile has no notification API for plugins, desktop prefers an Electron
 * `Notification` and degrades to an in-app `Notice` when the constructor is
 * missing or refuses to build one. The alert window is a separate setting, and
 * none of these paths may throw out of `send`.
 *
 * The stub records nothing for `Notice`, so this file wraps it: the fallback is
 * only observable by watching the construction itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { AlertModal, createDesktopChannel } from "../src/channels/desktop";
import type { DeliveryResult, OutboundMessage } from "../src/channels/types";
import { messageSummary } from "../src/schedule/engine";
import type { KairosSettings } from "../src/settings";
import { channelContext, outboundMessage, testSettings } from "./support";
import * as obsidianStub from "./stubs/obsidian";
import type { StubElement } from "./stubs/obsidian";

const { Modal, Platform } = obsidianStub;

const NOW = Date.UTC(2026, 8, 11, 9, 0);

interface RecordedNotice {
	message: string;
	timeout: number | undefined;
}

const notices = vi.hoisted((): RecordedNotice[] => []);

vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof obsidianStub>();
	class RecordingNotice extends actual.Notice {
		constructor(message: string, timeout?: number) {
			super(message, timeout);
			notices.push({ message, timeout });
		}
	}
	return { ...actual, Notice: RecordingNotice };
});

/** The slice of an Electron notification this channel touches. */
interface ShownNotification {
	options: { title: string; body?: string; silent?: boolean };
	shown: number;
	onclick?: (() => void) | null;
}

type NotificationCtor = new (options: { title: string; body?: string; silent?: boolean }) => ShownNotification;

function recordingElectron(): { created: ShownNotification[]; Notification: NotificationCtor } {
	const created: ShownNotification[] = [];
	class FakeNotification implements ShownNotification {
		readonly options: { title: string; body?: string; silent?: boolean };
		shown = 0;
		onclick: (() => void) | null = null;

		constructor(options: { title: string; body?: string; silent?: boolean }) {
			this.options = options;
			created.push(this);
		}

		show(): void {
			this.shown += 1;
		}
	}
	return { created, Notification: FakeNotification };
}

/** A notification the operating system refuses to build, e.g. no permission. */
class NeverNotification {
	constructor() {
		throw new Error("Notification is not available");
	}
}

/** Obsidian hands the renderer Node's `require`; Electron hides behind it. */
function stubWindowRequire(load: (module: string) => unknown): void {
	vi.stubGlobal("window", { require: load });
}

/** The channel only reads `app` to hand it to the modal, which ignores it. */
function stubApp(): App {
	return {} as App;
}

function single<T>(items: T[]): T {
	expect(items).toHaveLength(1);
	const first = items[0];
	if (first === undefined) {
		throw new Error("expected exactly one entry");
	}
	return first;
}

/**
 * What an opened window shows. The stub drives the modal with its own element
 * fake, which is not what the Obsidian types promise, so the read is narrowed.
 */
function windowContent(modal: AlertModal): { title: string; body: string[] } {
	const { titleEl, contentEl } = modal as unknown as { titleEl: StubElement; contentEl: StubElement };
	return { title: titleEl.text, body: contentEl.children.map((child) => child.text) };
}

/** Every window the channel opened, in order. */
let alertWindows: AlertModal[] = [];

beforeEach(() => {
	alertWindows = [];
	vi.spyOn(Modal.prototype, "open").mockImplementation(function (this: unknown): void {
		const modal = this as AlertModal;
		alertWindows.push(modal);
		// The stub's `open` renders the window, so the content is readable after.
		modal.onOpen();
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	Platform.isMobile = false;
	Platform.isMobileApp = false;
	notices.length = 0;
});

function sendTo(message: OutboundMessage, overrides: Partial<KairosSettings> = {}): Promise<DeliveryResult> {
	return createDesktopChannel({ app: stubApp() }).send(message, channelContext(testSettings(overrides), NOW));
}

describe("createDesktopChannel", () => {
	it("shows an in-app notice on mobile and never builds an OS notification", async () => {
		Platform.isMobileApp = true;
		const electron = recordingElectron();
		stubWindowRequire(() => ({ remote: { Notification: electron.Notification } }));
		const message = outboundMessage({ actions: true });

		const result = await sendTo(message);

		expect(result.ok).toBe(true);
		expect(electron.created).toEqual([]);
		expect(alertWindows).toEqual([]);
		expect(notices.map((notice) => notice.message)).toEqual([messageSummary(message)]);
	});

	it("falls back to an in-app notice when Electron exposes no Notification", async () => {
		stubWindowRequire(() => ({ remote: {} }));
		const message = outboundMessage({ actions: true });

		const result = await sendTo(message, { desktopAlertModal: true });

		expect(result.ok).toBe(true);
		expect(notices.map((notice) => notice.message)).toEqual([messageSummary(message)]);
		expect(alertWindows.map((modal) => windowContent(modal).title)).toEqual([message.title]);
	});

	it("opens no alert window in the fallback when the setting is off", async () => {
		stubWindowRequire(() => ({ remote: {} }));
		const message = outboundMessage({ actions: true });

		const result = await sendTo(message, { desktopAlertModal: false });

		expect(result.ok).toBe(true);
		expect(notices).toHaveLength(1);
		expect(alertWindows).toEqual([]);
	});

	it("builds the OS notification with the title and the title-free summary", async () => {
		const electron = recordingElectron();
		stubWindowRequire(() => ({ remote: { Notification: electron.Notification } }));
		const message = outboundMessage({ actions: true });
		const openedInstances: string[] = [];

		const result = await createDesktopChannel({ app: stubApp() }).send(
			message,
			channelContext(testSettings({ desktopAlertModal: true }), NOW, {
				openInstance: (instanceId) => {
					openedInstances.push(instanceId);
				},
			}),
		);

		expect(result.ok).toBe(true);
		const notification = single(electron.created);
		expect(notification.options).toEqual({ title: message.title, body: messageSummary(message), silent: true });
		// The summary already carries the time and the note; repeating the title in
		// the body would print it twice on every notification.
		expect(notification.options.body).not.toContain(message.title);
		expect(notification.shown).toBe(1);
		const opened = windowContent(single(alertWindows));
		expect(opened.title).toBe(message.title);
		expect(opened.body).toEqual([messageSummary(message)]);

		notification.onclick?.();
		expect(openedInstances).toEqual([message.instanceId]);
	});

	it("reports a failed send and still shows a notice when the constructor throws", async () => {
		stubWindowRequire(() => ({ remote: { Notification: NeverNotification } }));
		const message = outboundMessage();

		const result = await sendTo(message);

		expect(result.ok).toBe(false);
		expect(result.detail).toContain("Notification is not available");
		expect(notices.map((notice) => notice.message)).toEqual([messageSummary(message)]);
	});
});
