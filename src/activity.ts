/**
 * Activity indicator — single live-updating Telegram message showing what the agent is doing.
 *
 * Tool calls are recorded cheaply. The summarizer is only invoked when we're
 * actually about to edit the Telegram message, respecting rate limits.
 */

import type { TelegramClient } from "./telegram.js";
import type { Summarizer } from "./summarizer.js";

const MIN_EDIT_INTERVAL_MS = 3000;

export class ActivityFeed {
	private telegram: TelegramClient;
	private chatId: number;
	private summarizer: Summarizer | null;
	private messageId: number | null = null;
	private displayedText = "⏳ Thinking...";
	private lastEditTime = 0;
	private editTimer: ReturnType<typeof setTimeout> | null = null;

	// Latest tool call waiting to be described
	private latestTool: { name: string; args: Record<string, unknown> } | null = null;
	private dirty = false; // true if latestTool changed since last flush

	constructor(telegram: TelegramClient, chatId: number, summarizer: Summarizer | null) {
		this.telegram = telegram;
		this.chatId = chatId;
		this.summarizer = summarizer;
	}

	async start(): Promise<void> {
		this.displayedText = "⏳ Thinking...";
		this.messageId = null;
		this.lastEditTime = 0;
		this.latestTool = null;
		this.dirty = false;

		try {
			const result = await this.telegram.sendMessage(this.chatId, this.displayedText);
			if (result?.message_id) {
				this.messageId = result.message_id;
			}
		} catch {}
	}

	/** Set status text directly — no summarizer, edits immediately (rate-limited). */
	setStatus(text: string): void {
		this.dirty = false; // cancel any pending tool description
		this.displayedText = text;
		if (!this.messageId) return;

		const now = Date.now();
		if (now - this.lastEditTime >= MIN_EDIT_INTERVAL_MS) {
			this.lastEditTime = now;
			this.telegram.editMessage(this.chatId, this.messageId, text);
		}
	}

	/** Record a tool call. Cheap — no LLM call, no Telegram edit. */
	recordTool(toolName: string, args: Record<string, unknown>): void {
		this.latestTool = { name: toolName, args };
		this.dirty = true;
		this.scheduleFlush();
	}

	async stop(): Promise<void> {
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
		if (!this.messageId) return;

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
		// If timer already set, it will pick up the latest tool on fire
	}

	private flush(): void {
		if (!this.messageId || !this.dirty || !this.latestTool) return;
		if (this.telegram.rateLimitedUntil > Date.now()) return;

		const tool = this.latestTool;
		this.dirty = false;
		this.lastEditTime = Date.now();

		// Get description (async) then edit the message
		this.getDescription(tool.name, tool.args).then((text) => {
			if (!this.messageId) return;
			this.displayedText = text;
			this.telegram.editMessage(this.chatId, this.messageId, text);
		});
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
