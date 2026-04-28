/**
 * Pi RPC session manager — spawns and communicates with pi subprocess.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as os from "node:os";
import { log, debug, warn } from "./telegram.js";
import type { RpcCommand, RpcResponse, RpcEvent, RpcSessionState } from "./types.js";

export type EventHandler = (event: RpcEvent) => void;

const PI_BIN = process.env.PI_BIN || "pi";

export class PiSession {
	private process: ChildProcess | null = null;
	private buffer = "";
	private requestId = 0;
	private pendingRequests = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void }>();
	private eventHandler: EventHandler | null = null;
	private _isStreaming = false;
	private _cwd: string;
	private _sessionDir: string;
	private _model: string | undefined;
	private _disposed = false;

	constructor(opts: { cwd: string; sessionDir: string; model?: string }) {
		this._cwd = opts.cwd;
		this._sessionDir = opts.sessionDir;
		this._model = opts.model;
	}

	get cwd(): string {
		return this._cwd;
	}
	get isStreaming(): boolean {
		return this._isStreaming;
	}
	get isRunning(): boolean {
		return this.process !== null && !this._disposed;
	}

	onEvent(handler: EventHandler): void {
		this.eventHandler = handler;
	}

	async start(): Promise<void> {
		if (this.process) return;

		const args = ["--mode", "rpc", "--session-dir", this._sessionDir];
		if (this._model) args.push("--model", this._model);

		log(`Starting pi: ${PI_BIN} ${args.join(" ")} (cwd: ${this._cwd})`);

		const home = process.env.HOME || os.homedir();
		const shimPath = `${home}/.local/share/mise/shims`;
		const brewPath = "/opt/homebrew/bin:/opt/homebrew/sbin";
		const basePath = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

		this.process = spawn(PI_BIN, args, {
			cwd: this._cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				HOME: home,
				PATH: `${shimPath}:${brewPath}:${basePath}:${process.env.PATH || ""}`,
			},
		});

		this.process.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString().trim();
			if (text) debug(`[pi stderr] ${text}`);
		});

		this.process.on("exit", (code, signal) => {
			log(`Pi process exited: code=${code} signal=${signal}`);
			this.process = null;
			this._isStreaming = false;
			// Reject all pending requests
			for (const [, req] of this.pendingRequests) {
				req.reject(new Error("Pi process exited"));
			}
			this.pendingRequests.clear();
		});

		this.process.stdout?.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString();
			this.processBuffer();
		});

		// Wait a moment for process to initialize
		await new Promise((r) => setTimeout(r, 500));

		if (!this.process || this.process.exitCode !== null) {
			throw new Error("Pi process failed to start");
		}
	}

	async stop(): Promise<void> {
		this._disposed = true;
		if (!this.process) return;

		log("Stopping pi process");
		this.process.kill("SIGTERM");

		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 5000);
			this.process?.on("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});

		this.process = null;
	}

	// ── RPC Commands ──────────────────────────────────────────────

	async prompt(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
		const cmd: RpcCommand = { type: "prompt", message };
		if (images?.length) cmd.images = images;
		await this.send(cmd);
	}

	async promptStreaming(message: string, streamingBehavior: "steer" | "followUp"): Promise<void> {
		await this.send({ type: "prompt", message, streamingBehavior });
	}

	async steer(message: string): Promise<void> {
		await this.send({ type: "steer", message });
	}

	async followUp(message: string): Promise<void> {
		await this.send({ type: "follow_up", message });
	}

	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	async newSession(): Promise<{ cancelled: boolean }> {
		const data = (await this.send({ type: "new_session" })) as { cancelled: boolean };
		return data;
	}

	async getState(): Promise<RpcSessionState> {
		return (await this.send({ type: "get_state" })) as RpcSessionState;
	}

	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		return (await this.send({ type: "set_model", provider, modelId })) as { provider: string; id: string };
	}

	async compact(customInstructions?: string): Promise<unknown> {
		const cmd: RpcCommand = { type: "compact" };
		if (customInstructions) cmd.customInstructions = customInstructions;
		return await this.send(cmd);
	}

	async getSessionStats(): Promise<unknown> {
		return await this.send({ type: "get_session_stats" });
	}

	async getLastAssistantText(): Promise<string | null> {
		const data = (await this.send({ type: "get_last_assistant_text" })) as { text: string | null };
		return data.text;
	}

	async setThinkingLevel(level: string): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	async cycleThinkingLevel(): Promise<{ level: string } | null> {
		return (await this.send({ type: "cycle_thinking_level" })) as { level: string } | null;
	}

	// ── Internal ──────────────────────────────────────────────────

	private send(command: RpcCommand): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.process?.stdin?.writable) {
				reject(new Error("Pi process not running"));
				return;
			}

			const id = `req-${++this.requestId}`;
			command.id = id;

			this.pendingRequests.set(id, { resolve, reject });
			const line = JSON.stringify(command) + "\n";
			this.process.stdin.write(line);

			// Timeout after 120s for most commands, 300s for compact
			const timeout = command.type === "compact" ? 300_000 : 120_000;
			setTimeout(() => {
				if (this.pendingRequests.has(id)) {
					this.pendingRequests.delete(id);
					reject(new Error(`RPC timeout for ${command.type}`));
				}
			}, timeout);
		});
	}

	private processBuffer(): void {
		while (true) {
			const newlineIdx = this.buffer.indexOf("\n");
			if (newlineIdx === -1) break;

			let line = this.buffer.slice(0, newlineIdx);
			this.buffer = this.buffer.slice(newlineIdx + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;

			try {
				const msg = JSON.parse(line);
				this.handleMessage(msg);
			} catch {
				warn(`Failed to parse RPC message: ${line.slice(0, 200)}`);
			}
		}
	}

	private handleMessage(msg: any): void {
		if (msg.type === "response") {
			const resp = msg as RpcResponse;
			const pending = this.pendingRequests.get(resp.id!);
			if (pending) {
				this.pendingRequests.delete(resp.id!);
				if (resp.success) {
					pending.resolve(resp.data);
				} else {
					pending.reject(new Error(resp.error || "RPC error"));
				}
			}
			return;
		}

		// Track streaming state
		if (msg.type === "agent_start") {
			this._isStreaming = true;
		} else if (msg.type === "agent_end") {
			this._isStreaming = false;
		}

		// Forward event to handler
		this.eventHandler?.(msg);
	}
}
