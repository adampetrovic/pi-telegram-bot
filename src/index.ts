#!/usr/bin/env node
/**
 * pi-telegram-bot — Standalone Telegram bot that orchestrates pi sessions via RPC.
 *
 * Runs as a brew service. Receives Telegram commands, manages long-running pi
 * sessions so context is preserved between messages.
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN  — Required
 *   TELEGRAM_CHAT_ID    — Optional, restrict to one chat
 *   PI_TELEGRAM_CWD     — Default cwd for sessions (default: ~)
 *   PI_TELEGRAM_MODEL   — Default model (e.g. anthropic/claude-sonnet-4-20250514)
 */

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { TelegramClient, downloadBuffer, log, sleep } from "./telegram.js";
import { PiSession } from "./pi-session.js";
import { ActivityFeed, formatToolAction } from "./activity.js";
import { transcribeVoice } from "./transcribe.js";
import type { RpcEvent, RpcAgentMessage, RpcContentBlock } from "./types.js";

// ── Config ────────────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ? parseInt(process.env.TELEGRAM_CHAT_ID, 10) : null;
const DEFAULT_CWD = process.env.PI_TELEGRAM_CWD || os.homedir();
const DEFAULT_MODEL = process.env.PI_TELEGRAM_MODEL;
const SESSION_DIR = path.join(os.homedir(), ".pi", "telegram-sessions");

if (!TELEGRAM_BOT_TOKEN) {
	console.error("TELEGRAM_BOT_TOKEN is required");
	process.exit(1);
}

// Ensure session directory exists
fs.mkdirSync(SESSION_DIR, { recursive: true });

// ── State ─────────────────────────────────────────────────────────

let telegram: TelegramClient;
let piSession: PiSession | null = null;
let activityFeed: ActivityFeed | null = null;
let activeChatId: number | null = null;
let messageCount = { sent: 0, received: 0 };
let shuttingDown = false;

// ── Telegram System Prompt Injection ──────────────────────────────
// We inject Telegram formatting rules as the first message in each session.

const TELEGRAM_FORMAT_INSTRUCTIONS = `Important: Your responses will be displayed in Telegram. Follow these formatting rules:

**Telegram MarkdownV1 rules:**
- Use *bold* (single asterisks), _italic_ (single underscores)
- Use \`inline code\` and \`\`\` code blocks (no language hints)
- Use [link text](url) for links
- NO double asterisks, NO headers (#), NO tables, NO bullet dashes
- Use • (bullet character) for lists
- Keep responses concise — messages over 4096 chars get split
- Use short paragraphs, not walls of text`;

// ── Pi Session Management ─────────────────────────────────────────

async function ensureSession(chatId: number): Promise<PiSession> {
	if (piSession?.isRunning) return piSession;

	log(`Creating new pi session for chat ${chatId}`);
	activeChatId = chatId;

	piSession = new PiSession({
		cwd: DEFAULT_CWD,
		sessionDir: SESSION_DIR,
		model: DEFAULT_MODEL,
	});

	piSession.onEvent((event) => handlePiEvent(chatId, event));

	await piSession.start();

	// Inject formatting instructions as first prompt context
	// We send a system-level hint via the first user message
	try {
		await piSession.prompt(TELEGRAM_FORMAT_INSTRUCTIONS + "\n\nAcknowledge briefly that you understand the formatting rules.");
		// Wait for the response to complete before accepting user messages
		await waitForIdle(piSession, 30_000);
	} catch (e: any) {
		log(`Warning: Failed to inject format instructions: ${e.message}`);
	}

	return piSession;
}

async function destroySession(): Promise<void> {
	if (activityFeed) {
		await activityFeed.stop();
		activityFeed = null;
	}
	if (piSession) {
		await piSession.stop();
		piSession = null;
	}
}

function waitForIdle(session: PiSession, timeout = 120_000): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!session.isStreaming) {
			resolve();
			return;
		}

		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("Timeout waiting for idle"));
		}, timeout);

		const originalHandler = (session as any).eventHandler;
		const cleanup = () => {
			clearTimeout(timer);
			(session as any).eventHandler = originalHandler;
		};

		(session as any).eventHandler = (event: RpcEvent) => {
			originalHandler?.(event);
			if (event.type === "agent_end") {
				cleanup();
				resolve();
			}
		};
	});
}

// ── Pi Event Handling ─────────────────────────────────────────────

function handlePiEvent(chatId: number, event: RpcEvent): void {
	switch (event.type) {
		case "agent_start":
			activityFeed = new ActivityFeed(telegram, chatId);
			activityFeed.start();
			break;

		case "tool_execution_start": {
			const toolName = (event as any).toolName || "";
			const args = (event as any).args || {};
			const line = formatToolAction(toolName, args);
			activityFeed?.push(line);
			break;
		}

		case "agent_end":
			handleAgentEnd(chatId, event);
			break;

		case "auto_compaction_start":
			activityFeed?.push("🗜️ Compacting context...");
			break;

		case "auto_retry_start":
			activityFeed?.push(`🔄 Retrying (attempt ${(event as any).attempt})...`);
			break;

		case "extension_error":
			log(`Extension error: ${(event as any).error}`);
			break;
	}
}

async function handleAgentEnd(chatId: number, event: RpcEvent): Promise<void> {
	// Brief pause to let last edit land
	await sleep(500);

	if (activityFeed) {
		await activityFeed.stop();
		activityFeed = null;
	}

	// Extract text from the last assistant message
	const messages = (event as any).messages as RpcAgentMessage[] | undefined;
	if (!messages?.length) {
		await telegram.sendLong(chatId, "ℹ️ Done (no output).");
		messageCount.sent++;
		return;
	}

	const lastAssistant = [...messages].reverse().find(
		(m) => m.role === "assistant" && Array.isArray(m.content) &&
			m.content.some((b: RpcContentBlock) => b.type === "text" && (b as any).text?.trim()),
	);

	if (!lastAssistant || !Array.isArray(lastAssistant.content)) {
		await telegram.sendLong(chatId, "ℹ️ Done (tools only, no text output).");
		messageCount.sent++;
		return;
	}

	const textParts: string[] = [];
	for (const block of lastAssistant.content) {
		if (block.type === "text" && (block as any).text?.trim()) {
			textParts.push((block as any).text);
		}
	}

	const fullResponse = textParts.join("\n\n");
	if (fullResponse.trim()) {
		await telegram.sendLong(chatId, fullResponse);
	} else {
		await telegram.sendLong(chatId, "ℹ️ Done (no text output).");
	}
	messageCount.sent++;
}

// ── Command Handlers ──────────────────────────────────────────────

async function handleCommand(chatId: number, text: string): Promise<void> {
	const [cmd, ...rest] = text.split(/\s+/);
	const args = rest.join(" ").trim();
	const command = cmd.toLowerCase();

	switch (command) {
		case "/start":
			await telegram.sendLong(chatId, "🟢 Pi Telegram Bot is running.\nSend a message or use /new to start a session.");
			return;

		case "/new":
			await handleNew(chatId, args);
			return;

		case "/handoff":
			await handleHandoff(chatId, args);
			return;

		case "/abort":
			await handleAbort(chatId);
			return;

		case "/steer":
			await handleSteer(chatId, args);
			return;

		case "/followup":
			await handleFollowUp(chatId, args);
			return;

		case "/compact":
			await handleCompact(chatId, args);
			return;

		case "/model":
			await handleModel(chatId, args);
			return;

		case "/status":
			await handleStatus(chatId);
			return;

		default:
			// Not a command, treat as regular message
			await handleMessage(chatId, text);
			return;
	}
}

async function handleNew(chatId: number, args: string): Promise<void> {
	const cwd = args || DEFAULT_CWD;

	// Resolve ~ and relative paths
	const resolvedCwd = cwd.startsWith("~")
		? path.join(os.homedir(), cwd.slice(1))
		: path.resolve(cwd);

	if (!fs.existsSync(resolvedCwd)) {
		await telegram.sendLong(chatId, `⚠️ Directory not found: \`${resolvedCwd}\``);
		return;
	}

	await telegram.sendChatAction(chatId);
	await destroySession();

	piSession = new PiSession({
		cwd: resolvedCwd,
		sessionDir: SESSION_DIR,
		model: DEFAULT_MODEL,
	});
	piSession.onEvent((event) => handlePiEvent(chatId, event));
	activeChatId = chatId;

	try {
		await piSession.start();

		// Inject formatting instructions
		await piSession.prompt(TELEGRAM_FORMAT_INSTRUCTIONS + "\n\nAcknowledge briefly.");
		await waitForIdle(piSession, 30_000);

		await telegram.sendLong(chatId, `🆕 New session started.\n📂 Working directory: \`${resolvedCwd}\``);
	} catch (e: any) {
		await telegram.sendLong(chatId, `⚠️ Failed to start session: ${e.message}`);
		await destroySession();
	}
}

async function handleHandoff(chatId: number, args: string): Promise<void> {
	if (!args) {
		await telegram.sendLong(chatId, "Usage: /handoff <goal for new session>\nExample: /handoff now implement the error handling");
		return;
	}

	const session = piSession;
	if (!session?.isRunning) {
		await telegram.sendLong(chatId, "ℹ️ No active session. Use /new to start one.");
		return;
	}

	await telegram.sendChatAction(chatId);

	try {
		// Ask pi to generate a handoff summary
		const handoffPrompt = `I need to hand off this conversation to a new session. The goal for the new session is: "${args}"

Please generate a focused handoff prompt that:
1. Summarizes relevant context (decisions, approaches, findings)
2. Lists files that were discussed or modified
3. Clearly states the next task

Format it as a self-contained prompt. Output ONLY the prompt, no preamble.`;

		await session.prompt(handoffPrompt);
		await waitForIdle(session, 60_000);

		// Get the generated prompt
		const generatedPrompt = await session.getLastAssistantText();
		if (!generatedPrompt) {
			await telegram.sendLong(chatId, "⚠️ Failed to generate handoff prompt.");
			return;
		}

		// Create new session with the handoff prompt
		const cwd = session.cwd;
		await destroySession();

		piSession = new PiSession({
			cwd,
			sessionDir: SESSION_DIR,
			model: DEFAULT_MODEL,
		});
		piSession.onEvent((event) => handlePiEvent(chatId, event));
		activeChatId = chatId;

		await piSession.start();

		// Send formatting instructions + handoff prompt
		await piSession.prompt(TELEGRAM_FORMAT_INSTRUCTIONS + "\n\n" + generatedPrompt);
		// Don't await idle here — let the agent process and stream the response

		await telegram.sendLong(chatId, "🔄 Handed off to new session. Processing...");
	} catch (e: any) {
		await telegram.sendLong(chatId, `⚠️ Handoff failed: ${e.message}`);
	}
}

async function handleAbort(chatId: number): Promise<void> {
	if (!piSession?.isRunning) {
		await telegram.sendLong(chatId, "ℹ️ No active session.");
		return;
	}
	if (!piSession.isStreaming) {
		await telegram.sendLong(chatId, "ℹ️ Agent is not currently running.");
		return;
	}

	try {
		await piSession.abort();
		await telegram.sendLong(chatId, "🛑 Aborting...");
	} catch (e: any) {
		await telegram.sendLong(chatId, `⚠️ Abort failed: ${e.message}`);
	}
}

async function handleSteer(chatId: number, args: string): Promise<void> {
	if (!args) {
		await telegram.sendLong(chatId, "Usage: /steer <message>");
		return;
	}
	if (!piSession?.isRunning) {
		await telegram.sendLong(chatId, "ℹ️ No active session. Send a message to start one.");
		return;
	}

	try {
		await piSession.steer(args);
		await telegram.sendLong(chatId, "🔀 Steering...");
	} catch (e: any) {
		await telegram.sendLong(chatId, `⚠️ Steer failed: ${e.message}`);
	}
}

async function handleFollowUp(chatId: number, args: string): Promise<void> {
	if (!args) {
		await telegram.sendLong(chatId, "Usage: /followup <message>");
		return;
	}
	if (!piSession?.isRunning) {
		await telegram.sendLong(chatId, "ℹ️ No active session. Send a message to start one.");
		return;
	}

	try {
		await piSession.followUp(args);
		await telegram.sendLong(chatId, "📋 Queued as follow-up.");
	} catch (e: any) {
		await telegram.sendLong(chatId, `⚠️ Follow-up failed: ${e.message}`);
	}
}

async function handleCompact(chatId: number, args: string): Promise<void> {
	if (!piSession?.isRunning) {
		await telegram.sendLong(chatId, "ℹ️ No active session.");
		return;
	}

	await telegram.sendChatAction(chatId);

	try {
		const result = await piSession.compact(args || undefined) as any;
		const summary = result?.summary ? `Summary: ${result.summary.slice(0, 200)}...` : "Done.";
		await telegram.sendLong(chatId, `🗜️ Compacted.\n${summary}`);
	} catch (e: any) {
		await telegram.sendLong(chatId, `⚠️ Compact failed: ${e.message}`);
	}
}

async function handleModel(chatId: number, args: string): Promise<void> {
	if (!piSession?.isRunning) {
		await telegram.sendLong(chatId, "ℹ️ No active session. Start one first with /new.");
		return;
	}

	if (!args) {
		// Show current model
		try {
			const state = await piSession.getState();
			const model = state.model;
			if (model) {
				await telegram.sendLong(chatId, `🤖 Current model: \`${model.provider}/${model.id}\`\nThinking: ${state.thinkingLevel}`);
			} else {
				await telegram.sendLong(chatId, "⚠️ No model set.");
			}
		} catch (e: any) {
			await telegram.sendLong(chatId, `⚠️ Failed to get model info: ${e.message}`);
		}
		return;
	}

	// Parse model pattern: provider/model or just model
	const parts = args.split("/");
	let provider: string, modelId: string;
	if (parts.length === 2) {
		[provider, modelId] = parts;
	} else {
		provider = "anthropic";
		modelId = args;
	}

	try {
		const result = await piSession.setModel(provider, modelId);
		await telegram.sendLong(chatId, `🤖 Switched to \`${result.provider}/${result.id}\``);
	} catch (e: any) {
		await telegram.sendLong(chatId, `⚠️ Failed to set model: ${e.message}`);
	}
}

async function handleStatus(chatId: number): Promise<void> {
	if (!piSession?.isRunning) {
		await telegram.sendLong(chatId, "📊 *Status*\n\nNo active session.\nUse /new to start one.");
		return;
	}

	try {
		const state = await piSession.getState();
		const stats = (await piSession.getSessionStats()) as any;

		const lines = [
			"📊 *Status*",
			"",
			`🤖 Model: \`${state.model?.provider}/${state.model?.id || "none"}\``,
			`💭 Thinking: ${state.thinkingLevel}`,
			`📂 CWD: \`${piSession.cwd}\``,
			`🔄 Streaming: ${state.isStreaming ? "yes" : "no"}`,
			`💬 Messages: ${state.messageCount}`,
			"",
			`📈 Tokens: ${stats?.tokens?.total?.toLocaleString() || "N/A"}`,
			`💰 Cost: $${stats?.cost?.toFixed(4) || "N/A"}`,
			"",
			`📨 Received: ${messageCount.received} | Sent: ${messageCount.sent}`,
		];

		if (state.sessionName) {
			lines.splice(2, 0, `📝 Session: ${state.sessionName}`);
		}

		await telegram.sendLong(chatId, lines.join("\n"));
	} catch (e: any) {
		await telegram.sendLong(chatId, `⚠️ Failed to get status: ${e.message}`);
	}
}

// ── Message Handling ──────────────────────────────────────────────

async function handleMessage(chatId: number, text: string): Promise<void> {
	await telegram.sendChatAction(chatId);

	try {
		const session = await ensureSession(chatId);

		if (session.isStreaming) {
			// Agent is busy — queue as follow-up by default
			await session.followUp(text);
			await telegram.sendLong(chatId, "📋 Queued as follow-up.");
		} else {
			await session.prompt(text);
		}
	} catch (e: any) {
		await telegram.sendLong(chatId, `⚠️ Failed: ${e.message}`);
	}
}

async function handlePhoto(chatId: number, fileId: string, caption?: string): Promise<void> {
	await telegram.sendChatAction(chatId);

	try {
		const { url, path: filePath } = await telegram.getFileUrl(fileId);
		const buffer = await downloadBuffer(url);
		const base64 = buffer.toString("base64");

		const ext = filePath.split(".").pop()?.toLowerCase();
		const mimeType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";

		const session = await ensureSession(chatId);
		const message = caption?.trim() || "What's in this image?";

		const images = [{ type: "image" as const, data: base64, mimeType }];

		if (session.isStreaming) {
			// Can't send images during streaming, queue text only
			await session.followUp(message + " [image attached but could not be sent during streaming]");
			await telegram.sendLong(chatId, "📋 Queued (image will be described in text).");
		} else {
			await session.prompt(message, images);
		}
	} catch (e: any) {
		await telegram.sendLong(chatId, `⚠️ Failed to process image: ${e.message}`);
	}
}

async function handleVoice(chatId: number, fileId: string, caption?: string): Promise<void> {
	await telegram.sendChatAction(chatId);

	try {
		const { url } = await telegram.getFileUrl(fileId);
		const transcription = await transcribeVoice(url);

		await telegram.sendLong(chatId, `🎙️ _${transcription}_`);

		const prompt = caption ? `${caption}\n\n${transcription}` : transcription;
		await handleMessage(chatId, prompt);
	} catch (e: any) {
		await telegram.sendLong(chatId, `⚠️ Voice transcription failed: ${e.message}`);
	}
}

// ── Main Loop ─────────────────────────────────────────────────────

async function main(): Promise<void> {
	log("Starting pi-telegram-bot");

	telegram = new TelegramClient(TELEGRAM_BOT_TOKEN!);

	try {
		await telegram.init();
		log(`Connected as @${telegram.botUsername}`);
	} catch (e: any) {
		console.error(`Failed to connect to Telegram: ${e.message}`);
		process.exit(1);
	}

	// Notify allowed chat that bot is online
	if (TELEGRAM_CHAT_ID) {
		activeChatId = TELEGRAM_CHAT_ID;
		telegram.sendLong(TELEGRAM_CHAT_ID, "🟢 Pi Telegram Bot started.").catch(() => {});
	}

	// Polling loop
	let offset = 0;

	while (!shuttingDown) {
		try {
			const { updates, nextOffset } = await telegram.poll(offset);
			offset = nextOffset;

			for (const update of updates) {
				if (shuttingDown) break;

				const msg = update.message;
				if (!msg) continue;

				const chatId = msg.chat.id;

				// Chat restriction
				if (TELEGRAM_CHAT_ID && chatId !== TELEGRAM_CHAT_ID) continue;

				messageCount.received++;

				if (msg.voice) {
					handleVoice(chatId, msg.voice.file_id, msg.caption).catch((e) =>
						log(`Voice handler error: ${e.message}`),
					);
				} else if (msg.photo) {
					const photo = msg.photo[msg.photo.length - 1];
					handlePhoto(chatId, photo.file_id, msg.caption).catch((e) =>
						log(`Photo handler error: ${e.message}`),
					);
				} else if (msg.document?.mime_type?.startsWith("image/")) {
					handlePhoto(chatId, msg.document.file_id, msg.caption).catch((e) =>
						log(`Document handler error: ${e.message}`),
					);
				} else if (msg.text) {
					if (msg.text.startsWith("/")) {
						handleCommand(chatId, msg.text).catch((e) =>
							log(`Command handler error: ${e.message}`),
						);
					} else {
						handleMessage(chatId, msg.text).catch((e) =>
							log(`Message handler error: ${e.message}`),
						);
					}
				}
			}
		} catch (e: any) {
			if (shuttingDown) break;
			log(`Polling error: ${e.message}`);
			await sleep(5000);
		}
	}
}

// ── Graceful Shutdown ─────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log(`Received ${signal}, shutting down...`);

	if (activeChatId) {
		await telegram.sendLong(activeChatId, "🔴 Pi Telegram Bot shutting down.").catch(() => {});
	}

	await destroySession();
	log("Shutdown complete");
	process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Start ─────────────────────────────────────────────────────────

main().catch((e) => {
	console.error(`Fatal: ${e.message}`);
	process.exit(1);
});
