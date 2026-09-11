/**
 * The vault id is what makes two devices name the same reminder the same way.
 *
 * If it differs per device, so does every instance id derived from it, and a
 * reminder written on both sides becomes two entries in every channel that names
 * its registration after the instance — two tasks in Reminders for one line, each
 * device able to withdraw only its own. The value therefore lives in the vault,
 * which a vault sync carries to the other device, and not in `data.json`, which a
 * vault sync usually leaves behind inside `.obsidian`.
 */

import { describe, expect, it } from "vitest";
import { loadVaultId, readVaultId, VAULT_ID_FILE } from "../src/vaultId";
import { DEFAULT_VAULT_STATE_FOLDER } from "../src/schedule/stateStore";
import type { DataAdapter } from "obsidian";

/** An adapter over a Map: enough for `exists`, `read`, `write` and `mkdir`. */
function fakeAdapter(initial: Record<string, string> = {}): DataAdapter & { files: Map<string, string> } {
	const files = new Map(Object.entries(initial));
	const adapter = {
		files,
		exists: async (path: string) => files.has(path),
		read: async (path: string) => {
			const value = files.get(path);
			if (value === undefined) {
				throw new Error(`no such file: ${path}`);
			}
			return value;
		},
		write: async (path: string, data: string) => {
			files.set(path, data);
		},
		mkdir: async () => undefined,
	} as unknown as DataAdapter & { files: Map<string, string> };
	return adapter;
}

describe("the vault id", () => {
	it("prefers the vault's own id over this device's setting", async () => {
		// The phone case: it synced the vault, and its `data.json` still holds an id
		// minted for itself. The synced file has to win, or the two devices keep
		// writing separate copies of the same reminder.
		const adapter = fakeAdapter({ [`.kairos/${VAULT_ID_FILE}`]: "shared-vault-id\n" });
		const id = await loadVaultId(adapter, ".kairos", "this-device-id", () => "brand-new");
		expect(id).toBe("shared-vault-id");
	});

	it("finds the vault's id even when this device's setting names another folder", async () => {
		// The phone that has been running holds the old default in its own settings,
		// and plugin settings are not reliably synced. Missing the file the vault
		// already carries would mint a second identity — and so a second copy of
		// every reminder it writes.
		const adapter = fakeAdapter({ [`${DEFAULT_VAULT_STATE_FOLDER}/${VAULT_ID_FILE}`]: "shared\n" });
		const id = await loadVaultId(adapter, ".kairos", "stale-device-id", () => "brand-new");
		expect(id).toBe("shared");
		// And it does not write a second file for the folder its setting names.
		expect(adapter.files.has(`.kairos/${VAULT_ID_FILE}`)).toBe(false);
	});

	it("writes this device's existing id out rather than replacing it", async () => {
		// Migration. A vault already in use has state files and server registrations
		// named after its id; minting a new one would strand every one of them.
		const adapter = fakeAdapter();
		const id = await loadVaultId(adapter, ".kairos", "this-device-id", () => "brand-new");
		expect(id).toBe("this-device-id");
		expect(adapter.files.get(`.kairos/${VAULT_ID_FILE}`)?.trim()).toBe("this-device-id");
	});

	it("mints one for a fresh vault and records it where the other device will find it", async () => {
		const adapter = fakeAdapter();
		const id = await loadVaultId(adapter, ".kairos", "", () => "fresh-id");
		expect(id).toBe("fresh-id");
		// Read back the way the next launch (or the other device) will.
		expect(await readVaultId(adapter, ".kairos")).toBe("fresh-id");
	});

	it("reads the same id twice, so a restart does not rename every registration", async () => {
		const adapter = fakeAdapter();
		const first = await loadVaultId(adapter, ".kairos", "", () => "once");
		const second = await loadVaultId(adapter, ".kairos", "", () => "twice");
		expect(second).toBe(first);
	});

	it("still runs when the vault cannot be written", async () => {
		const adapter = fakeAdapter();
		adapter.write = async () => {
			throw new Error("read-only");
		};
		await expect(loadVaultId(adapter, ".kairos", "", () => "session-only")).resolves.toBe("session-only");
	});

	it("uses the documented folder when the setting is blank", async () => {
		// The same folder the state root uses: a device that reads the id from one
		// folder and writes its state to another mints a second identity.
		const adapter = fakeAdapter();
		await loadVaultId(adapter, "  ", "", () => "id");
		expect(adapter.files.has(`${DEFAULT_VAULT_STATE_FOLDER}/${VAULT_ID_FILE}`)).toBe(true);
	});
});
