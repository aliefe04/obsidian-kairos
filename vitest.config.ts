import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			// The plugin's only runtime dependency is the Obsidian API, which cannot be
			// loaded headlessly. Tests import the stub so pure logic stays testable.
			obsidian: new URL("./tests/stubs/obsidian.ts", import.meta.url).pathname,
		},
	},
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
	},
});
