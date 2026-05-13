import { spawn } from "node:child_process";

const SERVICE_NAME = "pi-telegram-bot";
const LAUNCHD_LABEL = "homebrew.mxcl.pi-telegram-bot";
const SERVICE_PATH = "$HOME/.local/share/mise/shims:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH";

export function isServiceRestartRequest(text: string): boolean {
	const normalized = text
		.toLowerCase()
		.replace(/[_-]+/g, " ")
		.replace(/[^a-z0-9/\s]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	if (!normalized) return false;

	const imperativeRestart = /^(please\s+)?((can|could|would) you\s+)?(restart|bounce)\b/.test(normalized);
	const explicitBrewCommand = /^brew services? restart pi telegram bot$/.test(normalized);
	const mentionsThisBot = /\bpi telegram bot\b/.test(normalized);
	const mentionsService = /\b(brew|homebrew|service|services|launchd)\b/.test(normalized);

	return explicitBrewCommand || (imperativeRestart && mentionsThisBot && mentionsService);
}

export function buildServiceRestartScript(): string {
	return [
		"sleep 1",
		`export PATH="${SERVICE_PATH}"`,
		`if command -v launchctl >/dev/null 2>&1; then launchctl kickstart -k "gui/$(id -u)/${LAUNCHD_LABEL}" && exit 0; fi`,
		`if command -v brew >/dev/null 2>&1; then exec brew services restart ${SERVICE_NAME}; fi`,
		`exec /opt/homebrew/bin/brew services restart ${SERVICE_NAME}`,
	].join("\n");
}

export function scheduleServiceRestart(): void {
	const child = spawn("/bin/sh", ["-lc", buildServiceRestartScript()], {
		detached: true,
		stdio: "ignore",
	});

	child.unref();
}
