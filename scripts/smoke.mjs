/**
 * Real Obsidian smoke harness.
 *
 * Builds the plugin, drops the bundle into a throwaway vault, launches the real
 * app with the Chrome DevTools Protocol open, and drives it over a WebSocket
 * built from Node's global fetch and WebSocket: no puppeteer, no dependencies.
 */

import { spawn } from "node:child_process";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname, "..");
const VAULT = join(ROOT, ".testvault");
const PROFILE = "/tmp/kairos-profile";
const PLUGIN_DIR = join(VAULT, ".obsidian", "plugins", "kairos");
const OBSIDIAN = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const CDP_PORT = 9333;

function stamp() {
	return new Date().toISOString().replace(/[:.]/gu, "-");
}

async function run(command, args, options = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", ...options });
		child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`))));
		child.on("error", reject);
	});
}

async function build() {
	await run("npm", ["run", "build"]);
	await mkdir(PLUGIN_DIR, { recursive: true });
	await cp(join(ROOT, "main.js"), join(PLUGIN_DIR, "main.js"));
	await cp(join(ROOT, "manifest.json"), join(PLUGIN_DIR, "manifest.json"));
	if (existsSync(join(ROOT, "styles.css"))) {
		await cp(join(ROOT, "styles.css"), join(PLUGIN_DIR, "styles.css"));
	}
}

async function prepareVault() {
	await mkdir(join(VAULT, ".obsidian"), { recursive: true });
	// Previous runs leave notes behind; a stale note is a legitimate catch-up
	// reminder on the next launch, which would make the exactly-once assertion
	// measure the wrong thing.
	await rm(join(VAULT, "journal"), { recursive: true, force: true });
	await writeFile(join(VAULT, ".obsidian", "community-plugins.json"), JSON.stringify(["kairos"], null, 2));
	await writeFile(join(VAULT, ".obsidian", "app.json"), "{}");
	await writeFile(
		join(VAULT, ".obsidian", "daily-notes.json"),
		JSON.stringify({ folder: "journal", format: "YYYY/DD-MM-YYYY-dddd", template: "" }, null, 2),
	);
}

async function prepareProfile() {
	await mkdir(PROFILE, { recursive: true });
	// Always point the profile at this vault, reusing whatever else is there.
	await writeFile(
		join(PROFILE, "obsidian.json"),
		JSON.stringify({ vaults: { kairos: { path: VAULT, ts: Date.now(), open: true } }, updateDisabledPlugins: false }, null, 2),
	);
}

class Cdp {
	constructor(socket) {
		this.socket = socket;
		this.nextId = 1;
		this.pending = new Map();
		socket.addEventListener("message", (event) => {
			const payload = JSON.parse(event.data);
			const entry = this.pending.get(payload.id);
			if (entry) {
				this.pending.delete(payload.id);
				entry(payload);
			}
		});
	}

	static async connect(url) {
		const socket = new WebSocket(url);
		await new Promise((resolvePromise, reject) => {
			socket.addEventListener("open", () => resolvePromise());
			socket.addEventListener("error", () => reject(new Error("cdp socket failed")));
		});
		return new Cdp(socket);
	}

	send(method, params = {}) {
		const id = this.nextId++;
		this.socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, 20000);
			this.pending.set(id, (payload) => {
				clearTimeout(timer);
				resolvePromise(payload);
			});
		});
	}

	async evaluate(expression) {
		const response = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		const result = response.result ?? {};
		if (result.exceptionDetails) {
			throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
		}
		return result.result ? result.result.value : undefined;
	}
}

async function waitForTarget() {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
			const targets = await response.json();
			const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
			if (page) {
				return page;
			}
		} catch {
			// Obsidian is still starting.
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
	}
	throw new Error("no devtools target appeared");
}

async function waitForPlugin(cdp) {
	for (let attempt = 0; attempt < 90; attempt += 1) {
		try {
			// The renderer defines `app` only partway through boot, so this probe
			// has to be exception-safe rather than strict.
			const ready = await cdp.evaluate(
				"typeof app !== 'undefined' && !!(app.plugins && app.plugins.plugins && app.plugins.plugins.kairos)",
			);
			if (ready === true) {
				return true;
			}
			if (attempt === 20) {
				// A brand-new vault can come up with community plugins disabled.
				await cdp.evaluate(
					"(async () => { if (typeof app !== 'undefined' && app.plugins?.setEnable) { await app.plugins.setEnable(true); } if (typeof app !== 'undefined' && app.plugins?.enablePlugin) { await app.plugins.enablePlugin('kairos'); } return true; })()",
				);
			}
		} catch {
			// Still booting.
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
	}
	return false;
}

async function main() {
	const report = { ok: false, steps: [] };
	await build();
	await prepareVault();
	await prepareProfile();
	await rm(join(VAULT, ".obsidian", "plugins", "kairos", "state"), { recursive: true, force: true });

	const child = spawn(OBSIDIAN, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`], { stdio: "ignore", detached: false });
	try {
		const target = await waitForTarget();
		const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
		await cdp.send("Runtime.enable");

		const loaded = await waitForPlugin(cdp);
		report.steps.push({ step: "plugin loaded in the real app", ok: loaded });
		if (!loaded) {
			throw new Error("the kairos plugin did not load");
		}

		const now = new Date();
		const pad = (value) => String(value).padStart(2, "0");
		const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
		// A reminder two minutes in the past exercises the path a user actually
		// hits most often: Obsidian was closed when the alert was due, so the
		// launch-time catch-up has to deliver it instead of dropping it.
		const past = new Date(now.getTime() - 2 * 60 * 1000);
		const wall = `${pad(past.getHours())}:${pad(past.getMinutes())}`;
		const iso = `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}`;
		// The note is named the way the vault's daily notes are named (folder and
		// `YYYY/DD-MM-YYYY-dddd` format from `.obsidian/daily-notes.json`) and the
		// body carries no H1 date, so the date-resolution path under test is the
		// production one rather than a spelling only the harness uses.
		const notePath = `journal/${past.getFullYear()}/${pad(past.getDate())}-${pad(past.getMonth() + 1)}-${past.getFullYear()}-${weekdays[past.getDay()]}.md`;
		const body = `- [ ] smoke test ${wall}\n`;
		const cachedItems = await cdp.evaluate(
			`(async () => {
				const path = ${JSON.stringify(notePath)};
				const folder = path.split("/").slice(0, -1).join("/");
				if (!(await app.vault.adapter.exists(folder))) { await app.vault.createFolder(folder); }
				const existing = app.vault.getAbstractFileByPath(path);
				if (existing) { await app.vault.modify(existing, ${JSON.stringify(body)}); }
				else { await app.vault.create(path, ${JSON.stringify(body)}); }
				// scanAll() skips any file whose cached metadata carries no list
				// items, so the checkbox has to be indexed before the rescan runs.
				const deadline = Date.now() + 10000;
				let cached = 0;
				for (;;) {
					const file = app.vault.getAbstractFileByPath(path);
					const cache = file ? app.metadataCache.getFileCache(file) : null;
					const items = cache && Array.isArray(cache.listItems) ? cache.listItems : [];
					if (items.some((item) => item && item.task !== undefined)) { cached = items.length; break; }
					if (Date.now() > deadline) { break; }
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				await app.plugins.plugins.kairos.rescan();
				await app.plugins.plugins.kairos.tickNow();
				return cached;
			})()`,
		);
		report.note = { path: notePath, body };
		report.noteCacheItems = cachedItems;
		report.steps.push({
			step: "daily note created through the vault API, indexed, rescanned, tick forced",
			ok: typeof cachedItems === "number" && cachedItems > 0,
		});

		const fired = await cdp.evaluate(`(async () => {
			const root = app.plugins.plugins.kairos.manifest.dir + "/state/fired";
			if (!(await app.vault.adapter.exists(root))) { return { lines: 0, matching: 0, last: null }; }
			const listing = await app.vault.adapter.list(root);
			const smokeNote = ${JSON.stringify(notePath)};
			let lines = 0;
			let matching = 0;
			let last = null;
			for (const file of listing.files) {
				const raw = await app.vault.adapter.read(file);
				for (const line of raw.split("\\n")) {
					if (line.trim().length === 0) { continue; }
					lines += 1;
					last = JSON.parse(line);
					if (String(last.sourcePath ?? "") === smokeNote) { matching += 1; }
				}
			}
			return { lines, matching, last };
		})()`);
		report.fired = fired;
		report.steps.push({ step: "the alert fired and was logged", ok: typeof fired.lines === "number" && fired.lines > 0 });
		// Exactly once is the whole point: a duplicate alert is the second most
		// common complaint in this market, and a loose `> 0` assertion cannot see it.
		report.steps.push({ step: "it fired exactly once", ok: fired.matching === 1 });
		const logged = fired.last ?? {};
		const scheduleMatched = String(logged.sourcePath ?? "") === notePath && logged.dueLocal === `${iso}T${wall}`;
		report.steps.push({ step: "the logged instance carries the parsed note date and bare time", ok: scheduleMatched });

		const noticeTexts = await cdp.evaluate(`Array.from(document.querySelectorAll(".notice")).map((el) => String(el.textContent || ""))`);
		const deliveryNotices = noticeTexts.filter((text) => text.includes("smoke test")).length;
		report.noticeTexts = noticeTexts;
		report.deliveryNotices = deliveryNotices;
		report.steps.push({ step: "exactly one delivery notice for the instance", ok: deliveryNotices === 1 });

		const allNotices = await cdp.evaluate(`(async () => {
			const plugin = app.plugins.plugins.kairos;
			if (typeof plugin.testNotification === "function") { await plugin.testNotification(); }
			await new Promise((resolve) => setTimeout(resolve, 800));
			return document.querySelectorAll(".notice").length;
		})()`);
		report.notices = allNotices;
		report.steps.push({ step: "the test-notification command renders a notice", ok: typeof allNotices === "number" && allNotices > deliveryNotices });

		report.ok = report.steps.every((entry) => entry.ok === true);
	} finally {
		child.kill("SIGTERM");
	}
	process.stdout.write(JSON.stringify(report, null, 2) + "\n");
	if (!report.ok) {
		process.exitCode = 1;
	}
	void stamp;
	void readdir;
}

main().catch((error) => {
	process.stderr.write(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }, null, 2) + "\n");
	process.exitCode = 1;
});
