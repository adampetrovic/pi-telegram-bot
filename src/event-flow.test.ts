/**
 * Tests for the event flow logic: suppress flag, activity feed lifecycle,
 * and the race between suppressed agent_end and the next agent_start.
 *
 * These test the handlePiEvent / handleAgentEnd interaction pattern
 * extracted into a minimal harness that mirrors index.ts behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActivityFeed } from "./activity.js";
import type { TelegramClient } from "./telegram.js";

function mockTelegram(): TelegramClient {
	return {
		sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
		editMessage: vi.fn().mockResolvedValue(undefined),
		deleteMessage: vi.fn().mockResolvedValue(undefined),
		sendChatAction: vi.fn().mockResolvedValue(undefined),
		sendLong: vi.fn().mockResolvedValue(undefined),
		rateLimitedUntil: 0,
	} as unknown as TelegramClient;
}

/**
 * Minimal harness that mirrors the event handling logic in index.ts.
 * This lets us test the suppress/activity feed interaction without
 * needing the full pi RPC subprocess.
 */
class EventFlowHarness {
	telegram: TelegramClient;
	activityFeed: ActivityFeed | null = null;
	suppressNextResponse = false;
	chatId = 123;
	agentEndMessages: string[] = [];

	constructor(telegram: TelegramClient) {
		this.telegram = telegram;
	}

	handleEvent(type: string, extra?: Record<string, unknown>): void {
		switch (type) {
			case "agent_start":
				if (!this.suppressNextResponse) {
					this.activityFeed = new ActivityFeed(this.telegram, this.chatId, null);
					this.activityFeed.start();
				}
				break;

			case "tool_execution_start":
				this.activityFeed?.recordTool(
					(extra?.toolName as string) || "bash",
					(extra?.args as Record<string, unknown>) || {},
				);
				break;

			case "agent_end":
				this.handleAgentEnd();
				break;
		}
	}

	private async handleAgentEnd(): Promise<void> {
		const suppress = this.suppressNextResponse;
		this.suppressNextResponse = false;

		if (suppress) return;

		// Simulate the sleep(500) from index.ts
		await new Promise((r) => setTimeout(r, 500));

		if (this.activityFeed) {
			await this.activityFeed.stop();
			this.activityFeed = null;
		}

		this.agentEndMessages.push("delivered");
	}
}

describe("Event flow: suppress and activity feed lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("suppressed agent_end does not clear activityFeed created by next agent_start", async () => {
		const tg = mockTelegram();
		const harness = new EventFlowHarness(tg);

		// Phase 1: format instructions (suppressed)
		harness.suppressNextResponse = true;
		harness.handleEvent("agent_start"); // suppressed — no feed created
		expect(harness.activityFeed).toBeNull();

		harness.handleEvent("agent_end"); // suppressed — returns early

		// Phase 2: user prompt — fires immediately after
		harness.handleEvent("agent_start"); // NOT suppressed — feed created
		expect(harness.activityFeed).not.toBeNull();
		const userFeed = harness.activityFeed;

		// Let start() settle
		await vi.advanceTimersByTimeAsync(0);

		// Tool arrives
		harness.handleEvent("tool_execution_start", {
			toolName: "read",
			args: { path: "/test.ts" },
		});

		// Advance past any sleep in the suppressed handleAgentEnd
		await vi.advanceTimersByTimeAsync(1000);

		// The user's activity feed should still be alive
		expect(harness.activityFeed).toBe(userFeed);
		expect(tg.deleteMessage).not.toHaveBeenCalled();
	});

	it("non-suppressed agent_end cleans up activity feed after sleep", async () => {
		const tg = mockTelegram();
		const harness = new EventFlowHarness(tg);

		// Normal flow — no suppression
		harness.handleEvent("agent_start");
		expect(harness.activityFeed).not.toBeNull();

		await vi.advanceTimersByTimeAsync(0); // let start() settle

		harness.handleEvent("agent_end");

		// Feed still exists before sleep completes
		expect(harness.activityFeed).not.toBeNull();

		// After sleep(500)
		await vi.advanceTimersByTimeAsync(500);

		expect(harness.activityFeed).toBeNull();
		expect(tg.deleteMessage).toHaveBeenCalled();
		expect(harness.agentEndMessages).toEqual(["delivered"]);
	});

	it("rapid suppress→start→tool→end sequence works correctly", async () => {
		const tg = mockTelegram();
		const harness = new EventFlowHarness(tg);

		// Suppressed init
		harness.suppressNextResponse = true;
		harness.handleEvent("agent_start");
		harness.handleEvent("agent_end");

		// User prompt
		harness.handleEvent("agent_start");
		await vi.advanceTimersByTimeAsync(0);

		harness.handleEvent("tool_execution_start", {
			toolName: "bash",
			args: { command: "ls" },
		});
		harness.handleEvent("tool_execution_start", {
			toolName: "read",
			args: { path: "/foo.ts" },
		});

		// Activity feed should still be alive
		expect(harness.activityFeed).not.toBeNull();

		// Now the real agent_end
		harness.handleEvent("agent_end");
		await vi.advanceTimersByTimeAsync(500);

		expect(harness.activityFeed).toBeNull();
		expect(tg.deleteMessage).toHaveBeenCalledTimes(1);
		expect(harness.agentEndMessages).toEqual(["delivered"]);
	});

	it("suppressed agent_end does not deliver response to user", async () => {
		const tg = mockTelegram();
		const harness = new EventFlowHarness(tg);

		harness.suppressNextResponse = true;
		harness.handleEvent("agent_start");
		harness.handleEvent("agent_end");

		await vi.advanceTimersByTimeAsync(1000);

		expect(harness.agentEndMessages).toEqual([]);
	});
});
