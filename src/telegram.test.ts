import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { splitMessage, setLogLevel, log, debug, warn, error } from "./telegram.js";

describe("splitMessage", () => {
	it("returns single chunk for short message", () => {
		const result = splitMessage("hello", 100);
		expect(result).toEqual(["hello"]);
	});

	it("splits on newline boundary", () => {
		const msg = "line1\nline2\nline3\nline4";
		const result = splitMessage(msg, 12);
		expect(result.length).toBeGreaterThan(1);
		// Each chunk should be <= maxLen
		for (const chunk of result) {
			expect(chunk.length).toBeLessThanOrEqual(12);
		}
		// Rejoining should give back the original content
		expect(result.join("\n")).toBe(msg);
	});

	it("handles message exactly at limit", () => {
		const msg = "x".repeat(100);
		const result = splitMessage(msg, 100);
		expect(result).toEqual([msg]);
	});

	it("force-splits long lines without newlines", () => {
		const msg = "x".repeat(200);
		const result = splitMessage(msg, 50);
		expect(result.length).toBe(4);
		expect(result.join("")).toBe(msg);
	});
});

describe("logging", () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleSpy.mockRestore();
	});

	it("respects log level - debug hidden at info level", () => {
		setLogLevel("info");
		debug("should not appear");
		expect(consoleSpy).not.toHaveBeenCalled();
	});

	it("respects log level - debug shown at debug level", () => {
		setLogLevel("debug");
		debug("should appear");
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[DEBUG]"));
	});

	it("info shown at info level", () => {
		setLogLevel("info");
		log("hello");
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("hello"));
		// info has no tag
		expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining("[INFO]"));
	});

	it("warn shown at info level", () => {
		setLogLevel("info");
		warn("watch out");
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[WARN]"));
	});

	it("error shown at error level", () => {
		setLogLevel("error");
		error("bad");
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[ERROR]"));
	});

	it("warn hidden at error level", () => {
		setLogLevel("error");
		warn("should not appear");
		expect(consoleSpy).not.toHaveBeenCalled();
	});
});
