import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { splitMessage, extractLinkEntities, setLogLevel, log, debug, warn, error } from "./telegram.js";

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

describe("extractLinkEntities", () => {
	it("extracts a single markdown link", () => {
		const { text, entities } = extractLinkEntities("Click [here](https://example.com) now");
		expect(text).toBe("Click here now");
		expect(entities).toEqual([
			{ type: "text_link", offset: 6, length: 4, url: "https://example.com" },
		]);
	});

	it("extracts multiple links", () => {
		const { text, entities } = extractLinkEntities("[A](https://a.com) and [B](https://b.com)");
		expect(text).toBe("A and B");
		expect(entities).toEqual([
			{ type: "text_link", offset: 0, length: 1, url: "https://a.com" },
			{ type: "text_link", offset: 6, length: 1, url: "https://b.com" },
		]);
	});

	it("supports custom URL schemes", () => {
		const { text, entities } = extractLinkEntities("[Open](fantastical://show?date=2026-04-10)");
		expect(text).toBe("Open");
		expect(entities).toEqual([
			{ type: "text_link", offset: 0, length: 4, url: "fantastical://show?date=2026-04-10" },
		]);
	});

	it("returns original text and empty entities when no links", () => {
		const { text, entities } = extractLinkEntities("No links here");
		expect(text).toBe("No links here");
		expect(entities).toEqual([]);
	});

	it("handles link at end of text", () => {
		const { text, entities } = extractLinkEntities("See [docs](https://docs.com)");
		expect(text).toBe("See docs");
		expect(entities).toEqual([
			{ type: "text_link", offset: 4, length: 4, url: "https://docs.com" },
		]);
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
