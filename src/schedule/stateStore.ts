/**
 * Real state store (docs/spec/state-model.md §4).
 *
 * One writer per file:
 *   state/instances/<instanceId>.json       created once, then rewritten atomically
 *   state/acks/<instanceId>.<deviceId>.json create-only, never rewritten
 *   state/lease/<instanceId>.json           the only contended file
 *   state/fired/<deviceId>-<yyyymmdd>.jsonl append-only, per device
 *   state/devices/<deviceId>.json           heartbeat
 */

import type { DataAdapter } from "obsidian";
import type { AckRecord, DeviceInfo, FiredRecord, Lease, ReminderRecord, StateStore } from "./engine";
import { dateStamp } from "./time";

export interface StateRootOptions {
	stateLocation: "plugin-dir" | "vault-folder";
	pluginDir: string;
	vaultStateFolder: string;
}

/**
 * The folder state and the vault id live in, when they live in the vault.
 *
 * Visible on purpose: sync tools commonly skip dot-folders, and this folder is
 * exactly what has to reach the other device for two devices on one vault to
 * share one registration bookkeeping. Kept in one place because the state root,
 * the vault id and the setting's default all have to name the same folder — a
 * device that looks in one and writes to another mints a second identity and
 * duplicates every reminder it writes.
 */
export const DEFAULT_VAULT_STATE_FOLDER = "kairos";

/** The configured folder name, normalised, with the documented default for a blank one. */
export function vaultStateFolderName(folder: string): string {
	const trimmed = folder.trim().replace(/^\/+|\/+$/gu, "");
	return trimmed.length > 0 ? trimmed : DEFAULT_VAULT_STATE_FOLDER;
}

/** Plugin-dir state lives beside data.json; vault-folder state is visible to other sync tools. */
export function stateRoot(options: StateRootOptions): string {
	if (options.stateLocation === "vault-folder") {
		return `${vaultStateFolderName(options.vaultStateFolder)}/state`;
	}
	return `${options.pluginDir.replace(/\/+$/u, "")}/state`;
}

export class FileStateStore implements StateStore {
	constructor(
		private readonly adapter: DataAdapter,
		private readonly root: string,
		private readonly deviceId: string,
		private readonly tzId: string,
	) {}

	private path(...parts: string[]): string {
		return [this.root.replace(/\/+$/u, ""), ...parts].join("/");
	}

	private async ensureDir(directory: string): Promise<void> {
		try {
			await this.adapter.mkdir(directory);
		} catch {
			// Already present, or the adapter cannot create folders; a failing write
			// reports the real problem.
		}
	}

	private async readJson<T>(path: string): Promise<T | null> {
		try {
			if (!(await this.adapter.exists(path))) {
				return null;
			}
			return JSON.parse(await this.adapter.read(path)) as T;
		} catch {
			return null;
		}
	}

	/** Write a temporary neighbour, then rename: a reader never sees half a file. */
	private async writeAtomic(path: string, data: string): Promise<void> {
		await this.ensureDir(path.split("/").slice(0, -1).join("/"));
		const temporary = `${path}.tmp`;
		await this.adapter.write(temporary, data);
		try {
			await this.adapter.rename(temporary, path);
		} catch {
			await this.adapter.write(path, data);
			try {
				await this.adapter.remove(temporary);
			} catch {
				// A leftover temp file is harmless.
			}
		}
	}

	async readInstances(): Promise<ReminderRecord[]> {
		const records: ReminderRecord[] = [];
		try {
			const listing = await this.adapter.list(this.path("instances"));
			for (const file of listing.files) {
				if (!file.endsWith(".json")) {
					continue;
				}
				const record = await this.readJson<ReminderRecord>(file);
				if (record && typeof record.instanceId === "string" && typeof record.dueLocal === "string") {
					records.push(record);
				}
			}
		} catch {
			return records;
		}
		return records;
	}

	async writeInstance(record: ReminderRecord): Promise<void> {
		await this.writeAtomic(this.path("instances", `${record.instanceId}.json`), JSON.stringify(record));
	}

	async readAcks(): Promise<AckRecord[]> {
		const acks: AckRecord[] = [];
		try {
			const listing = await this.adapter.list(this.path("acks"));
			for (const file of listing.files) {
				if (!file.endsWith(".json")) {
					continue;
				}
				const ack = await this.readJson<AckRecord>(file);
				if (ack && typeof ack.instanceId === "string") {
					acks.push(ack);
				}
			}
		} catch {
			return acks;
		}
		return acks;
	}

	/** Create-only: last-writer-wins is safe because the file is never rewritten. */
	async writeAck(record: AckRecord): Promise<void> {
		const path = this.path("acks", `${record.instanceId}.${record.deviceId}.json`);
		if (await this.adapter.exists(path)) {
			return;
		}
		await this.writeAtomic(path, JSON.stringify(record));
	}

	async readFired(): Promise<FiredRecord[]> {
		const entries: FiredRecord[] = [];
		try {
			const listing = await this.adapter.list(this.path("fired"));
			const prefix = `${this.deviceId}-`;
			for (const file of listing.files) {
				const name = file.split("/").pop() ?? "";
				if (!name.startsWith(prefix) || !name.endsWith(".jsonl")) {
					continue;
				}
				const raw = await this.adapter.read(file);
				for (const line of raw.split("\n")) {
					if (line.trim().length === 0) {
						continue;
					}
					try {
						const entry = JSON.parse(line) as FiredRecord;
						if (typeof entry.instanceId === "string") {
							entries.push(entry);
						}
					} catch {
						// A torn last line is expected in an append-only log.
					}
				}
			}
		} catch {
			return entries;
		}
		return entries;
	}

	async appendFired(record: FiredRecord): Promise<void> {
		const path = this.path("fired", `${this.deviceId}-${dateStamp(record.firedAt, this.tzId)}.jsonl`);
		await this.ensureDir(this.path("fired"));
		try {
			await this.adapter.append(path, `${JSON.stringify(record)}\n`);
		} catch {
			await this.adapter.write(path, `${JSON.stringify(record)}\n`);
		}
	}

	async readLease(instanceId: string): Promise<Lease | null> {
		return this.readJson<Lease>(this.path("lease", `${instanceId}.json`));
	}

	/** Returns false when another device already holds a create-only lease. */
	async writeLease(instanceId: string, lease: Lease, options: { createOnly: boolean }): Promise<boolean> {
		const path = this.path("lease", `${instanceId}.json`);
		if (options.createOnly && (await this.adapter.exists(path))) {
			const existing = await this.readJson<Lease>(path);
			return existing !== null && existing.deviceId === lease.deviceId;
		}
		await this.writeAtomic(path, JSON.stringify(lease));
		return true;
	}

	async writeDevice(info: DeviceInfo): Promise<void> {
		await this.writeAtomic(this.path("devices", `${info.deviceId}.json`), JSON.stringify(info));
	}
}
