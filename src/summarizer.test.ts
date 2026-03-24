import { describe, it, expect } from "vitest";

// Test the exported helper functions via the module.
// The Summarizer class itself needs a pi subprocess so we test the fallback logic.

// We can't easily import private functions, so we'll test the fallback
// descriptions by importing the module and checking the Summarizer.describe
// fallback path (when summarizer is not running).

import { Summarizer } from "./summarizer.js";

describe("Summarizer", () => {
	it("returns fallback when not running", async () => {
		const s = new Summarizer();
		// Not started — should use fallback
		const result = await s.describe("read", { path: "/foo/bar/baz.ts" });
		expect(result).toContain("baz.ts");
	});

	it("returns fallback for bash without path", async () => {
		const s = new Summarizer();
		const result = await s.describe("bash", { command: "ls -la" });
		expect(result).toContain("Running");
	});

	it("returns fallback for write", async () => {
		const s = new Summarizer();
		const result = await s.describe("write", { path: "/tmp/output.json" });
		expect(result).toContain("output.json");
	});

	it("returns fallback for unknown tool", async () => {
		const s = new Summarizer();
		const result = await s.describe("mystery_tool", {});
		expect(result).toContain("Working");
	});
});
