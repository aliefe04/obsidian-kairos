/**
 * Desktop channel: an operating system notification plus the alert window.
 *
 * On mobile there is no Electron remote and no OS notification API for plugins,
 * so this degrades to an in-app Notice. Nothing here throws on either platform.
 */

import { Modal, Notice, Platform, Setting, type App } from "obsidian";
import { describeError, type ChannelContext, type DeliveryChannel, type DeliveryResult, type OutboundMessage } from "./types";
import { ageOf, messageSummary } from "../schedule/engine";
import type { KairosSettings } from "../settings";

interface ElectronNotification {
	show(): void;
	onclick?: (() => void) | null;
}

interface ElectronNotificationCtor {
	new (options: { title: string; body?: string; silent?: boolean }): ElectronNotification;
}

interface ElectronModule {
	remote?: { Notification?: unknown };
	Notification?: unknown;
}

type ElectronRequire = (module: string) => unknown;

function notificationCtor(): ElectronNotificationCtor | null {
	try {
		const windowWithRequire = window as unknown as { require?: ElectronRequire };
		const request = windowWithRequire.require;
		if (typeof request !== "function") {
			return null;
		}
		const electron = request("electron") as ElectronModule | undefined;
		const candidate = electron?.remote?.Notification ?? electron?.Notification;
		return typeof candidate === "function" ? (candidate as ElectronNotificationCtor) : null;
	} catch {
		return null;
	}
}

export class AlertModal extends Modal {
	private minutes = 10;

	constructor(
		app: App,
		private readonly message: OutboundMessage,
		private readonly ctx: ChannelContext,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText(this.message.title);
		contentEl.createEl("p", { text: messageSummary(this.message) });
		new Setting(contentEl)
			.setName("Snooze for (minutes)")
			.addText((component) =>
				component.setValue(String(this.minutes)).onChange((value) => {
					const parsed = Number(value);
					this.minutes = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 10;
				}),
			);
		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText("Done").setCta().onClick(() => {
					this.ctx.ack(this.message.instanceId);
					this.close();
				}),
			)
			.addButton((button) =>
				button.setButtonText("Snooze 10 minutes").onClick(() => {
					this.ctx.snooze(this.message.instanceId, 10);
					this.close();
				}),
			)
			.addButton((button) =>
				button.setButtonText("Snooze…").onClick(() => {
					this.ctx.snooze(this.message.instanceId, this.minutes);
					this.close();
				}),
			)
			.addButton((button) =>
				button.setButtonText("Open note").onClick(() => {
					this.ctx.openInstance(this.message.instanceId);
					this.close();
				}),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

export interface DesktopChannelOptions {
	app: App;
}

export function createDesktopChannel(options: DesktopChannelOptions): DeliveryChannel {
	return {
		id: "desktop",
		name: "Desktop notification",
		mode: "local",
		isConfigured: (settings: KairosSettings) => settings.desktopEnabled,
		send: async (message: OutboundMessage, ctx: ChannelContext): Promise<DeliveryResult> => {
			// This string is the whole alert text for the in-app notices, so it has
			// to carry the task name; the OS notification and the alert window take
			// the title separately, which is why `messageSummary` stays title-free.
			const text = `${message.title} · ${messageSummary(message)}`;
			if (Platform.isMobileApp || Platform.isMobile) {
				new Notice(text, 0);
				return { ok: true, detail: "notice" };
			}
			// Alarms only: a digest is by definition the non-interruptive path, and the
			// window takes keyboard focus when it opens.
			const showModal = ctx.settings.desktopAlertModal && message.actions && message.severity === "alarm";
			const notify = notificationCtor();
			if (!notify) {
				new Notice(text, 0);
				if (showModal) {
					new AlertModal(options.app, message, ctx).open();
				}
				return { ok: true, detail: "notice fallback" };
			}
			try {
				const notification = new notify({ title: message.title, body: messageSummary(message), silent: !ctx.settings.desktopSound });
				notification.onclick = () => {
					ctx.openInstance(message.instanceId);
				};
				notification.show();
				// The setting promises a window with Done, Snooze and Open note for due
				// alarms, so it opens with the notification rather than only when the
				// notification happens to be clicked.
				if (showModal) {
					new AlertModal(options.app, message, ctx).open();
				}
				return { ok: true, detail: showModal ? "os notification + alert window" : "os notification" };
			} catch (error) {
				new Notice(text, 0);
				return { ok: false, detail: describeError(error) };
			}
		},
		clear: async (): Promise<void> => {
			// The desktop channel cannot unschedule an OS notification; the modal
			// simply never opens for an instance that was acked or cancelled.
		},
	};
}

export function lateAgeLabel(ageMinutes: number): string {
	return ageMinutes >= 1 ? ageOf(ageMinutes) : "";
}
