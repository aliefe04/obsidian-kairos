// @ts-check
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

/** Node globals used by the build, release and smoke tooling. */
const nodeToolingGlobals = {
	process: "readonly",
	console: "readonly",
	fetch: "readonly",
	WebSocket: "readonly",
	URL: "readonly",
	setTimeout: "readonly",
	clearTimeout: "readonly",
};

export default defineConfig([
	{
		ignores: ["main.js", "node_modules/**", ".testvault/**", "coverage/**"],
	},
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				// Files that are not part of tsconfig.json still need to be linted.
				projectService: {
					allowDefaultProject: ["eslint.config.mjs", "esbuild.config.mjs", "version-bump.mjs", "scripts/*.mjs"],
				},
			},
		},
	},
	{
		// Node-based tooling (build, smoke harness) legitimately uses node builtins,
		// node globals, raw fetch, and writes into a throwaway test vault that is not
		// an Obsidian vault at all. The plugin source is held to the strict rules.
		files: ["*.mjs", "scripts/**/*.mjs"],
		languageOptions: { globals: nodeToolingGlobals },
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
			"obsidianmd/hardcoded-config-path": "off",
			"obsidianmd/prefer-window-timers": "off",
			"no-restricted-globals": "off",
		},
	},
]);
