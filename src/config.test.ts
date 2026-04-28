import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";

// We need to test loadConfig which reads from a fixed path.
// Mock fs to control what it reads.
vi.mock("node:fs");

describe("loadConfig", () => {

	beforeEach(() => {
		vi.resetModules();
		delete process.env.PI_TELEGRAM_BOT_CONFIG;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("exits if config file does not exist", async () => {
		vi.mocked(fs.existsSync).mockReturnValue(false);
		const mockExit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
		const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

		const { loadConfig } = await import("./config.js");

		expect(() => loadConfig()).toThrow("exit");
		expect(mockExit).toHaveBeenCalledWith(1);
		expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Config not found"));
	});

	it("parses a valid config with all fields", async () => {
		process.env.PI_TELEGRAM_BOT_CONFIG = "/config/pi-telegram-bot/config.yaml";
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(`
telegram:
  bot_token: "test-token-123"
  chat_id: 99999

pi:
  cwd: /tmp/test
  model: anthropic/claude-haiku-4-5
  session_dir: /tmp/sessions

log_level: debug
`);

		const { loadConfig } = await import("./config.js");
		const config = loadConfig();

		expect(fs.existsSync).toHaveBeenCalledWith("/config/pi-telegram-bot/config.yaml");
		expect(fs.readFileSync).toHaveBeenCalledWith("/config/pi-telegram-bot/config.yaml", "utf8");
		expect(config.telegram.bot_token).toBe("test-token-123");
		expect(config.telegram.chat_id).toBe(99999);
		expect(config.pi.cwd).toBe("/tmp/test");
		expect(config.pi.model).toBe("anthropic/claude-haiku-4-5");
		expect(config.pi.session_dir).toBe("/tmp/sessions");
		expect(config.log_level).toBe("debug");
	});

	it("applies defaults for optional fields", async () => {
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(`
telegram:
  bot_token: "tok"
`);

		const { loadConfig } = await import("./config.js");
		const config = loadConfig();

		expect(config.telegram.bot_token).toBe("tok");
		expect(config.telegram.chat_id).toBeUndefined();
		expect(config.pi.cwd).toBe(os.homedir());
		expect(config.pi.model).toBeUndefined();
		expect(config.pi.session_dir).toContain("pi-telegram-bot");
		expect(config.log_level).toBe("info");
	});

	it("exits if bot_token is missing", async () => {
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(`
telegram:
  chat_id: 123
`);
		const mockExit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
		vi.spyOn(console, "error").mockImplementation(() => {});

		const { loadConfig } = await import("./config.js");

		expect(() => loadConfig()).toThrow("exit");
		expect(mockExit).toHaveBeenCalledWith(1);
	});

	it("defaults invalid log_level to info", async () => {
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(`
telegram:
  bot_token: "tok"
log_level: banana
`);

		const { loadConfig } = await import("./config.js");
		const config = loadConfig();

		expect(config.log_level).toBe("info");
	});
});
