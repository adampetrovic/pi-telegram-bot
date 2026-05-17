/**
 * Summarizer — a dedicated lightweight pi RPC process (OpenAI Codex mini
 * model) that produces human-readable descriptions of what the main agent is
 * doing.
 *
 * Runs alongside the main agent. Receives tool call info, returns a short
 * status line for the Telegram activity indicator.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as os from "node:os";
import { log, debug, warn } from "./telegram.js";

const PI_BIN = process.env.PI_BIN || "pi";
const MODEL = process.env.PI_TELEGRAM_SUMMARIZER_MODEL || "openai-codex/gpt-5.4-mini";
const RPC_TIMEOUT_MS = 30_000;
const START_RESPONSE_TIMEOUT_MS = 45_000;
const DESCRIBE_RESPONSE_TIMEOUT_MS = 10_000;
const RESTART_RETRY_MS = 30_000;

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

interface PendingRequest {
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class Summarizer {
	private process: ChildProcess | null = null;
	private buffer = "";
	private requestId = 0;
	private pendingRequests = new Map<string, PendingRequest>();
	private currentResponse = "";
	private responseResolve: ((text: string) => void) | null = null;
	private responseReject: ((err: Error) => void) | null = null;
	private responseTimer: ReturnType<typeof setTimeout> | null = null;
	private startingPromise: Promise<void> | null = null;
	private restartTimer: ReturnType<typeof setTimeout> | null = null;
	private _running = false;
	private busy = false;

	get isRunning(): boolean {
		return this._running && this.process !== null;
	}

	async start(): Promise<void> {
		if (this.isRunning) return;
		if (this.startingPromise) return this.startingPromise;

		this.startingPromise = this.doStart().finally(() => {
			this.startingPromise = null;
		});
		return this.startingPromise;
	}

	private async doStart(): Promise<void> {
		if (this.process) {
			// A previous startup may have timed out after spawning pi. Kill it so
			// process !== null cannot leave the summarizer permanently disabled.
			await this.stop();
		}

		this.resetState();
		this._running = false;

		const home = process.env.HOME || os.homedir();
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
				clearTimeout(req.timer);
				req.reject(new Error("Summarizer exited"));
			}
			this.pendingRequests.clear();
			this.rejectResponseWait(new Error("Summarizer exited"));
		});

		this.process.stdout?.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString();
			this.processBuffer();
		});

		try {
			await new Promise((r) => setTimeout(r, 500));
			if (!this.process || this.process.exitCode !== null) {
				throw new Error("Summarizer failed to start");
			}

			// Install the agent_end waiter before sending the prompt so fast
			// responses cannot race past waitForAgentEnd().
			await this.runPrompt(
				SYSTEM_INSTRUCTIONS + "\n\nRespond with: ⏳ Ready",
				START_RESPONSE_TIMEOUT_MS,
			);

			this._running = true;
			log("[summarizer] Ready");
		} catch (e: any) {
			warn(`[summarizer] Start failed: ${e.message}`);
			await this.stop();
			throw e;
		}
	}

	private restart(): void {
		if (this.startingPromise) return;
		log("[summarizer] Restarting after failure");
		this.stop().then(() => this.start()).catch((e) => {
			warn(`[summarizer] Restart failed: ${e.message}; retrying in ${RESTART_RETRY_MS / 1000}s`);
			this.scheduleRestartRetry();
		});
	}

	private scheduleRestartRetry(): void {
		if (this.restartTimer) return;
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			this.restart();
		}, RESTART_RETRY_MS);
	}

	async stop(): Promise<void> {
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		this._running = false;
		this.busy = false;
		this.resetState();

		const proc = this.process;
		if (!proc) return;

		log("[summarizer] Stopping");
		proc.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				proc.kill("SIGKILL");
				resolve();
			}, 3000);
			proc.on("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		this.process = null;
		this._running = false;
	}

	/**
	 * Describe a tool call. Returns a human-readable status line.
	 * If the summarizer is busy from a previous request, returns fallback immediately.
	 */
	async describe(toolName: string, args: Record<string, unknown>): Promise<string> {
		if (!this.isRunning || this.busy) return fallbackDescription(toolName, args);

		this.busy = true;
		const prompt = formatToolPrompt(toolName, args);

		try {
			const text = await this.runPrompt(prompt, DESCRIBE_RESPONSE_TIMEOUT_MS);
			const line = text.trim().split("\n")[0].trim();
			return line || fallbackDescription(toolName, args);
		} catch (e: any) {
			debug(`[summarizer] describe failed: ${e.message}`);
			// Process is likely stuck — restart it in the background.
			this.restart();
			return fallbackDescription(toolName, args);
		} finally {
			this.busy = false;
		}
	}

	// ── Internal ──────────────────────────────────────────────────

	private rpcSend(command: Record<string, unknown>, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.process?.stdin?.writable) {
				reject(new Error("Summarizer not running"));
				return;
			}

			const id = `sum-${++this.requestId}`;
			command.id = id;
			const timer = setTimeout(() => {
				if (this.pendingRequests.has(id)) {
					this.pendingRequests.delete(id);
					reject(new Error("Summarizer RPC timeout"));
				}
			}, timeoutMs);

			this.pendingRequests.set(id, { resolve, reject, timer });
			this.process.stdin.write(JSON.stringify(command) + "\n");
		});
	}

	private async runPrompt(message: string, responseTimeout: number): Promise<string> {
		const responsePromise = this.waitForAgentEnd(responseTimeout);
		const commandPromise = this.rpcSend({ type: "prompt", message });

		try {
			const [, text] = await Promise.all([commandPromise, responsePromise]);
			return text;
		} catch (e: any) {
			this.rejectResponseWait(new Error("Summarizer request cancelled"));
			throw e;
		}
	}

	private waitForAgentEnd(timeout: number): Promise<string> {
		return new Promise((resolve, reject) => {
			this.rejectResponseWait(new Error("Summarizer response superseded"));
			this.currentResponse = "";
			this.responseTimer = setTimeout(() => {
				this.responseResolve = null;
				this.responseReject = null;
				this.responseTimer = null;
				reject(new Error("Summarizer response timeout"));
			}, timeout);

			this.responseResolve = (text: string) => {
				if (this.responseTimer) clearTimeout(this.responseTimer);
				this.responseTimer = null;
				this.responseResolve = null;
				this.responseReject = null;
				resolve(text);
			};
			this.responseReject = (err: Error) => {
				if (this.responseTimer) clearTimeout(this.responseTimer);
				this.responseTimer = null;
				this.responseResolve = null;
				this.responseReject = null;
				reject(err);
			};
		});
	}

	private rejectResponseWait(err: Error): void {
		const reject = this.responseReject;
		if (this.responseTimer) clearTimeout(this.responseTimer);
		this.responseTimer = null;
		this.responseResolve = null;
		this.responseReject = null;
		if (reject) reject(err);
	}

	private resetState(): void {
		this.buffer = "";
		this.currentResponse = "";
		this.requestId = 0;
		for (const [, req] of this.pendingRequests) {
			clearTimeout(req.timer);
			req.reject(new Error("Summarizer reset"));
		}
		this.pendingRequests.clear();
		this.rejectResponseWait(new Error("Summarizer reset"));
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
				clearTimeout(pending.timer);
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
				this.responseReject = null;
				if (this.responseTimer) clearTimeout(this.responseTimer);
				this.responseTimer = null;
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

export function fallbackDescription(toolName: string, args: Record<string, unknown>): string {
	switch (toolName.toLowerCase()) {
		case "read":
			return `📖 Reading ${shortPath(args?.path as string)}`;
		case "bash":
			return describeBashCommand(args?.command);
		case "edit":
			return `✏️ Editing ${shortPath(args?.path as string)}`;
		case "write":
			return `📝 Writing ${shortPath(args?.path as string)}`;
		case "todo":
			return describeTodoAction(args?.action);
		default:
			return "🔧 Working...";
	}
}

function describeBashCommand(command: unknown): string {
	const raw = typeof command === "string" ? command.trim() : "";
	if (!raw) return "⚙️ Running a command";

	const compact = raw.replace(/\s+/g, " ").trim();
	const normalized = stripShellPreamble(compact);
	const lower = normalized.toLowerCase();
	const rawLower = compact.toLowerCase();

	if (/\bgws\s+calendar\b/.test(rawLower)) {
		if (/\b(insert|create|add|\+insert)\b/.test(rawLower)) return "📅 Adding a calendar event";
		return "📅 Checking calendar events";
	}
	if (/\bthings3\/scripts\/things\b|\bthings\s+(projects|areas|tags|add-todo|today|inbox)\b/.test(rawLower)) {
		if (/\badd-todo\b/.test(rawLower)) return "✅ Adding a Things task";
		return "✅ Checking Things 3";
	}
	if (/home-assistant|ha\.sh|\bha\s+/.test(rawLower)) return "🏠 Querying Home Assistant";
	if (/\bpsql\b/.test(rawLower)) return "🗄️ Querying Postgres";
	if (/\bkubectl\b/.test(lower)) return describeKubectl(lower);
	if (/\bflux\b/.test(lower)) return describeFlux(lower);
	if (/\bkustomize\b/.test(lower)) return "☸️ Building Kubernetes manifests";
	if (/\bhelm\b/.test(lower)) return "⎈ Checking Helm configuration";
	if (/\bjj\b/.test(lower)) return describeJujutsu(lower);
	if (/\bgit\b/.test(lower)) return describeGit(lower);
	if (/\bnpm\s+(run\s+)?(check|test|vitest)\b/.test(lower)) return "🧪 Running project checks";
	if (/\bnpm\s+(run\s+)?(build|tsc)\b/.test(lower)) return "🔨 Building the project";
	if (/\bnpm\s+(run\s+)?lint\b/.test(lower)) return "🧹 Running the linter";
	if (/\b(date|timedatectl)\b/.test(lower)) return "🕒 Checking the current time";
	if (/\b(rg|grep|ag)\b/.test(lower)) return "🔍 Searching files";
	if (/\bfind\b/.test(lower)) return "🔎 Finding files";
	if (/\bls\b/.test(lower)) return "📂 Listing files";
	if (/\b(cat|sed|awk|head|tail)\b/.test(lower)) return "📄 Inspecting command output";
	if (/\b(curl|wget|http)\b/.test(lower)) return "🌐 Fetching web content";
	if (/\bpython(3)?\b/.test(lower)) {
		if (/urllib|requests|urlopen|https?:\/\//.test(rawLower)) return "🌐 Fetching web content with Python";
		return "🐍 Running a Python script";
	}
	if (/\b(op\s+run|op\s+read|op\s+item)\b/.test(lower)) return "🔐 Accessing 1Password secrets";
	if (/\bdocker\b/.test(lower)) return "🐳 Running Docker";
	if (/\bbrew\b/.test(lower)) return "🍺 Checking Homebrew";
	if (/\bmake\b/.test(lower)) return "🔨 Running a build task";

	const scriptName = extractScriptName(normalized);
	if (scriptName) return `⚙️ Running ${scriptName}`;

	return "⚙️ Running a command";
}

function stripShellPreamble(command: string): string {
	let result = command;
	for (let i = 0; i < 3; i++) {
		result = result
			.replace(/^cd\s+[^;&|]+\s*&&\s*/i, "")
			.replace(/^env\s+/i, "")
			.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "")
			.replace(/^set\s+-[A-Za-z]+\s*;?\s*/i, "");
	}
	return result.trim();
}

function describeKubectl(command: string): string {
	if (/\bget\s+pods?\b/.test(command)) return "☸️ Checking Kubernetes pods";
	if (/\bget\s+(deploy|deployment|deployments)\b/.test(command)) return "☸️ Checking Kubernetes deployments";
	if (/\blogs\b/.test(command)) return "🪵 Checking Kubernetes logs";
	if (/\bexec\b/.test(command)) return "☸️ Running a command in Kubernetes";
	if (/\bapply\b/.test(command)) return "☸️ Applying Kubernetes changes";
	if (/\brollout\b/.test(command)) return "☸️ Checking Kubernetes rollout";
	if (/\bport-forward\b/.test(command)) return "🔌 Opening a Kubernetes port-forward";
	return "☸️ Checking Kubernetes";
}

function describeFlux(command: string): string {
	if (/\bbuild\b/.test(command)) return "🚢 Building Flux manifests";
	if (/\bget\b/.test(command)) return "🚢 Checking Flux resources";
	if (/\breconcile\b/.test(command)) return "🚢 Reconciling Flux resources";
	return "🚢 Checking Flux";
}

function describeGit(command: string): string {
	if (/\bstatus\b/.test(command)) return "📂 Checking git status";
	if (/\bdiff\b/.test(command)) return "🔍 Reviewing git changes";
	if (/\blog\b/.test(command)) return "🕘 Checking git history";
	if (/\b(push|pull|fetch)\b/.test(command)) return "🔄 Syncing git changes";
	if (/\bcommit\b/.test(command)) return "💾 Committing changes";
	return "📂 Checking git";
}

function describeJujutsu(command: string): string {
	if (/\b(st|status)\b/.test(command)) return "📂 Checking Jujutsu status";
	if (/\bdiff\b/.test(command)) return "🔍 Reviewing Jujutsu changes";
	if (/\blog\b/.test(command)) return "🕘 Checking Jujutsu history";
	if (/\bgit\s+(push|fetch)\b/.test(command)) return "🔄 Syncing Jujutsu changes";
	if (/\bbookmark\b/.test(command)) return "🔖 Updating Jujutsu bookmarks";
	if (/\bdescribe\b/.test(command)) return "💬 Describing the current change";
	return "📂 Checking Jujutsu";
}

function describeTodoAction(action: unknown): string {
	const value = typeof action === "string" ? action : "";
	if (value === "list" || value === "list-all") return "📋 Listing todos";
	if (value === "get") return "📋 Reading a todo";
	if (["create", "update", "append", "claim", "release", "delete"].includes(value)) return "📋 Updating todos";
	return "📋 Checking todos";
}

function extractScriptName(command: string): string | null {
	const match = command.match(/(?:^|\s)(?:bash\s+|sh\s+|\.\/)?((?:~?\/?[\w.-]+\/)*[\w.-]*(?:script|deploy|dash|tool|cli)[\w.-]*)/i);
	if (!match) return null;
	return shortPath(match[1]).replace(/\.(sh|bash|py|js|ts)$/i, "");
}

function shortPath(p?: string): string {
	if (!p) return "a file";
	const parts = p.split("/").filter(Boolean);
	return parts[parts.length - 1] || "a file";
}
