/**
 * Telegram Bot API client — raw HTTPS, no dependencies.
 */

import * as https from "node:https";
import * as fs from "node:fs";

import type { LogLevel } from "./config.js";

const TELEGRAM_API = "https://api.telegram.org/bot";

export class TelegramClient {
	private token: string;
	public botUsername = "";
	public rateLimitedUntil = 0;

	constructor(token: string) {
		this.token = token;
	}

	async init(): Promise<void> {
		const me = await this.api("getMe");
		this.botUsername = me.username;

		await this.api("setMyCommands", {
			commands: [
				{ command: "new", description: "Start a new pi session" },
				{ command: "handoff", description: "Transfer context to new session — /handoff <goal>" },
				{ command: "abort", description: "Stop the current agent operation" },
				{ command: "steer", description: "Interrupt and redirect — /steer <message>" },
				{ command: "followup", description: "Queue message for later — /followup <message>" },
				{ command: "compact", description: "Compact session context" },
				{ command: "model", description: "Show or switch model — /model [pattern]" },
				{ command: "thinking", description: "Set thinking level — /thinking [off|minimal|low|medium|high]" },
				{ command: "status", description: "Show session info" },
				{ command: "detach", description: "Detach session for terminal use" },
			],
		}).catch(() => {});

		// Drain pending updates
		const updates = await this.api("getUpdates", { offset: -1 });
		if (updates.length > 0) {
			await this.api("getUpdates", { offset: updates[updates.length - 1].update_id + 1 });
		}
	}

	async poll(offset: number, signal?: AbortSignal): Promise<{ updates: any[]; nextOffset: number }> {
		const updates = await this.api("getUpdates", { offset, timeout: 30 }, signal);
		let nextOffset = offset;
		for (const u of updates) {
			if (u.update_id >= nextOffset) nextOffset = u.update_id + 1;
		}
		return { updates, nextOffset };
	}

	async sendMessage(chatId: number, text: string, parseMode?: string, entities?: any[]): Promise<any> {
		const params: Record<string, any> = { chat_id: chatId, text };
		if (parseMode) params.parse_mode = parseMode;
		if (entities?.length) params.entities = entities;

		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				return await this.api("sendMessage", params);
			} catch (e: any) {
				if (e?.message?.includes("429") && attempt < 2) {
					await sleep((attempt + 1) * 3000);
					continue;
				}
				throw e;
			}
		}
	}

	async sendLong(chatId: number, text: string): Promise<void> {
		if (!text.trim()) return;
		const chunks = splitMessage(text, 4000);
		for (let i = 0; i < chunks.length; i++) {
			if (i > 0) await sleep(1000);
			try {
				await this.sendMessage(chatId, chunks[i], "Markdown");
			} catch {
				// Markdown failed — extract links as entities and send plain text
				const { text: plainText, entities } = extractLinkEntities(chunks[i]);
				try {
					await this.sendMessage(chatId, plainText, undefined, entities);
				} catch (e: any) {
					log(`Failed to send message to ${chatId}: ${e?.message}`);
				}
			}
		}
	}

	async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
		await this.api("editMessageText", {
			chat_id: chatId,
			message_id: messageId,
			text,
		}).catch(() => {});
	}

	async deleteMessage(chatId: number, messageId: number): Promise<void> {
		await this.api("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
	}

	async sendChatAction(chatId: number, action = "typing"): Promise<void> {
		await this.api("sendChatAction", { chat_id: chatId, action }).catch(() => {});
	}

	async getFileUrl(fileId: string): Promise<{ url: string; path: string }> {
		const info = await this.api("getFile", { file_id: fileId });
		return {
			url: `https://api.telegram.org/file/bot${this.token}/${info.file_path}`,
			path: info.file_path,
		};
	}

	api(method: string, params: Record<string, any> = {}, signal?: AbortSignal): Promise<any> {
		return new Promise((resolve, reject) => {
			const body = JSON.stringify(params);
			const url = new URL(`${TELEGRAM_API}${this.token}/${method}`);
			const req = https.request(
				{
					hostname: url.hostname,
					path: url.pathname,
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(body),
					},
					family: 4,
				},
				(res) => {
					let data = "";
					res.on("data", (chunk: string) => (data += chunk));
					res.on("end", () => {
						try {
							const parsed = JSON.parse(data);
							if (!parsed.ok) {
								if (parsed.error_code === 429 && parsed.parameters?.retry_after) {
									this.rateLimitedUntil = Date.now() + parsed.parameters.retry_after * 1000;
								}
								reject(new Error(parsed.description || `Telegram API ${method} failed`));
							} else {
								resolve(parsed.result);
							}
						} catch (e) {
							reject(e);
						}
					});
				},
			);
			req.on("error", reject);
			if (signal) signal.addEventListener("abort", () => req.destroy());
			req.write(body);
			req.end();
		});
	}
}

// ── Link Entity Extraction ────────────────────────────────────────

/**
 * Extract [text](url) markdown links from a string and return
 * the plain text with `text_link` entities for Telegram's entities API.
 * This supports any URL scheme (http, fantastical, shortcuts, etc.).
 */
export function extractLinkEntities(text: string): { text: string; entities: any[] } {
	const entities: any[] = [];
	const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
	let result = "";
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = linkRe.exec(text)) !== null) {
		// Append text before this link
		result += text.slice(lastIndex, match.index);
		const linkText = match[1];
		const url = match[2];
		const offset = result.length;
		result += linkText;
		entities.push({ type: "text_link", offset, length: linkText.length, url });
		lastIndex = match.index + match[0].length;
	}
	result += text.slice(lastIndex);
	return { text: result, entities };
}

// ── Message Splitting ─────────────────────────────────────────────

export function splitMessage(text: string, maxLen: number): string[] {
	if (text.length <= maxLen) return [text];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= maxLen) {
			chunks.push(remaining);
			break;
		}
		let splitAt = remaining.lastIndexOf("\n", maxLen);
		if (splitAt < maxLen * 0.3) splitAt = maxLen;
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).replace(/^\n/, "");
	}
	return chunks;
}

// ── File Downloads ────────────────────────────────────────────────

export function downloadBuffer(url: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		https.get(url, { family: 4 }, (res) => {
			if (res.statusCode === 301 || res.statusCode === 302) {
				downloadBuffer(res.headers.location!).then(resolve, reject);
				return;
			}
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve(Buffer.concat(chunks)));
		}).on("error", reject);
	});
}

export function downloadFile(url: string, destPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const file = fs.createWriteStream(destPath);
		https.get(url, { family: 4 }, (res: any) => {
			if (res.statusCode === 301 || res.statusCode === 302) {
				file.close();
				fs.unlinkSync(destPath);
				downloadFile(res.headers.location!, destPath).then(resolve, reject);
				return;
			}
			res.pipe(file);
			file.on("finish", () => {
				file.close();
				resolve();
			});
		}).on("error", (e: Error) => {
			file.close();
			fs.unlinkSync(destPath);
			reject(e);
		});
	});
}

// ── Utilities ─────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ── Logging ───────────────────────────────────────────────────────

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let _level: number = LEVELS.info;

export function setLogLevel(level: LogLevel): void { _level = LEVELS[level]; }

function emit(level: LogLevel, msg: string): void {
	if (LEVELS[level] < _level) return;
	const ts = new Date().toISOString();
	const tag = level === "info" ? "" : ` [${level.toUpperCase()}]`;
	console.log(`[${ts}]${tag} ${msg}`);
}

export function debug(msg: string): void { emit("debug", msg); }
export function log(msg: string): void { emit("info", msg); }
export function warn(msg: string): void { emit("warn", msg); }
export function error(msg: string): void { emit("error", msg); }
