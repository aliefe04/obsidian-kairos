/**
 * Vault index (docs/spec/state-model.md §6).
 *
 * Lists come from the metadata cache and text from cached reads; only notes that
 * already look like they carry checkboxes are read at all, and a full scan
 * yields between files so the UI never blocks.
 */

import type { App, CachedMetadata, TFile } from "obsidian";
import { parseNote, type ParseListItem, type ParseNoteResult, type ParseSettings, type ParsedReminder } from "../parse/parseNote";
import type { NoteHeading } from "../parse/noteDate";
import { getLocalePack } from "../parse/locales/index";
import type { Ymd } from "../parse/timeTokens";

export interface IndexerOptions {
	app: App;
	settings: () => ParseSettings;
	localeTag: () => string;
	tzId: () => string;
	today: () => Ymd;
	onFile: (path: string, reminders: ParsedReminder[], ambiguous: boolean) => void;
}

export interface ScanSummary {
	files: number;
	read: number;
	reminders: number;
	ambiguousNotes: string[];
}

const DEBOUNCE_MS = 300;
const YIELD_EVERY = 25;

export class VaultIndexer {
	private pending = new Map<string, number>();

	constructor(private readonly options: IndexerOptions) {}

	async loadDailyNotesConfig(): Promise<{ folder: string; format: string } | null> {
		const path = `${this.options.app.vault.configDir}/daily-notes.json`;
		try {
			if (!(await this.options.app.vault.adapter.exists(path))) {
				return null;
			}
			const raw = await this.options.app.vault.adapter.read(path);
			const parsed = JSON.parse(raw) as { folder?: unknown; format?: unknown };
			return {
				folder: typeof parsed.folder === "string" ? parsed.folder : "",
				format: typeof parsed.format === "string" ? parsed.format : "",
			};
		} catch {
			return null;
		}
	}

	async scanAll(): Promise<ScanSummary> {
		const summary: ScanSummary = { files: 0, read: 0, reminders: 0, ambiguousNotes: [] };
		const files = this.options.app.vault.getMarkdownFiles();
		let sinceYield = 0;
		for (const file of files) {
			summary.files += 1;
			const cache = this.options.app.metadataCache.getFileCache(file);
			if (!carriesCheckboxes(cache)) {
				continue;
			}
			summary.read += 1;
			const outcome = await this.processFile(file, cache);
			summary.reminders += outcome.reminders.length;
			if (outcome.ambiguous) {
				summary.ambiguousNotes.push(file.path);
			}
			sinceYield += 1;
			if (sinceYield >= YIELD_EVERY) {
				sinceYield = 0;
				await new Promise<void>((resolve) => {
					window.setTimeout(resolve, 0);
				});
			}
		}
		return summary;
	}

	scheduleFile(file: TFile): void {
		const existing = this.pending.get(file.path);
		if (existing !== undefined) {
			window.clearTimeout(existing);
		}
		const handle = window.setTimeout(() => {
			this.pending.delete(file.path);
			void this.processFile(file);
		}, DEBOUNCE_MS);
		this.pending.set(file.path, handle);
	}

	private async processFile(file: TFile, cached?: CachedMetadata | null): Promise<ParseNoteResult> {
		const cache = cached ?? this.options.app.metadataCache.getFileCache(file);
		if (!carriesCheckboxes(cache)) {
			return { reminders: [], ambiguous: false, dateSource: null };
		}
		const content = await this.options.app.vault.cachedRead(file);
		const settings = this.options.settings();
		const result = parseNote({
			path: file.path,
			content,
			frontmatter: cache?.frontmatter ?? null,
			headings: headingsOf(cache),
			listItems: listItemsOf(cache),
			settings,
			pack: getLocalePack(this.options.localeTag()),
			tzId: this.options.tzId(),
			today: this.options.today(),
		});
		this.options.onFile(file.path, result.reminders, result.ambiguous);
		return result;
	}
}

export function carriesCheckboxes(cache: CachedMetadata | null): boolean {
	if (!cache?.listItems) {
		return false;
	}
	return cache.listItems.some((item) => item.task !== undefined);
}

export function headingsOf(cache: CachedMetadata | null): NoteHeading[] {
	const headings = cache?.headings ?? [];
	return headings.map((heading) => ({ line: heading.position.start.line, level: heading.level, text: heading.heading }));
}

export function listItemsOf(cache: CachedMetadata | null): ParseListItem[] {
	const items = cache?.listItems ?? [];
	return items.map((item) => ({ line: item.position.start.line, status: item.task }));
}
