import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActivityFeed } from "./activity.js";
import type { TelegramClient } from "./telegram.js";

function mockTelegram(): TelegramClient {
	return {
		sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
		editMessage: vi.fn().mockResolvedValue(undefined),
		deleteMessage: vi.fn().mockResolvedValue(undefined),
		sendChatAction: vi.fn().mockResolvedValue(undefined),
		rateLimitedUntil: 0,
	} as unknown as TelegramClient;
}

/** start() is sync but kicks off an async init. Flush microtasks to let it complete. */
async function startAndSettle(feed: ActivityFeed): Promise<void> {
	feed.start();
	await vi.advanceTimersByTimeAsync(0);
}

describe("ActivityFeed", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("sends initial thinking message on start", async () => {
		const tg = mockTelegram();
		const feed = new ActivityFeed(tg, 123, null);
		await startAndSettle(feed);

		expect(tg.sendMessage).toHaveBeenCalledWith(123, "⏳ Thinking...");
	});

	it("starts typing indicator on start", async () => {
		const tg = mockTelegram();
		const feed = new ActivityFeed(tg, 123, null);
		await startAndSettle(feed);

		expect(tg.sendChatAction).toHaveBeenCalledWith(123);
	});

	it("deletes message on stop", async () => {
		const tg = mockTelegram();
		const feed = new ActivityFeed(tg, 123, null);
		await startAndSettle(feed);
		await feed.stop();

		expect(tg.deleteMessage).toHaveBeenCalledWith(123, 42);
	});

	it("clears typing timer on stop", async () => {
		const tg = mockTelegram();
		const feed = new ActivityFeed(tg, 123, null);
		await startAndSettle(feed);
		await feed.stop();

		const callCount = (tg.sendChatAction as ReturnType<typeof vi.fn>).mock.calls.length;
		vi.advanceTimersByTime(10000);
		expect((tg.sendChatAction as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCount);
	});

	it("uses fallback description when no summarizer", async () => {
		const tg = mockTelegram();
		const feed = new ActivityFeed(tg, 123, null);
		await startAndSettle(feed);

		feed.recordTool("read", { path: "/foo/bar/config.yaml" });
		await vi.advanceTimersByTimeAsync(0);

		expect(tg.editMessage).toHaveBeenCalledWith(123, 42, expect.stringContaining("config.yaml"));
	});

	it("rate-limits edits to MIN_EDIT_INTERVAL_MS", async () => {
		const tg = mockTelegram();
		const feed = new ActivityFeed(tg, 123, null);
		await startAndSettle(feed);

		feed.recordTool("read", { path: "/a.ts" });
		await vi.advanceTimersByTimeAsync(0);
		expect(tg.editMessage).toHaveBeenCalledTimes(1);

		// Second tool immediately after — should be deferred
		feed.recordTool("write", { path: "/b.ts" });
		await vi.advanceTimersByTimeAsync(0);
		expect(tg.editMessage).toHaveBeenCalledTimes(1);

		// Advance past the rate limit
		await vi.advanceTimersByTimeAsync(3000);
		expect(tg.editMessage).toHaveBeenCalledTimes(2);
		expect(tg.editMessage).toHaveBeenLastCalledWith(123, 42, expect.stringContaining("b.ts"));
	});

	it("handles tools arriving before start() completes", async () => {
		const tg = mockTelegram();
		// Slow sendMessage — simulates Telegram latency
		(tg.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
			() => new Promise((resolve) => setTimeout(() => resolve({ message_id: 42 }), 500)),
		);

		const feed = new ActivityFeed(tg, 123, null);
		feed.start();

		// Tool arrives before start() resolves
		feed.recordTool("bash", { command: "ls -la" });

		// start() hasn't finished yet — no edit should happen
		await vi.advanceTimersByTimeAsync(0);
		expect(tg.editMessage).not.toHaveBeenCalled();

		// Let start() complete
		await vi.advanceTimersByTimeAsync(500);

		// Now the buffered tool should flush
		await vi.advanceTimersByTimeAsync(0);
		expect(tg.editMessage).toHaveBeenCalledTimes(1);
		expect(tg.editMessage).toHaveBeenCalledWith(123, 42, expect.stringContaining("Running"));
	});

	it("only keeps the latest tool when multiple arrive before flush", async () => {
		const tg = mockTelegram();
		const feed = new ActivityFeed(tg, 123, null);
		await startAndSettle(feed);

		feed.recordTool("read", { path: "/first.ts" });
		await vi.advanceTimersByTimeAsync(0);
		expect(tg.editMessage).toHaveBeenCalledTimes(1);

		// Rapid-fire tools within rate limit window
		feed.recordTool("edit", { path: "/second.ts" });
		feed.recordTool("write", { path: "/third.ts" });

		await vi.advanceTimersByTimeAsync(3000);
		expect(tg.editMessage).toHaveBeenCalledTimes(2);
		expect(tg.editMessage).toHaveBeenLastCalledWith(123, 42, expect.stringContaining("third.ts"));
	});

	it("setStatus edits immediately bypassing summarizer", async () => {
		const tg = mockTelegram();
		const feed = new ActivityFeed(tg, 123, null);
		await startAndSettle(feed);

		feed.setStatus("🗜️ Compacting context...");

		expect(tg.editMessage).toHaveBeenCalledWith(123, 42, "🗜️ Compacting context...");
	});

	// ── stop() awaits start() ─────────────────────────────────────

	it("stop() waits for start() to finish before deleting", async () => {
		const tg = mockTelegram();
		(tg.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
			() => new Promise((resolve) => setTimeout(() => resolve({ message_id: 99 }), 1000)),
		);

		const feed = new ActivityFeed(tg, 123, null);
		feed.start();

		// Call stop immediately — start() hasn't finished
		const stopPromise = feed.stop();

		// deleteMessage should NOT have been called yet
		expect(tg.deleteMessage).not.toHaveBeenCalled();

		// Let start() complete
		await vi.advanceTimersByTimeAsync(1000);
		await stopPromise;

		// Now delete should have been called with the correct messageId
		expect(tg.deleteMessage).toHaveBeenCalledWith(123, 99);
	});

	it("stop() still works if start() sendMessage fails", async () => {
		const tg = mockTelegram();
		(tg.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network"));

		const feed = new ActivityFeed(tg, 123, null);
		feed.start();
		await vi.advanceTimersByTimeAsync(0);

		// stop() should not throw even though start() failed
		await feed.stop();

		// No messageId, so deleteMessage shouldn't be called
		expect(tg.deleteMessage).not.toHaveBeenCalled();
	});

	it("agent_end race: stop() deletes message even when called before start() resolves", async () => {
		const tg = mockTelegram();
		// Simulate realistic Telegram latency
		(tg.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
			() => new Promise((resolve) => setTimeout(() => resolve({ message_id: 77 }), 200)),
		);

		const feed = new ActivityFeed(tg, 123, null);
		feed.start();

		// Tool arrives during init
		feed.recordTool("read", { path: "/test.ts" });

		// agent_end fires 100ms later — before start() finishes
		await vi.advanceTimersByTimeAsync(100);
		const stopPromise = feed.stop();

		// Let everything settle
		await vi.advanceTimersByTimeAsync(200);
		await stopPromise;

		// Message should have been created and then deleted
		expect(tg.sendMessage).toHaveBeenCalledTimes(1);
		expect(tg.deleteMessage).toHaveBeenCalledWith(123, 77);
	});
});
