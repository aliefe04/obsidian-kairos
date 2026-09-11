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
import { loadVaultId } from "./vaultId";
import { createCalDavChannel } from "./channels/caldav";
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
			// One push per due time, and the third argument is what decides which
			// fan-out serves this fire: `true` means `pushFor === dueLocal`, so the
			// provider is holding a push for this very due time.
			send: (message, _record, serverScheduled) => {
				// Already covered by the registration: the local channels only. Asking
				// the server-scheduled one to publish again here delivers a second copy
				// of the alert for one due time.
				if (serverScheduled) {
					return this.deliverLocally(message);
				}
				// No registration covers this due time — a reminder that came due while
				// Obsidian was closed, or a fold firing at its window. Every configured
				// channel: the provider publishes the push now and clamps the schedule
				// to its minimum delay, so the alert lands seconds after launch. That
				// late push is the delivery, and for a missed reminder the only one.
				return this.deliverEverywhere(message);
			},
			// Each registration carries its channel's own id, so a record can hold one
			// per channel: two server-scheduled channels at once and a single collapsed
			// id would leave one registration permanently unwithdrawable.
			sendScheduled: (message, _record, channels) => this.registry.deliverScheduled(message, this.channelContext(), channels),
			clearScheduled: (instanceId, pushIds) => this.registry.clearInstance(instanceId, this.channelContext(), pushIds),
			// Every registered server-scheduled channel, switched on or not: the engine
			// registers only with the configured ones, but must still be able to
			// withdraw and clean up what a channel registered before it was switched
			// off — including deleting a real entry whose due time has gone by.
			scheduledChannels: () =>
				this.registry
					.all()
					.filter((channel) => channel.mode === "server-scheduled")
					.map((channel) => ({
						id: channel.id,
						configured: channel.isConfigured(this.settings),
						horizonDays: channel.scheduleHorizonDays,
						deleteAfterDue: channel.deleteAfterDue,
					})),
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
		// Read from the vault, not from this device's settings: the id names every
		// registration the plugin makes, and two devices syncing one vault have to
		// agree on it or each writes its own copy of the same reminder. A value
		// already in settings is written out rather than replaced, so a vault that
		// has been running keeps the ids its state files refer to.
		const vaultId = await loadVaultId(this.app.vault.adapter, this.settings.vaultStateFolder, this.settings.vaultId, randomId);
		if (vaultId !== this.settings.vaultId) {
			this.settings.vaultId = vaultId;
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
		this.registry.register(createCalDavChannel());
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
		return this.rescanOnce();
	}

	/**
	 * One scan at a time, with one queued behind it if the vault changed mid-scan.
	 *
	 * `vault.on("rename")` and `vault.on("delete")` both call this fire-and-forget,
	 * and a bulk vault sync (LiveSync, a folder drop) fires them while a scan is
	 * walking — `scanAll` yields to the event loop every 25 files, so a scan is
	 * genuinely interruptible. Two scans at once clear the index map for each other,
	 * and whichever finishes first syncs a map that is missing every file it visited
	 * before the other's clear: those records look deleted, and their registrations
	 * are withdrawn for good. Sharing the promise also saves the second full walk.
	 */
	private async rescanOnce(): Promise<ScanSummary | null> {
		if (this.inFlightScan !== null) {
			// The change that asked for this scan may have landed after the walking scan
			// passed its file, so one more scan is owed when this one finishes.
			this.rescanQueued = true;
			return this.inFlightScan;
		}
		const scan = this.runScan().finally(() => {
			this.inFlightScan = null;
			if (this.rescanQueued) {
				this.rescanQueued = false;
				void this.rescanOnce();
			}
		});
		this.inFlightScan = scan;
		return scan;
	}

	private inFlightScan: Promise<ScanSummary | null> | null = null;
	private rescanQueued = false;

	private async runScan(): Promise<ScanSummary | null> {
		const engine = this.engine;
		const indexer = this.indexer;
		if (!engine || !indexer) {
			return null;
		}
		// The scan calls `applyIndex` for every file it reads, and those calls must not
		// sync the engine: the index is complete only when the scan returns, and the
		// sync below treats what it is given as complete.
		//
		// The map is rebuilt, not accumulated. It is never pruned otherwise, so a note
		// that was deleted or renamed — or one that has lost its last checkbox, which a
		// scan skips entirely — would keep re-offering its reminders on every sync, and
		// the engine would hold a reminder whose line no longer exists.
		const generation = (this.scanGeneration += 1);
		this.remindersByPath.clear();
		// Not merely "a scan is running": a scan that throws leaves the map partial, and
		// a single later edit would then sync that partial map and cancel every record
		// belonging to a file the scan never reached — permanently, since a cancelled
		// record is not resurrected. The index counts as complete only once a whole scan
		// has been synced, so a failed one degrades to "no incremental syncs until the
		// next scan succeeds" rather than to deleted registrations.
		this.indexComplete = false;
		const summary = await indexer.scanAll();
		// Two scans can overlap (a rename during a scan). Only the newest owns the index;
		// an older one syncing a map the newer has already cleared would see an index
		// going backwards, with the same cancellations.
		if (generation !== this.scanGeneration) {
			return summary;
		}
		const result = await engine.sync(this.collectReminders());
		this.indexComplete = true;
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
		// The engine has to be told, or a line written while the app is running never
		// becomes a reminder: the map above is only what a *rescan* reads, so without
		// this the note would be parsed and then ignored until the next launch, rename
		// or delete.
		//
		// Not while the index is unknown, though. `scanAll` calls this per file as it
		// goes, and `engine.sync` treats what it is given as the *complete* index: the
		// first file of a launch would be the whole index, every record loaded from
		// disk would look departed, and each would be cancelled and its registration
		// withdrawn — for good, since a cancelled record is never resurrected. `rescan`
		// syncs the finished map itself; this path is for a single file changing.
		if (this.indexComplete) {
			// The order is the launch order: fire what has come due, then register or
			// withdraw — a fire that finds its registration still on the record reads it
			// to avoid publishing a second copy of the same due time.
			await engine.sync(this.collectReminders());
		}
		await this.tickNow();
		await this.syncServerSchedule();
	}

	/**
	 * Whether `remindersByPath` holds a complete index, i.e. whether a whole scan has
	 * finished and been synced. Until it does, an incremental change must not be
	 * turned into an engine sync: the map would be partial, and the engine reads it
	 * as the full set of reminders.
	 */
	private indexComplete = false;
	/** Incremented per scan, so an older overlapping scan cannot sync a newer one's map. */
	private scanGeneration = 0;

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

	/**
	 * One instance, one outcome: a fan-out reports success if any channel
	 * delivered. This is the fire path for a due time no registration covers, so
	 * the server-scheduled channel is included and the provider publishes the push
	 * now — clamped to its minimum delay — rather than never.
	 */
	private async deliverEverywhere(message: OutboundMessage): Promise<DeliveryResult> {
		return combinedResult(await this.registry.deliver(message, this.channelContext()));
	}

	/**
	 * The fire path for a due time the registration already covers: the channels
	 * that deliver without a server. `Test notification` still uses
	 * `deliverEverywhere`, because reaching each configured channel is its point.
	 */
	private async deliverLocally(message: OutboundMessage): Promise<DeliveryResult> {
		return combinedResult(await this.registry.deliverLocal(message, this.channelContext()));
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
		// A registered push is one the server is holding for this device; the count is
		// the same store the engine reads, so it survives a restart. A record can hold
		// one per server-scheduled channel, and a reminder that has already fired keeps
		// its entry — its line is still in the note — so only the ones still waiting to
		// be delivered are counted.
		const pending =
			this.engine
				?.snapshot()
				.filter((record) => (record.state === "scheduled" || record.state === "armed") && Object.keys(record.pushIds ?? {}).length > 0).length ?? 0;
		return `push scheduling: ${pass.sent.length} registered, ${pending} pending, ${pass.failed.length} failed, ${pass.deferred.length} deferred, ${pass.cleared.length} cleared`;
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

	/**
	 * The folder the resolver actually uses. This line read "(detected)" whenever the
	 * setting was empty, even when nothing had been detected — the case that leaves a
	 * device resolving no dated notes at all, with no other sign of it, because the
	 * configured formats are matched against the path relative to this folder.
	 */
	private dailyNotesSummary(): string {
		const folder = this.settings.dailyNotesFolder.trim();
		const format = this.dailyNotesFormat.trim();
		const formatText = format.length > 0 ? format : "(defaults)";
		return folder.length > 0
			? `daily notes folder ${folder}, format ${formatText}`
			: `daily notes folder not set and none detected: dated notes under a subfolder will not resolve. Set Daily notes folder. Format ${formatText}`;
	}

	diagnostics(): string {
		const engine = this.engine;
		const records = engine?.snapshot() ?? [];
		return [
			`Kairos ${this.manifest.version} on Obsidian ${this.app.vault.configDir},`,
			`device ${this.deviceId}, platform ${Platform.isMobileApp ? "mobile" : "desktop"}, tz ${this.tzId()},`,
			`records ${records.length}, channels ${this.registry.names().join(", ")},`,
			this.pushSummary(),
			this.dailyNotesSummary(),
		].join("\n");
	}

	async testNotification(): Promise<void> {
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
