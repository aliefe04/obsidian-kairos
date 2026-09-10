import { PluginSettingTab, type App, type Plugin, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import type { Hm } from "./parse/timeTokens";
import { parseHm } from "./parse/timeTokens";
import { listLocaleTags } from "./parse/locales/index";

export type CatchUpPolicy = "fire_now_with_age" | "fold_into_digest" | "skip_and_mark_missed";
export type Severity = "alarm" | "digest";
export type StateLocation = "plugin-dir" | "vault-folder";

/**
 * Settings are flat scalars on purpose (docs/spec/state-model.md §4):
 * `.obsidian/*.json` merges local keys on top of remote, which is safe for
 * scalars and unsafe for arrays, so multi-valued settings are newline-separated
 * strings.
 */
export interface KairosSettings {
	vaultId: string;
	dailyNotesFolder: string;
	dailyNoteFormats: string;
	useFrontmatterDate: boolean;
	useHeadingDate: boolean;
	useFilenameDate: boolean;
	useDailyNotesFolderDate: boolean;
	defaultReminderTime: string;
	leadMinutes: number;
	graceMinutes: number;
	catchUpPolicy: CatchUpPolicy;
	defaultSeverity: Severity;
	quietHoursEnabled: boolean;
	quietHoursStart: string;
	quietHoursEnd: string;
	digestTimes: string;
	aggressiveMidLine: boolean;
	completingStatusChars: string;
	annotateInNote: boolean;
	stateLocation: StateLocation;
	vaultStateFolder: string;
	locale: string;
	includeNoteName: boolean;
	desktopEnabled: boolean;
	desktopAlertModal: boolean;
	desktopSound: boolean;
	ntfyEnabled: boolean;
	ntfyServer: string;
	ntfyTopic: string;
	ntfyToken: string;
	ntfyPriority: number;
	icsEnabled: boolean;
	icsPath: string;
	icsAlarmMinutesBefore: number;
}

export const DEFAULT_FORMATS = [
	"YYYY-MM-DD",
	"DD-MM-YYYY",
	"YYYY/MM/DD-MM-YYYY-dddd",
	"YYYY/MMMM/DD-MM-YYYY-dddd",
	"DD.MM.YYYY",
	"YYYYMMDD",
];

export const DEFAULT_SETTINGS: KairosSettings = {
	vaultId: "",
	dailyNotesFolder: "",
	dailyNoteFormats: DEFAULT_FORMATS.join("\n"),
	useFrontmatterDate: true,
	useHeadingDate: true,
	useFilenameDate: true,
	useDailyNotesFolderDate: true,
	defaultReminderTime: "09:00",
	leadMinutes: 10,
	graceMinutes: 15,
	catchUpPolicy: "fire_now_with_age",
	defaultSeverity: "alarm",
	quietHoursEnabled: true,
	quietHoursStart: "22:00",
	quietHoursEnd: "07:00",
	digestTimes: "08:00\n18:00",
	aggressiveMidLine: false,
	completingStatusChars: "xX-",
	annotateInNote: false,
	stateLocation: "plugin-dir",
	vaultStateFolder: ".kairos",
	locale: "en",
	includeNoteName: false,
	desktopEnabled: true,
	desktopAlertModal: true,
	desktopSound: false,
	ntfyEnabled: false,
	ntfyServer: "https://ntfy.sh",
	ntfyTopic: "",
	ntfyToken: "",
	ntfyPriority: 4,
	icsEnabled: false,
	icsPath: "kairos.ics",
	icsAlarmMinutesBefore: 0,
};

const CATCH_UP_POLICIES: CatchUpPolicy[] = ["fire_now_with_age", "fold_into_digest", "skip_and_mark_missed"];
const SEVERITIES: Severity[] = ["alarm", "digest"];
const STATE_LOCATIONS: StateLocation[] = ["plugin-dir", "vault-folder"];

export function splitLines(value: string): string[] {
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/** Digest windows and quiet-hour bounds, as minutes since local midnight. */
export function parseMinuteList(value: string): number[] {
	const minutes: number[] = [];
	for (const line of splitLines(value)) {
		const time = parseHm(line);
		if (time) {
			minutes.push(time.hour * 60 + time.minute);
		}
	}
	return [...new Set(minutes)].sort((a, b) => a - b);
}

export function toMinutes(time: Hm): number {
	return time.hour * 60 + time.minute;
}

/** Quiet hours may wrap midnight (`22:00` → `07:00`). */
export function isInQuietHours(minutesOfDay: number, settings: KairosSettings): boolean {
	if (!settings.quietHoursEnabled) {
		return false;
	}
	const start = parseHm(settings.quietHoursStart);
	const end = parseHm(settings.quietHoursEnd);
	if (!start || !end) {
		return false;
	}
	const from = toMinutes(start);
	const to = toMinutes(end);
	if (from === to) {
		return false;
	}
	return from < to ? minutesOfDay >= from && minutesOfDay < to : minutesOfDay >= from || minutesOfDay < to;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function coerceNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.round(value)));
}

function coerceString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function coerceChoice<T extends string>(value: unknown, allowed: T[], fallback: T): T {
	return typeof value === "string" && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

/** Merges persisted data over the defaults, ignoring anything malformed. */
export function normalizeSettings(raw: unknown): KairosSettings {
	const data: Record<string, unknown> = typeof raw === "object" && raw !== null ? { ...(raw as Record<string, unknown>) } : {};
	return {
		vaultId: coerceString(data["vaultId"], DEFAULT_SETTINGS.vaultId),
		dailyNotesFolder: coerceString(data["dailyNotesFolder"], DEFAULT_SETTINGS.dailyNotesFolder),
		dailyNoteFormats: coerceString(data["dailyNoteFormats"], DEFAULT_SETTINGS.dailyNoteFormats),
		useFrontmatterDate: coerceBoolean(data["useFrontmatterDate"], DEFAULT_SETTINGS.useFrontmatterDate),
		useHeadingDate: coerceBoolean(data["useHeadingDate"], DEFAULT_SETTINGS.useHeadingDate),
		useFilenameDate: coerceBoolean(data["useFilenameDate"], DEFAULT_SETTINGS.useFilenameDate),
		useDailyNotesFolderDate: coerceBoolean(data["useDailyNotesFolderDate"], DEFAULT_SETTINGS.useDailyNotesFolderDate),
		defaultReminderTime: coerceString(data["defaultReminderTime"], DEFAULT_SETTINGS.defaultReminderTime),
		leadMinutes: coerceNumber(data["leadMinutes"], DEFAULT_SETTINGS.leadMinutes, 0, 240),
		graceMinutes: coerceNumber(data["graceMinutes"], DEFAULT_SETTINGS.graceMinutes, 0, 1440),
		catchUpPolicy: coerceChoice(data["catchUpPolicy"], CATCH_UP_POLICIES, DEFAULT_SETTINGS.catchUpPolicy),
		defaultSeverity: coerceChoice(data["defaultSeverity"], SEVERITIES, DEFAULT_SETTINGS.defaultSeverity),
		quietHoursEnabled: coerceBoolean(data["quietHoursEnabled"], DEFAULT_SETTINGS.quietHoursEnabled),
		quietHoursStart: coerceString(data["quietHoursStart"], DEFAULT_SETTINGS.quietHoursStart),
		quietHoursEnd: coerceString(data["quietHoursEnd"], DEFAULT_SETTINGS.quietHoursEnd),
		digestTimes: coerceString(data["digestTimes"], DEFAULT_SETTINGS.digestTimes),
		aggressiveMidLine: coerceBoolean(data["aggressiveMidLine"], DEFAULT_SETTINGS.aggressiveMidLine),
		completingStatusChars: coerceString(data["completingStatusChars"], DEFAULT_SETTINGS.completingStatusChars),
		annotateInNote: coerceBoolean(data["annotateInNote"], DEFAULT_SETTINGS.annotateInNote),
		stateLocation: coerceChoice(data["stateLocation"], STATE_LOCATIONS, DEFAULT_SETTINGS.stateLocation),
		vaultStateFolder: coerceString(data["vaultStateFolder"], DEFAULT_SETTINGS.vaultStateFolder),
		locale: coerceString(data["locale"], DEFAULT_SETTINGS.locale),
		includeNoteName: coerceBoolean(data["includeNoteName"], DEFAULT_SETTINGS.includeNoteName),
		desktopEnabled: coerceBoolean(data["desktopEnabled"], DEFAULT_SETTINGS.desktopEnabled),
		desktopAlertModal: coerceBoolean(data["desktopAlertModal"], DEFAULT_SETTINGS.desktopAlertModal),
		desktopSound: coerceBoolean(data["desktopSound"], DEFAULT_SETTINGS.desktopSound),
		ntfyEnabled: coerceBoolean(data["ntfyEnabled"], DEFAULT_SETTINGS.ntfyEnabled),
		ntfyServer: coerceString(data["ntfyServer"], DEFAULT_SETTINGS.ntfyServer),
		ntfyTopic: coerceString(data["ntfyTopic"], DEFAULT_SETTINGS.ntfyTopic),
		ntfyToken: coerceString(data["ntfyToken"], DEFAULT_SETTINGS.ntfyToken),
		ntfyPriority: coerceNumber(data["ntfyPriority"], DEFAULT_SETTINGS.ntfyPriority, 1, 5),
		icsEnabled: coerceBoolean(data["icsEnabled"], DEFAULT_SETTINGS.icsEnabled),
		icsPath: coerceString(data["icsPath"], DEFAULT_SETTINGS.icsPath),
		icsAlarmMinutesBefore: coerceNumber(data["icsAlarmMinutesBefore"], DEFAULT_SETTINGS.icsAlarmMinutesBefore, 0, 1440),
	};
}

export interface SettingsHost {
	settings: KairosSettings;
	saveSettings(): Promise<void>;
	channelNames(): string[];
}

/** Keys whose value has type `T`, so a control can only bind a setting of the matching type. */
type KeyOfType<T> = { [P in keyof KairosSettings]: KairosSettings[P] extends T ? P : never }[keyof KairosSettings];

/** Definition builders: one per control shape, each binding a real `KairosSettings` key. */
function toggleDef(key: KeyOfType<boolean>, name: string, desc: string, aliases: string[], visible?: () => boolean): SettingDefinition<string> {
	return { name, desc, aliases, visible, control: { type: "toggle", key } };
}

function textDef(key: KeyOfType<string>, name: string, desc: string, aliases: string[], visible?: () => boolean): SettingDefinition<string> {
	return { name, desc, aliases, visible, control: { type: "text", key } };
}

function textAreaDef(key: KeyOfType<string>, name: string, desc: string, aliases: string[]): SettingDefinition<string> {
	return { name, desc, aliases, control: { type: "textarea", key } };
}

function sliderDef(
	key: KeyOfType<number>,
	name: string,
	desc: string,
	aliases: string[],
	range: { min: number; max: number; step: number },
	visible?: () => boolean,
): SettingDefinition<string> {
	return { name, desc, aliases, visible, control: { type: "slider", key, ...range } };
}

function dropdownDef(
	key: KeyOfType<string>,
	name: string,
	desc: string,
	aliases: string[],
	options: Record<string, string>,
): SettingDefinition<string> {
	return { name, desc, aliases, control: { type: "dropdown", key, options } };
}

/** A dropdown option map that shows each stored value under its own name. */
function labelled(values: string[]): Record<string, string> {
	const options: Record<string, string> = {};
	for (const value of values) {
		options[value] = value;
	}
	return options;
}

/** Text controls that trim what the user types, matching the handlers this tab replaces. */
const TRIMMED_KEYS = {
	dailyNotesFolder: true,
	defaultReminderTime: true,
	quietHoursStart: true,
	quietHoursEnd: true,
	vaultStateFolder: true,
	ntfyServer: true,
	ntfyTopic: true,
	ntfyToken: true,
	icsPath: true,
} satisfies Partial<Record<keyof KairosSettings, true>>;

/**
 * Controls whose value decides whether other rows render. Every other control
 * persists without a re-render, so a text field keeps focus while the user types.
 */
const VISIBILITY_KEYS = {
	desktopEnabled: true,
	ntfyEnabled: true,
	icsEnabled: true,
	quietHoursEnabled: true,
	stateLocation: true,
} satisfies Partial<Record<keyof KairosSettings, true>>;

/**
 * Settings tab. `getSettingDefinitions()` describes every row declaratively;
 * only rows a plain control cannot express — the password-style ntfy token
 * input and the live channel list — use `render`.
 */
export class KairosSettingTab extends PluginSettingTab {
	private readonly host: SettingsHost;

	constructor(app: App, plugin: Plugin & SettingsHost) {
		super(app, plugin);
		// Held as SettingsHost so `settings` here is ours, not Plugin's stub field.
		this.host = plugin;
	}

	override getControlValue(key: string): unknown {
		// Indexed by control key: the declarative API reads settings by name.
		const settings = this.host.settings as unknown as Record<string, unknown>;
		return settings[key];
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		// Indexed by control key: the declarative API writes settings by name.
		const settings = this.host.settings as unknown as Record<string, unknown>;
		settings[key] = typeof value === "string" && Object.hasOwn(TRIMMED_KEYS, key) ? value.trim() : value;
		await this.host.saveSettings();
		if (Object.hasOwn(VISIBILITY_KEYS, key)) {
			this.update();
		}
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: "Daily notes and dates",
				items: [
					textDef(
						"dailyNotesFolder",
						"Daily notes folder",
						"Vault folder for daily notes. Leave empty to use the Daily notes core plugin's folder, or the vault root.",
						["journal", "daily note", "folder", "path"],
					),
					textAreaDef(
						"dailyNoteFormats",
						"Date formats",
						"One format per line, most specific first. `YYYY/MM/DD-MM-YYYY-dddd` resolves month folders.",
						["journal", "daily note", "date format", "filename"],
					),
					toggleDef(
						"useFrontmatterDate",
						"Read frontmatter dates",
						"Use `date`, `day`, `created` or `journal-date` from frontmatter.",
						["journal", "daily note", "frontmatter", "date"],
					),
					toggleDef(
						"useHeadingDate",
						"Read heading dates",
						"Use a heading that parses as a date, such as `## 2026-09-11`.",
						["journal", "daily note", "heading", "date"],
					),
					toggleDef("useFilenameDate", "Read file name dates", "Use the file name and its parent folders.", [
						"journal",
						"daily note",
						"filename",
						"date",
					]),
					toggleDef(
						"useDailyNotesFolderDate",
						"Cross-check the daily notes folder",
						"A daily note whose path matches a configured format settles day-first versus month-first.",
						["journal", "daily note", "day-first", "month-first"],
					),
				],
			},
			{
				type: "group",
				heading: "Alert timing",
				items: [
					textDef(
						"defaultReminderTime",
						"Default reminder time",
						"Wall clock time used for reminders that carry a date but no time.",
						["reminder", "notification", "default time", "time"],
					),
					sliderDef(
						"leadMinutes",
						"Lead time (minutes)",
						"Arm a reminder this many minutes before it is due.",
						["reminder", "notification", "advance", "wake"],
						{ min: 0, max: 120, step: 1 },
					),
					sliderDef(
						"graceMinutes",
						"Grace (minutes)",
						"A reminder is missed once its due time is older than this.",
						["reminder", "notification", "missed", "late"],
						{ min: 0, max: 240, step: 5 },
					),
					dropdownDef(
						"catchUpPolicy",
						"Catch-up policy",
						"What happens to a reminder that was missed while the app was closed.",
						["reminder", "notification", "missed", "late"],
						{
							fire_now_with_age: "Fire now, show how late it is",
							fold_into_digest: "Add it to the next digest",
							skip_and_mark_missed: "Skip it",
						},
					),
					dropdownDef(
						"defaultSeverity",
						"Default alert mode",
						"Alarms interrupt immediately. Digest items wait for the next digest time.",
						["reminder", "notification", "alarm", "digest"],
						{ alarm: "Alarm", digest: "Digest" },
					),
				],
			},
			{
				type: "group",
				heading: "Quiet hours and digest",
				items: [
					toggleDef(
						"quietHoursEnabled",
						"Quiet hours",
						"Reminders inside quiet hours become digest items instead of alarms.",
						["quiet hours", "notification", "digest", "do not disturb"],
					),
					textDef(
						"quietHoursStart",
						"Quiet hours start",
						"Local wall clock, for example `22:00`.",
						["quiet hours", "timezone", "start", "digest"],
						() => this.host.settings.quietHoursEnabled,
					),
					textDef(
						"quietHoursEnd",
						"Quiet hours end",
						"Local wall clock, for example `07:00`.",
						["quiet hours", "timezone", "end", "digest"],
						() => this.host.settings.quietHoursEnabled,
					),
					textAreaDef("digestTimes", "Digest times", "One local time per line. Digest items are delivered at the next one.", [
						"digest",
						"notification",
						"quiet hours",
						"schedule",
					]),
				],
			},
			{
				type: "group",
				heading: "Parsing",
				items: [
					toggleDef(
						"aggressiveMidLine",
						"Aggressive mid-line parsing",
						"Also read times in the middle of a line. Noisy: prose like `discuss whether 09:00 works` starts alerting.",
						["parsing", "mid-line", "time", "noisy"],
					),
					textDef(
						"completingStatusChars",
						"Completing status characters",
						"Checkbox characters that cancel a reminder, for example `xX-`.",
						["checkbox", "done", "task", "cancel"],
					),
					toggleDef(
						"annotateInNote",
						"Write snooze back into the note",
						"Rewrite the existing time token in place instead of keeping the new time in state only.",
						["snooze", "reminder", "note", "time"],
					),
					dropdownDef(
						"locale",
						"Locale",
						"Language of relative words and month names in notes.",
						["language", "journal", "month names", "timezone"],
						labelled(listLocaleTags()),
					),
				],
			},
			{
				type: "group",
				heading: "State",
				items: [
					dropdownDef(
						"stateLocation",
						"State location",
						"`plugin-dir` keeps state in the plugin folder. `vault-folder` puts it inside the vault so services such as iCloud, OneDrive or Syncthing sync it too.",
						["state", "sync", "folder", "icloud"],
						{ "plugin-dir": "Plugin folder", "vault-folder": "Vault folder" },
					),
					textDef(
						"vaultStateFolder",
						"Vault state folder",
						"Used when the state location is the vault folder.",
						["state", "sync", "folder", "icloud"],
						() => this.host.settings.stateLocation === "vault-folder",
					),
				],
			},
			{
				type: "group",
				heading: "Channels",
				items: [
					{
						name: "Registered channels",
						render: (setting) => {
							setting.setDesc(`Registered channels: ${this.host.channelNames().join(", ")}.`);
						},
					},
					toggleDef("desktopEnabled", "Desktop notifications", "Show an operating system notification when an alarm is due.", [
						"notification",
						"desktop",
						"alarm",
						"os",
					]),
					toggleDef(
						"desktopAlertModal",
						"Alert window",
						"Open a window with Done, Snooze and Open note for due alarms.",
						["notification", "snooze", "alert", "done"],
						() => this.host.settings.desktopEnabled,
					),
					toggleDef(
						"desktopSound",
						"Notification sound",
						"Let the operating system play the notification sound.",
						["notification", "sound", "alarm"],
						() => this.host.settings.desktopEnabled,
					),
					toggleDef("ntfyEnabled", "Send to ntfy", "Push alarm and digest messages to an ntfy topic.", ["ntfy", "push", "notification", "mobile"]),
					textDef("ntfyServer", "ntfy server", "Base URL, for example `https://ntfy.sh`.", ["ntfy", "push", "server", "url"], () =>
						this.host.settings.ntfyEnabled,
					),
					textDef("ntfyTopic", "ntfy topic", "Topic name. Treat it as a secret: anyone who knows it can subscribe.", [
						"ntfy",
						"push",
						"topic",
						"mobile",
					], () => this.host.settings.ntfyEnabled),
					{
						name: "Ntfy access token",
						desc: "Sent as a bearer token. Leave empty for public topics. Tokens are stored as plaintext in this vault's data.json, so sync and backups carry them.",
						aliases: ["ntfy", "push", "token", "bearer", "secret", "mobile"],
						visible: () => this.host.settings.ntfyEnabled,
						render: (setting) => {
							setting.addText((component) => {
								component.inputEl.setAttribute("type", "password");
								component.setValue(this.host.settings.ntfyToken).onChange(async (value) => {
									await this.setControlValue("ntfyToken", value);
								});
							});
						},
					},
					toggleDef(
						"includeNoteName",
						"Include the note name",
						"Add the note name to outgoing payloads. The task title is always sent.",
						["notification", "push", "payload", "note name", "privacy"],
					),
					toggleDef("icsEnabled", "Write a calendar file", "Keep an iCalendar file up to date inside the vault.", ["calendar", "ics", "export"]),
					textDef("icsPath", "Calendar file path", "Vault-relative path, for example `kairos.ics`.", ["calendar", "ics", "path"], () =>
						this.host.settings.icsEnabled,
					),
					sliderDef(
						"icsAlarmMinutesBefore",
						"Calendar alarm lead (minutes)",
						"How long before the due time the calendar alarm fires.",
						["calendar", "ics", "alarm", "reminder"],
						{ min: 0, max: 240, step: 5 },
						() => this.host.settings.icsEnabled,
					),
				],
			},
		];
	}
}
