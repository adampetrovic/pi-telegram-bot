import { describe, it, expect } from "vitest";
import { buildServiceRestartScript, isServiceRestartRequest } from "./restart.js";

describe("isServiceRestartRequest", () => {
	it("matches direct self-restart requests", () => {
		expect(isServiceRestartRequest("Restart pi telegram bot brew service")).toBe(true);
		expect(isServiceRestartRequest("please restart the pi-telegram-bot service")).toBe(true);
		expect(isServiceRestartRequest("Can you restart pi-telegram-bot launchd?")).toBe(true);
	});

	it("matches the explicit brew services command", () => {
		expect(isServiceRestartRequest("brew services restart pi-telegram-bot")).toBe(true);
		expect(isServiceRestartRequest("brew service restart pi telegram bot")).toBe(true);
	});

	it("does not match non-imperative restart discussion", () => {
		expect(isServiceRestartRequest("How do I restart pi-telegram-bot brew service?")).toBe(false);
		expect(isServiceRestartRequest("Document the pi-telegram-bot restart process")).toBe(false);
		expect(isServiceRestartRequest("Restart home assistant brew service")).toBe(false);
		expect(isServiceRestartRequest("restart the bot")).toBe(false);
	});
});

describe("buildServiceRestartScript", () => {
	it("prefers launchctl kickstart for an already-loaded Homebrew launchd job", () => {
		const script = buildServiceRestartScript();

		expect(script).toContain("launchctl kickstart -k");
		expect(script).toContain("homebrew.mxcl.pi-telegram-bot");
	});

	it("falls back to brew services restart", () => {
		const script = buildServiceRestartScript();

		expect(script).toContain("brew services restart pi-telegram-bot");
		expect(script).toContain("/opt/homebrew/bin/brew services restart pi-telegram-bot");
	});
});
