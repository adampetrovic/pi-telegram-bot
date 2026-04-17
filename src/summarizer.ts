/**
 * Summarizer — a dedicated lightweight pi RPC process (OpenAI mini model) that
 * produces human-readable descriptions of what the main agent is doing.
 *
 * Runs alongside the main agent. Receives tool call info, returns a short
 * status line for the Telegram activity indicator.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { log, debug, warn } from "./telegram.js";

const PI_BIN = process.env.PI_BIN || "pi";
const MODEL = "openai/gpt-5-mini";

const SYSTEM_INSTRUCTIONS = `You are a status line generator. You receive information about tool calls that a coding agent is making, and you respond with a single short status message (max 80 chars) describing what the agent is doing in plain English.

Rules:
• Respond with ONLY the status line — no explanation, no quotes, no prefix
• Use a single relevant emoji at the start
• Be specific but concise — mention the file/service/action
• Write for a non-technical audience when possible
• Don't mention tool names — describe the action naturally

Examples of good status lines:
📖 Reading the Kubernetes deployment config
✏️ Updating the database connection settings
🔍 Searching for references to the auth module
🧪 Running the test suite
🔨 Building the project
📂 Checking what files are in the project
🌐 Calling the Home Assistant API
⚙️ Checking the git history for recent changes`;

export class Summarizer {
	private process: ChildProcess | null = null;
	private buffer = "";
	private requestId = 0;
	private pendingRequests = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void }>();
	private currentResponse = "";
	private responseResolve: ((text: string) => void) | null = null;
	private _running = false;

	get isRunning(): boolean {
		return this._running && this.process !== null;
	}

	async start(): Promise<void> {
		if (this.process) return;

		const home = process.env.HOME || "/Users/adam";
		const shimPath = `${home}/.local/share/mise/shims`;
		const brewPath = "/opt/homebrew/bin:/opt/homebrew/sbin";
		const basePath = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

		const args = ["--mode", "rpc", "--no-session", "--model", MODEL];
		log(`[summarizer] Starting: ${PI_BIN} ${args.join(" ")}`);

		this.process = spawn(PI_BIN, args, {
			cwd: home,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				HOME: home,
				PATH: `${shimPath}:${brewPath}:${basePath}:${process.env.PATH || ""}`,
			},
		});

		this.process.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString().trim();
			if (text) debug(`[summarizer stderr] ${text}`);
		});

		this.process.on("exit", (code, signal) => {
			log(`[summarizer] Exited: code=${code} signal=${signal}`);
			this.process = null;
			this._running = false;
			for (const [, req] of this.pendingRequests) {
				req.reject(new Error("Summarizer exited"));
			}
			this.pendingRequests.clear();
		});

		this.process.stdout?.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString();
			this.processBuffer();
		});

		await new Promise((r) => setTimeout(r, 500));
		if (!this.process || this.process.exitCode !== null) {
			throw new Error("Summarizer failed to start");
		}

		// Send the system instructions as the first message
		await this.rpcSend({ type: "prompt", message: SYSTEM_INSTRUCTIONS + "\n\nRespond with: ⏳ Ready" });
		await this.waitForAgentEnd(15_000);

		this._running = true;
		log("[summarizer] Ready");
	}

	private restart(): void {
		log("[summarizer] Restarting after failure");
		this.stop().then(() => this.start()).catch((e) => {
			warn(`[summarizer] Restart failed: ${e.message}`);
		});
	}

	async stop(): Promise<void> {
		if (!this.process) return;
		log("[summarizer] Stopping");
		this.process.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 3000);
			this.process?.on("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		this.process = null;
		this._running = false;
	}

	private busy = false;

	/**
	 * Describe a tool call. Returns a human-readable status line.
	 * If the summarizer is busy from a previous request, returns fallback immediately.
	 */
	async describe(toolName: string, args: Record<string, unknown>): Promise<string> {
		if (!this.isRunning || this.busy) return fallbackDescription(toolName, args);

		this.busy = true;
		const prompt = formatToolPrompt(toolName, args);

		try {
			await this.rpcSend({ type: "prompt", message: prompt });
			const text = await this.waitForAgentEnd(5_000);
			const line = text.trim().split("\n")[0].trim();
			return line || fallbackDescription(toolName, args);
		} catch (e: any) {
			debug(`[summarizer] describe failed: ${e.message}`);
			// Process is likely stuck — restart it in the background
			this.restart();
			return fallbackDescription(toolName, args);
		} finally {
			this.busy = false;
		}
	}

	// ── Internal ──────────────────────────────────────────────────

	private rpcSend(command: Record<string, unknown>): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.process?.stdin?.writable) {
				reject(new Error("Summarizer not running"));
				return;
			}

			const id = `sum-${++this.requestId}`;
			command.id = id;
			this.pendingRequests.set(id, { resolve, reject });
			this.process.stdin.write(JSON.stringify(command) + "\n");

			setTimeout(() => {
				if (this.pendingRequests.has(id)) {
					this.pendingRequests.delete(id);
					reject(new Error("Summarizer RPC timeout"));
				}
			}, 10_000);
		});
	}

	private waitForAgentEnd(timeout: number): Promise<string> {
		return new Promise((resolve, reject) => {
			this.currentResponse = "";
			const timer = setTimeout(() => {
				this.responseResolve = null;
				reject(new Error("Summarizer response timeout"));
			}, timeout);

			this.responseResolve = (text: string) => {
				clearTimeout(timer);
				resolve(text);
			};
		});
	}

	private processBuffer(): void {
		while (true) {
			const idx = this.buffer.indexOf("\n");
			if (idx === -1) break;

			let line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;

			try {
				const msg = JSON.parse(line);
				this.handleMessage(msg);
			} catch { /* ignored */ }
		}
	}

	private handleMessage(msg: any): void {
		// Handle RPC responses
		if (msg.type === "response" && msg.id) {
			const pending = this.pendingRequests.get(msg.id);
			if (pending) {
				this.pendingRequests.delete(msg.id);
				if (msg.success) pending.resolve(msg.data);
				else pending.reject(new Error(msg.error || "RPC error"));
			}
			return;
		}

		// Accumulate text from streaming
		if (msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta") {
			this.currentResponse += msg.assistantMessageEvent.delta;
		}

		// Resolve on agent_end
		if (msg.type === "agent_end") {
			if (this.responseResolve) {
				const resolve = this.responseResolve;
				this.responseResolve = null;
				resolve(this.currentResponse);
			}
		}
	}
}

// ── Helpers ───────────────────────────────────────────────────────

function formatToolPrompt(toolName: string, args: Record<string, unknown>): string {
	const parts: string[] = [`Tool: ${toolName}`];

	if (args.path) parts.push(`Path: ${args.path}`);
	if (args.command) {
		const cmd = String(args.command);
		parts.push(`Command: ${cmd.length > 200 ? cmd.slice(0, 200) + "..." : cmd}`);
	}
	if (args.action) parts.push(`Action: ${args.action}`);

	return parts.join("\n");
}

function fallbackDescription(toolName: string, args: Record<string, unknown>): string {
	switch (toolName.toLowerCase()) {
		case "read":
			return `📖 Reading ${shortPath(args?.path as string)}`;
		case "bash":
			return "⚙️ Running a command";
		case "edit":
			return `✏️ Editing ${shortPath(args?.path as string)}`;
		case "write":
			return `📝 Writing ${shortPath(args?.path as string)}`;
		default:
			return `🔧 Working...`;
	}
}

function shortPath(p?: string): string {
	if (!p) return "a file";
	const parts = p.split("/").filter(Boolean);
	return parts[parts.length - 1] || "a file";
}
