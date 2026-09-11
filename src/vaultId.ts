import type { DataAdapter } from "obsidian";
import { DEFAULT_VAULT_STATE_FOLDER, vaultStateFolderName } from "./schedule/stateStore";

/**
 * The vault's shared identity, kept in the vault rather than in each device.
 *
 * A reminder's instance id is derived from this value (plus the note's path, the
 * block id and the due time), so it is what makes two devices agree on the *name*
 * of a reminder. The value used to live in `data.json`, which sits inside
 * `.obsidian` — and a vault sync usually leaves that out — so a phone and a Mac
 * sharing one vault quietly derived different names for the same line. Every
 * channel that names a registration after the instance then held two of it: two
 * tasks in Reminders for one reminder, each device able to withdraw only its own.
 *
 * Kept in the vault, the file rides along with the notes, so both devices read the
 * same id and a PUT lands on the same resource.
 *
 * The value already in `data.json` wins the first time: a vault that has been
 * running has state files and server registrations named after it, and replacing
 * it would strand every one of them.
 */

/** The file name inside the vault's state folder. */
export const VAULT_ID_FILE = "vault-id";

/**
 * Every folder the identity may be in, most specific first.
 *
 * The configured folder is the one to use, but it is a *setting*, and a setting
 * is per device: a phone that has been running holds whatever default its own
 * `data.json` was written with, and whether a sync service carries plugin data
 * across is not something to rely on. Looking in the documented folder as well
 * means the identity a vault already holds is found even behind a stale setting —
 * whereas missing it would mint a second identity, and so a second copy of every
 * reminder, which is the failure the shared file exists to prevent.
 */
function candidates(folder: string): string[] {
	const configured = vaultStateFolderName(folder);
	return configured === DEFAULT_VAULT_STATE_FOLDER ? [configured] : [configured, DEFAULT_VAULT_STATE_FOLDER];
}

/** The identity, or `""` when there is none to read. */
export async function readVaultId(adapter: DataAdapter, folder: string): Promise<string> {
	for (const candidate of candidates(folder)) {
		try {
			const path = `${candidate}/${VAULT_ID_FILE}`;
			if (await adapter.exists(path)) {
				const value = (await adapter.read(path)).trim();
				if (value.length > 0) {
					return value;
				}
			}
		} catch {
			// An unreadable file is treated as absent; try the next folder, and let
			// the caller write a fresh one when none holds an id.
		}
	}
	return "";
}

/**
 * The vault id to run with: the one in the vault, or one written there now.
 *
 * `existing` is the per-device value from settings, used only when the vault has
 * none yet — that is the migration path, and it is why this returns the old value
 * rather than a new one for a vault that has already been in use.
 */
export async function loadVaultId(
	adapter: DataAdapter,
	folder: string,
	existing: string,
	createId: () => string,
): Promise<string> {
	const stored = await readVaultId(adapter, folder);
	if (stored.length > 0) {
		return stored;
	}
	const id = existing.trim().length > 0 ? existing.trim() : createId();
	try {
		const path = `${vaultStateFolderName(folder)}/${VAULT_ID_FILE}`;
		const dir = path.slice(0, path.lastIndexOf("/"));
		if (!(await adapter.exists(dir))) {
			await adapter.mkdir(dir);
		}
		await adapter.write(path, `${id}\n`);
	} catch {
		// A read-only vault still runs: the identity holds for this session, and the
		// next writable launch records it.
	}
	return id;
}
