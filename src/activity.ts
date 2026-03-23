/**
 * Activity feed — live-updating Telegram message showing what the agent is doing.
 */

import type { TelegramClient } from "./telegram.js";

const MIN_EDIT_INTERVAL_MS = 4000;

export class ActivityFeed {
	private telegram: TelegramClient;
	private chatId: number;
	private messageId: number | null = null;
	private lines: string[] = [];
	private lastEditTime = 0;
	private pendingEdit = false;
	private editTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(telegram: TelegramClient, chatId: number) {
		this.telegram = telegram;
		this.chatId = chatId;
	}

	async start(): Promise<void> {
		this.lines = [];
		this.messageId = null;
		this.lastEditTime = 0;
		this.pendingEdit = false;

		try {
			const result = await this.telegram.sendMessage(this.chatId, "⏳ Thinking...");
			if (result?.message_id) {
				this.messageId = result.message_id;
			}
		} catch {}
	}

	push(line: string): void {
		this.lines.push(line);
		this.scheduleEdit();
	}

	async stop(): Promise<void> {
		if (this.editTimer) {
			clearTimeout(this.editTimer);
			this.editTimer = null;
		}
		this.pendingEdit = false;

		if (this.messageId) {
			await this.telegram.deleteMessage(this.chatId, this.messageId);
			this.messageId = null;
		}
		this.lines = [];
	}

	private scheduleEdit(): void {
		if (!this.messageId) return;

		const now = Date.now();
		const elapsed = now - this.lastEditTime;

		if (elapsed >= MIN_EDIT_INTERVAL_MS) {
			this.flush();
		} else if (!this.pendingEdit) {
			this.pendingEdit = true;
			this.editTimer = setTimeout(() => {
				this.pendingEdit = false;
				this.flush();
			}, MIN_EDIT_INTERVAL_MS - elapsed);
		}
	}

	private flush(): void {
		if (!this.messageId) return;
		if (this.telegram.rateLimitedUntil > Date.now()) return;

		this.lastEditTime = Date.now();
		const text = this.buildText();
		this.telegram.editMessage(this.chatId, this.messageId, text);
	}

	private buildText(): string {
		if (this.lines.length === 0) return "⏳ Thinking...";

		const display = this.lines.slice(-6);
		const out: string[] = [];

		for (let i = 0; i < display.length; i++) {
			const isLast = i === display.length - 1;
			out.push(isLast ? `▶ ${display[i]}` : `✓ ${display[i]}`);
		}

		if (this.lines.length > 6) {
			const hidden = this.lines.length - 6;
			out.unshift(`…${hidden} earlier step${hidden > 1 ? "s" : ""}`);
		}

		return out.join("\n");
	}
}

// ── Tool action formatting ────────────────────────────────────────

export function formatToolAction(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "Read":
		case "read":
			return `📖 Reading ${friendlyPath(args?.path as string)}`;
		case "Bash":
		case "bash":
			return `⚙️ ${describeBash(String(args?.command || ""))}`;
		case "Edit":
		case "edit":
			return `✏️ Editing ${friendlyPath(args?.path as string)}`;
		case "Write":
		case "write":
			return `📝 Writing ${friendlyPath(args?.path as string)}`;
		case "todo":
			return `📋 Todo: ${args?.action || "managing"}`;
		default:
			return `🔧 ${toolName}`;
	}
}

function friendlyPath(p?: string): string {
	if (!p) return "file";
	const parts = p.split("/").filter(Boolean);
	return `\`${parts[parts.length - 1] || p}\``;
}

function describeBash(cmd: string): string {
	const cleaned = cmd
		.replace(/^cd\s+[^\s;&&]+\s*[;&|]+\s*/g, "")
		.replace(/^eval\s+"\$\(mise\s+env[^)]*\)"\s*[;&|]+\s*/g, "")
		.replace(/^\s*export\s+\S+\s*[;&|]+\s*/g, "")
		.trim();

	const patterns: [RegExp, string | ((m: RegExpMatchArray) => string)][] = [
		[/^kubectl\s+get\s+(\S+)/, (m) => `Checking ${m[1]}`],
		[/^kubectl\s+apply/, "Applying manifest"],
		[/^kubectl\s+exec/, "Running on cluster"],
		[/^flux\s+/, "Flux operation"],
		[/^grep\s+-r/, "Searching files"],
		[/^find\s+/, "Finding files"],
		[/^ls\s+/, "Listing directory"],
		[/^cat\s+/, "Reading file"],
		[/^git\s+(\w+)/, (m) => `Git ${m[1]}`],
		[/^jj\s+/, "Running jj"],
		[/^go\s+(build|test|run)/, (m) => `Go ${m[1]}`],
		[/^npm\s+/, "Running npm"],
		[/^docker\s+/, "Docker operation"],
		[/ha-deploy/, "Deploying to HA"],
		[/mosquitto/, "MQTT operation"],
	];

	for (const [pattern, result] of patterns) {
		const match = cleaned.match(pattern);
		if (match) return typeof result === "function" ? result(match) : result;
	}

	const short = cleaned.length > 50 ? cleaned.slice(0, 47) + "..." : cleaned;
	return `Running \`${short}\``;
}
