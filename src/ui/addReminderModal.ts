/**
 * "Add reminder" modal: a title, a time, and the day to write the line into.
 *
 * The vault write stays with the plugin (`main.ts`) so this file owns only the
 * form, and closing the modal without submitting writes nothing.
 */

import { Modal, Setting, type App } from "obsidian";
import { formatHm, parseHm, type Hm } from "../parse/timeTokens";

export type ReminderDay = "today" | "tomorrow";

export interface ReminderDraft {
	title: string;
	time: Hm;
	day: ReminderDay;
}

export interface AddReminderModalOptions {
	/** Seeds the time field; the settings' default reminder time. */
	defaultTime: string;
	onSubmit(draft: ReminderDraft): Promise<void>;
}

const FALLBACK_TIME: Hm = { hour: 9, minute: 0 };

export class AddReminderModal extends Modal {
	private draftTitle = "";
	private time: Hm;
	private day: ReminderDay = "tomorrow";

	constructor(
		app: App,
		private readonly options: AddReminderModalOptions,
	) {
		super(app);
		this.time = parseHm(options.defaultTime) ?? FALLBACK_TIME;
	}

	override onOpen(): void {
		this.titleEl.setText("Add reminder");
		const { contentEl } = this;
		new Setting(contentEl).setName("Reminder").addText((component) =>
			component.setPlaceholder("Call the bank").onChange((value) => {
				this.draftTitle = value;
			}),
		);
		new Setting(contentEl).setName("Time").addText((component) =>
			component.setValue(formatHm(this.time)).onChange((value) => {
				const parsed = parseHm(value);
				if (parsed) {
					this.time = parsed;
				}
			}),
		);
		new Setting(contentEl).setName("Day").addDropdown((component) =>
			component
				.addOption("today", "Today")
				.addOption("tomorrow", "Tomorrow")
				.setValue(this.day)
				.onChange((value) => {
					this.day = value === "today" ? "today" : "tomorrow";
				}),
		);
		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("Add reminder")
					.setCta()
					.onClick(() => {
						void this.submit();
					}),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
	}

	private async submit(): Promise<void> {
		const title = this.draftTitle.trim();
		if (title.length === 0) {
			return;
		}
		this.close();
		await this.options.onSubmit({ title, time: this.time, day: this.day });
	}
}
