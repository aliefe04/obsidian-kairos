/**
 * Plugin entry point.
 *
 * onload only wires things up; indexing starts at onLayoutReady (spec §6). Every
 * listener, command and interval goes through the Plugin registration helpers so
 * Obsidian tears them down on unload.
 */

import { Notice, Platform, Plugin, TFile, type WorkspaceLeaf } from "obsidian";
import { createDesktopChannel } from "./channels/desktop";
import { createIcsChannel, type IcsEvent } from "./channels/ics";
import { createNtfyChannel } from "./channels/ntfy";
import { ChannelRegistry, combinedResult, describeError, type ChannelContext, type DeliveryResult, type OutboundMessage } from "./channels/types";
import { VaultIndexer, type ScanSummary } from "./index/indexer";
import { dailyNotePath } from "./parse/dailyNotePath";
import { getLocalePack } from "./parse/locales/index";
import { normalizeRelPath } from "./parse/instanceId";
import { rewriteTimeToken, type ParsedReminder, type ParseSettings } from "./parse/parseNote";
import type { Hm } from "./parse/timeTokens";
import { formatHm, parseHm } from "./parse/timeTokens";
import { ScheduleEngine, messageSummary, type ReminderRecord, type ServerScheduleResult, type TickResult } from "./schedule/engine";
import { FileStateStore, stateRoot } from "./schedule/stateStore";
import { deviceTimeZone, localToday, shiftYmd } from "./schedule/time";
import { DEFAULT_SETTINGS, KairosSettingTab, normalizeSettings, type KairosSettings, type SettingsHost } from "./settings";
import { AddReminderModal, type ReminderDraft } from "./ui/addReminderModal";
import { KAIROS_AGENDA_VIEW, KairosAgendaView, addDays, groupAgenda, type AgendaGroup, type AgendaItem } from "./ui/agendaView";

const DEVICE_KEY = "kairos-device-id";
const TICK_FLOOR_MS = 60 * 1000;

function randomId(): string {
	try {
		return crypto.randomUUID();
	} catch {
		return `dev-${Math.random().toString(36).slice(2)}`;
	}
}

export default class KairosPlugin extends Plugin implements SettingsHost {
	override settings: KairosSettings = { ...DEFAULT_SETTINGS };
	private readonly registry = new ChannelRegistry();
	private engine: ScheduleEngine | null = null;
	/** The last mirroring pass, so a refused registration is visible rather than silent. */
	private lastPushPass: ServerScheduleResult | null = null;
	private indexer: VaultIndexer | null = null;
	private deviceId = "";
	private dailyNotesFormat = "";
	private wakeHandle: number | null = null;

	override async onload(): Promise<void> {
		await this.loadSettings();
		this.deviceId = this.readDeviceId();
		const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		const store = new FileStateStore(
			this.app.vault.adapter,
			stateRoot({ stateLocation: this.settings.stateLocation, pluginDir, vaultStateFolder: this.settings.vaultStateFolder }),
			this.deviceId,
			this.tzId(),
		);
		this.engine = new ScheduleEngine({
			store,
			settings: this.settings,
			vaultId: this.settings.vaultId,
			deviceId: this.deviceId,
			tzId: this.tzId(),
			platform: Platform.isMobileApp ? "mobile" : Platform.isDesktopApp ? "desktop" : "unknown",
			pluginVersion: this.manifest.version,
			clock: () => Date.now(),
			send: (message) => this.deliverEverywhere(message),
			sendScheduled: (message) => this.deliverServerScheduled(message),
			clearScheduled: (instanceId) => this.registry.clearInstance(instanceId, this.channelContext()),
			onDeliver: (record, message) => {
				if (record.severity === "alarm" && message.actions) {
					// The summary is deliberately title-free, so the title is composed
					// here — once, on the one surface that has no title of its own.
					new Notice(`${message.title} · ${messageSummary(message)}`, 5000);
				}
			},
		});
		this.registerChannels();
		this.addSettingTab(new KairosSettingTab(this.app, this));
		this.registerView(KAIROS_AGENDA_VIEW, (leaf: WorkspaceLeaf) => new KairosAgendaView(leaf, () => this.agendaGroups(), (item) => this.openItem(item)));
		this.registerCommands();
		this.indexer = new VaultIndexer({
			app: this.app,
			settings: () => this.parseSettings(),
			localeTag: () => this.settings.locale,
			tzId: () => this.tzId(),
			today: () => localToday(Date.now(), this.tzId()),
			onFile: (path, reminders, ambiguous) => {
				void this.applyIndex(path, reminders, ambiguous);
			},
		});
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				this.indexer?.scheduleFile(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", () => {
				void this.rescan();
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", () => {
				void this.rescan();
			}),
		);
		this.registerInterval(
			window.setInterval(() => {
				void this.tickNow();
			}, TICK_FLOOR_MS),
		);
		this.app.workspace.onLayoutReady(() => {
			void this.start();
		});
	}

	override onunload(): void {
		if (this.wakeHandle !== null) {
			window.clearTimeout(this.wakeHandle);
			this.wakeHandle = null;
		}
	}

	private readDeviceId(): string {
		try {
			const existing = window.localStorage.getItem(DEVICE_KEY);
			if (existing !== null && existing.length > 0) {
				return existing;
			}
			const created = randomId();
			window.localStorage.setItem(DEVICE_KEY, created);
			return created;
		} catch {
			return randomId();
		}
	}

	private tzId(): string {
		return deviceTimeZone();
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as unknown;
		this.settings = normalizeSettings(stored);
		if (this.settings.vaultId.length === 0) {
			this.settings.vaultId = randomId();
			await this.saveSettings();
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	channelNames(): string[] {
		return this.registry.names();
	}

	private parseSettings(): ParseSettings {
		return {
			dailyNotesFolder: this.settings.dailyNotesFolder.trim().length > 0 ? this.settings.dailyNotesFolder : "",
			dailyNoteFormats: [this.dailyNotesFormat, ...this.settings.dailyNoteFormats.split("\n")]
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.join("\n"),
			useFrontmatterDate: this.settings.useFrontmatterDate,
			useHeadingDate: this.settings.useHeadingDate,
			useFilenameDate: this.settings.useFilenameDate,
			useDailyNotesFolderDate: this.settings.useDailyNotesFolderDate,
			defaultReminderTime: this.settings.defaultReminderTime,
			defaultSeverity: this.settings.defaultSeverity,
			quietHoursEnabled: this.settings.quietHoursEnabled,
			quietHoursStart: this.settings.quietHoursStart,
			quietHoursEnd: this.settings.quietHoursEnd,
			aggressiveMidLine: this.settings.aggressiveMidLine,
			completingStatusChars: this.settings.completingStatusChars,
		};
	}

	private channelContext(): ChannelContext {
		return {
			now: Date.now(),
			deviceId: this.deviceId,
			tzId: this.tzId(),
			settings: this.settings,
			openInstance: (instanceId) => {
				this.openInstance(instanceId);
			},
			ack: (instanceId) => {
				void this.ack(instanceId);
			},
			snooze: (instanceId, minutes) => {
				void this.snooze(instanceId, minutes);
			},
		};
	}

	private registerChannels(): void {
		this.registry.register(createDesktopChannel({ app: this.app }));
		this.registry.register(createNtfyChannel());
		this.registry.register(
			createIcsChannel({
				plugin: this,
				events: (settings) => this.icsEvents(settings.icsAlarmMinutesBefore),
			}),
		);
	}

	private icsEvents(alarmMinutesBefore: number): IcsEvent[] {
		const engine = this.engine;
		if (!engine) {
			return [];
		}
		return engine
			.snapshot()
			// A superseded predecessor must not become a calendar event either.
			.filter((record) => record.state === "scheduled" || record.state === "armed")
			.map((record) => ({
				uid: record.instanceId,
				title: record.title,
				dueLocal: record.dueLocal,
				tzId: record.tzId,
				noteName: record.sourcePath,
				alarmMinutesBefore,
				createdMs: record.firstSeenAt,
			}));
	}

	private registerCommands(): void {
		this.addCommand({
			id: "open-agenda",
			name: "Open agenda",
			callback: () => {
				void this.openAgenda();
			},
		});
		this.addCommand({
			id: "add-reminder",
			name: "Add reminder…",
			callback: () => {
				this.addReminder();
			},
		});
		this.addCommand({
			id: "rescan-vault",
			name: "Rescan vault",
			callback: () => {
				void this.rescan();
			},
		});
		this.addCommand({
			id: "copy-diagnostics",
			name: "Copy diagnostics",
			callback: () => {
				void this.copyDiagnostics();
			},
		});
		this.addCommand({
			id: "test-notification",
			name: "Test notification",
			callback: () => {
				void this.testNotification();
			},
		});
	}

	private async start(): Promise<void> {
		const config = await this.indexer?.loadDailyNotesConfig();
		if (config) {
			this.dailyNotesFormat = config.format;
			if (this.settings.dailyNotesFolder.trim().length === 0 && config.folder.length > 0) {
				this.settings.dailyNotesFolder = config.folder;
			}
		}
		await this.engine?.load();
		await this.rescan();
	}

	/** Full rescan and rebuild of the due set. */
	async rescan(): Promise<ScanSummary | null> {
		const engine = this.engine;
		const indexer = this.indexer;
		if (!engine || !indexer) {
			return null;
		}
		const summary = await indexer.scanAll();
		const result = await engine.sync(this.collectReminders());
		if (summary.ambiguousNotes.length > 0) {
			new Notice(`${summary.ambiguousNotes.length} notes could not be date-resolved`, 6000);
		}
		void result;
		await this.tickNow();
		await this.syncServerSchedule();
		return summary;
	}

	private async applyIndex(path: string, reminders: ParsedReminder[], ambiguous: boolean): Promise<void> {
		const engine = this.engine;
		if (!engine) {
			return;
		}
		this.remindersByPath.set(normalizeRelPath(path), { reminders, ambiguous });
		await this.syncServerSchedule();
		void this.tickNow();
	}

	private readonly remindersByPath = new Map<string, { reminders: ParsedReminder[]; ambiguous: boolean }>();

	private collectReminders(): ParsedReminder[] {
		const all: ParsedReminder[] = [];
		for (const entry of this.remindersByPath.values()) {
			all.push(...entry.reminders);
		}
		return all;
	}

	/** Recomputes the due set and fires what is due; the smoke harness calls this. */
	async tickNow(): Promise<TickResult | null> {
		const engine = this.engine;
		if (!engine) {
			return null;
		}
		const result = await engine.tick();
		this.scheduleWake(result.nextWakeAt);
		return result;
	}

	private scheduleWake(nextWakeAt: number | null): void {
		if (this.wakeHandle !== null) {
			window.clearTimeout(this.wakeHandle);
			this.wakeHandle = null;
		}
		if (nextWakeAt === null) {
			return;
		}
		const delay = Math.max(1000, Math.min(nextWakeAt - Date.now(), 24 * 60 * 60 * 1000));
		this.wakeHandle = window.setTimeout(() => {
			this.wakeHandle = null;
			void this.tickNow();
		}, delay);
	}

	async snooze(instanceId: string, minutes: number): Promise<void> {
		const engine = this.engine;
		if (!engine) {
			return;
		}
		const record = engine.snapshot().find((candidate) => candidate.instanceId === instanceId);
		const result = await engine.snooze(instanceId, minutes);
		if (!result || !record || !this.settings.annotateInNote) {
			await this.tickNow();
			return;
		}
		// A snooze that crosses midnight cannot be written as a bare time token in a
		// note dated the previous day: "23:50 + 30 min" would be written as 00:20
		// under yesterday's date, which re-parses as a different, already-past
		// instance and alerts a second time. The successor stays owned by state.
		if (result.dueLocal.slice(0, 10) !== record.dueLocal.slice(0, 10)) {
			await this.tickNow();
			return;
		}
		const from = parseHm(record.dueLocal.slice(11));
		const to = parseHm(result.dueLocal.slice(11));
		if (from && to) {
			await this.annotateSnooze(record, from, to);
		}
		await this.tickNow();
		await this.syncServerSchedule();
	}

	/** One atomic write, re-verified against the line the reminder came from. */
	private async annotateSnooze(record: ReminderRecord, from: Hm, to: Hm): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(record.sourcePath);
		if (!(file instanceof TFile)) {
			return;
		}
		const pack = getLocalePack(this.settings.locale);
		await this.app.vault.process(file, (data) => {
			const lines = data.split("\n");
			const line = lines[record.line];
			if (line === undefined) {
				return data;
			}
			const rewritten = rewriteTimeToken(line, from, to, pack);
			if (rewritten === null) {
				return data;
			}
			lines[record.line] = rewritten;
			return lines.join("\n");
		});
	}

	async ack(instanceId: string): Promise<void> {
		await this.engine?.ack(instanceId);
		await this.tickNow();
		await this.syncServerSchedule();
	}

	openInstance(instanceId: string): void {
		const record = this.engine?.snapshot().find((candidate) => candidate.instanceId === instanceId);
		if (!record) {
			return;
		}
		void this.app.workspace.openLinkText(`${record.sourcePath}#L${record.line + 1}`, "", false);
	}

	private openItem(item: AgendaItem): void {
		void this.app.workspace.openLinkText(`${item.sourcePath}#L${item.line + 1}`, "", false);
	}

	private agendaGroups(): AgendaGroup[] {
		const engine = this.engine;
		if (!engine) {
			return [];
		}
		const today = localToday(Date.now(), this.tzId());
		const items: AgendaItem[] = engine
			.snapshot()
			// "snoozed" is a superseded predecessor: it stays in state so that the old
			// time still in the note cannot fire, but it is not a pending reminder.
			.filter((record) => record.state === "scheduled" || record.state === "armed")
			.map((record) => ({
				instanceId: record.instanceId,
				title: record.title,
				dueLocal: record.dueLocal,
				sourcePath: record.sourcePath,
				line: record.line,
			}));
		const todayIso = `${today.y}-${String(today.m).padStart(2, "0")}-${String(today.d).padStart(2, "0")}`;
		return groupAgenda(items.sort((a, b) => a.dueLocal.localeCompare(b.dueLocal)), todayIso, addDays(todayIso, 7));
	}

	private async openAgenda(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(KAIROS_AGENDA_VIEW);
		const leaf = existing[0] ?? this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: KAIROS_AGENDA_VIEW, active: true });
		for (const openLeaf of this.app.workspace.getLeavesOfType(KAIROS_AGENDA_VIEW)) {
			const view = openLeaf.view;
			if (view instanceof KairosAgendaView) {
				view.render();
			}
		}
	}

	/** Opens the form; the write happens on submit, in one atomic `Vault.process`. */
	private addReminder(): void {
		new AddReminderModal(this.app, {
			defaultTime: this.settings.defaultReminderTime,
			onSubmit: async (draft) => {
				await this.appendReminder(draft);
			},
		}).open();
	}

	private async appendReminder(draft: ReminderDraft): Promise<void> {
		const today = localToday(Date.now(), this.tzId());
		const target = draft.day === "tomorrow" ? shiftYmd(today, 1) : today;
		const path = dailyNotePath(this.dailyNotesFolder(), this.dailyNoteFormat(), target, getLocalePack(this.settings.locale));
		const line = `- [ ] ${draft.title} ${formatHm(draft.time)}`;
		try {
			const file = await this.ensureNote(path);
			await this.app.vault.process(file, (data) => (data.length === 0 || data.endsWith("\n") ? `${data}${line}\n` : `${data}\n${line}\n`));
			new Notice(`Reminder added to ${path}`, 4000);
		} catch (error) {
			new Notice(`Could not add the reminder: ${describeError(error)}`, 6000);
		}
	}

	private dailyNotesFolder(): string {
		return this.settings.dailyNotesFolder.trim().length > 0 ? this.settings.dailyNotesFolder.trim() : "";
	}

	/** The detected Daily notes format wins; the first configured one is the fallback. */
	private dailyNoteFormat(): string {
		if (this.dailyNotesFormat.trim().length > 0) {
			return this.dailyNotesFormat.trim();
		}
		return this.settings.dailyNoteFormats.split("\n")[0]?.trim() ?? "";
	}

	private async ensureNote(path: string): Promise<TFile> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			return existing;
		}
		const folder = path.split("/").slice(0, -1).join("/");
		if (folder.length > 0 && !(await this.app.vault.adapter.exists(folder))) {
			await this.app.vault.createFolder(folder);
		}
		await this.app.vault.create(path, "");
		const created = this.app.vault.getAbstractFileByPath(path);
		if (!(created instanceof TFile)) {
			throw new Error(`the note ${path} could not be created`);
		}
		return created;
	}

	/** One instance, one outcome: a fan-out reports success if any channel delivered. */
	private async deliverEverywhere(message: OutboundMessage): Promise<DeliveryResult> {
		return combinedResult(await this.registry.deliver(message, this.channelContext()));
	}

	private async deliverServerScheduled(message: OutboundMessage): Promise<DeliveryResult> {
		return combinedResult(await this.registry.deliverScheduled(message, this.channelContext()));
	}

	/** Mirrors the live index into the channels that deliver with the app closed. */
	private async syncServerSchedule(): Promise<void> {
		const engine = this.engine;
		if (!engine) {
			return;
		}
		this.lastPushPass = await engine.syncServerScheduled();
	}

	/**
	 * One line about the last push pass. A phone that stops ringing because the
	 * provider refuses the registration must not be silent about it.
	 */
	pushSummary(): string {
		const pass = this.lastPushPass;
		if (!pass) {
			return "push scheduling: no pass yet";
		}
		return `push scheduling: ${pass.sent.length} sent, ${pass.failed.length} failed, ${pass.deferred.length} deferred, ${pass.cleared.length} cancelled`;
	}

	private async copyDiagnostics(): Promise<void> {
		const text = this.diagnostics();
		try {
			await navigator.clipboard.writeText(text);
			new Notice("Diagnostics copied", 3000);
		} catch {
			new Notice(text, 0);
		}
	}

	diagnostics(): string {
		const engine = this.engine;
		const records = engine?.snapshot() ?? [];
		return [
			`Kairos ${this.manifest.version} on Obsidian ${this.app.vault.configDir},`,
			`device ${this.deviceId}, platform ${Platform.isMobileApp ? "mobile" : "desktop"}, tz ${this.tzId()},`,
			`records ${records.length}, channels ${this.registry.names().join(", ")},`,
			this.pushSummary(),
			`daily notes folder ${this.settings.dailyNotesFolder || "(detected)"}, format ${this.dailyNotesFormat || "(default)"}`,
		].join("\n");
	}

	private async testNotification(): Promise<void> {
		const message: OutboundMessage = {
			instanceId: `test-${Date.now()}`,
			title: "Kairos test notification",
			noteName: "Kairos",
			dueLocal: new Date().toISOString().slice(0, 16),
			dueEpochMs: Date.now(),
			severity: "alarm",
			ageMinutes: 0,
			actions: false,
		};
		const results = await this.registry.deliver(message, this.channelContext());
		new Notice(results.map((result) => (result.ok ? "sent" : `failed: ${result.detail ?? ""}`)).join(", ") || "No channel is configured", 6000);
	}
}
