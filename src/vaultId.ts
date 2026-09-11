import type { DataAdapter } from "obsidian";

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

/** The folder, normalised, with the documented default for an empty setting. */
function stateFolder(folder: string): string {
	const trimmed = folder.trim().replace(/^\/+|\/+$/gu, "");
	return trimmed.length > 0 ? trimmed : ".kairos";
}

/** The identity, or `""` when there is none to read. */
export async function readVaultId(adapter: DataAdapter, folder: string): Promise<string> {
	const path = `${stateFolder(folder)}/${VAULT_ID_FILE}`;
	try {
		if (!(await adapter.exists(path))) {
			return "";
		}
		return (await adapter.read(path)).trim();
	} catch {
		// An unreadable file is treated as absent; the caller writes a fresh one.
		return "";
	}
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
		const path = `${stateFolder(folder)}/${VAULT_ID_FILE}`;
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
