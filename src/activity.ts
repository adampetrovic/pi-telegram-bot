/**
 * Activity indicator — single live-updating Telegram message showing what the agent is doing.
 *
 * Tool calls are recorded cheaply. The summarizer is only invoked when we're
 * actually about to edit the Telegram message, respecting rate limits.
 */

import type { TelegramClient } from "./telegram.js";
import type { Summarizer } from "./summarizer.js";
import { debug } from "./telegram.js";

const MIN_EDIT_INTERVAL_MS = 3000;

export class ActivityFeed {
	private telegram: TelegramClient;
	private chatId: number;
	private summarizer: Summarizer | null;
	private messageId: number | null = null;
	private lastEditTime = 0;
	private editTimer: ReturnType<typeof setTimeout> | null = null;
	private typingTimer: ReturnType<typeof setInterval> | null = null;
	private describing = false; // true while waiting for summarizer

	// Latest tool call waiting to be described
	private latestTool: { name: string; args: Record<string, unknown> } | null = null;

	constructor(telegram: TelegramClient, chatId: number, summarizer: Summarizer | null) {
		this.telegram = telegram;
		this.chatId = chatId;
		this.summarizer = summarizer;
	}

	async start(): Promise<void> {
		this.messageId = null;
		this.lastEditTime = 0;
		this.latestTool = null;
		this.describing = false;

		try {
			const result = await this.telegram.sendMessage(this.chatId, "⏳ Thinking...");
			if (result?.message_id) {
				this.messageId = result.message_id;
			}
		} catch { /* ignored */ }

		// Keep typing indicator alive (expires after 5s)
		this.telegram.sendChatAction(this.chatId).catch(() => {});
		this.typingTimer = setInterval(() => {
			this.telegram.sendChatAction(this.chatId).catch(() => {});
		}, 4000);
	}

	/** Set status text directly — no summarizer, edits immediately (rate-limited). */
	setStatus(text: string): void {
		this.latestTool = null;
		this.doEdit(text);
	}

	/** Record a tool call. Cheap — no LLM call, no Telegram edit yet. */
	recordTool(toolName: string, args: Record<string, unknown>): void {
		debug(`activity: recordTool ${toolName}`);
		this.latestTool = { name: toolName, args };
		this.scheduleFlush();
	}

	async stop(): Promise<void> {
		if (this.typingTimer) {
			clearInterval(this.typingTimer);
			this.typingTimer = null;
		}
		if (this.editTimer) {
			clearTimeout(this.editTimer);
			this.editTimer = null;
		}

		if (this.messageId) {
			await this.telegram.deleteMessage(this.chatId, this.messageId);
			this.messageId = null;
		}
	}

	private scheduleFlush(): void {
		if (!this.messageId || this.describing) return;

		const now = Date.now();
		const elapsed = now - this.lastEditTime;

		if (elapsed >= MIN_EDIT_INTERVAL_MS) {
			this.flush();
		} else if (!this.editTimer) {
			this.editTimer = setTimeout(() => {
				this.editTimer = null;
				this.flush();
			}, MIN_EDIT_INTERVAL_MS - elapsed);
		}
	}

	private flush(): void {
		if (!this.messageId || !this.latestTool) {
			debug(`activity: flush skipped (messageId=${!!this.messageId}, latestTool=${!!this.latestTool})`);
			return;
		}
		if (this.telegram.rateLimitedUntil > Date.now()) {
			debug("activity: flush skipped (rate limited)");
			return;
		}

		const tool = this.latestTool;
		this.latestTool = null;
		this.describing = true;
		debug(`activity: flush → describing ${tool.name}`);

		this.getDescription(tool.name, tool.args)
			.then((text) => {
				this.describing = false;
				debug(`activity: described as "${text}"`);
				this.doEdit(text);
				if (this.latestTool) this.scheduleFlush();
			})
			.catch((e) => {
				this.describing = false;
				debug(`activity: describe failed: ${e}`);
				if (this.latestTool) this.scheduleFlush();
			});
	}

	private doEdit(text: string): void {
		if (!this.messageId) return;
		this.lastEditTime = Date.now();
		this.telegram.editMessage(this.chatId, this.messageId, text);
	}

	private async getDescription(toolName: string, args: Record<string, unknown>): Promise<string> {
		if (this.summarizer?.isRunning) {
			try {
				return await this.summarizer.describe(toolName, args);
			} catch {
				// Fall through to fallback
			}
		}
		return fallbackDescription(toolName, args);
	}
}

function fallbackDescription(toolName: string, args: Record<string, unknown>): string {
	const p = args?.path as string;
	const name = p ? p.split("/").filter(Boolean).pop() || "file" : "file";
	switch (toolName.toLowerCase()) {
		case "read": return `📖 Reading ${name}`;
		case "bash": return "⚙️ Running a command";
		case "edit": return `✏️ Editing ${name}`;
		case "write": return `📝 Writing ${name}`;
		default: return "🔧 Working...";
	}
}
