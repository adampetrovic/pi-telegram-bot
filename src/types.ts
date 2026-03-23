// ── Telegram Types ─────────────────────────────────────────────────

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
}

export interface TelegramMessage {
	message_id: number;
	chat: { id: number; type: string; title?: string };
	from?: { id: number; username?: string; first_name?: string };
	text?: string;
	caption?: string;
	photo?: TelegramPhotoSize[];
	document?: { file_id: string; mime_type?: string; file_name?: string };
	voice?: { file_id: string; duration: number };
}

export interface TelegramPhotoSize {
	file_id: string;
	width: number;
	height: number;
}

// ── Pi RPC Types ──────────────────────────────────────────────────

export interface RpcCommand {
	id?: string;
	type: string;
	[key: string]: unknown;
}

export interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

export interface RpcEvent {
	type: string;
	[key: string]: unknown;
}

export interface RpcAgentEndEvent extends RpcEvent {
	type: "agent_end";
	messages: RpcAgentMessage[];
}

export interface RpcAgentMessage {
	role: string;
	content: RpcContentBlock[] | string;
	timestamp?: number;
}

export type RpcContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
	| { type: "image"; source: { type: string; media_type: string; data: string } };

export interface RpcToolExecutionStart extends RpcEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
}

export interface RpcSessionState {
	model: { provider: string; id: string; name?: string } | null;
	thinkingLevel: string;
	isStreaming: boolean;
	sessionFile: string | null;
	sessionId: string;
	sessionName?: string;
	messageCount: number;
}

// ── Session Types ─────────────────────────────────────────────────

export interface ChatSession {
	chatId: number;
	cwd: string;
	piProcess: import("child_process").ChildProcess | null;
	isStreaming: boolean;
	activityLines: string[];
	activityMsgId: number | null;
	lastEditTime: number;
	pendingEdit: boolean;
	editTimer: ReturnType<typeof setTimeout> | null;
	requestId: number;
	pendingRequests: Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void }>;
	buffer: string;
}
