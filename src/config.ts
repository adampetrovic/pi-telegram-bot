/**
 * Configuration loader — reads ~/.config/pi-telegram-bot/config.yaml
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseYaml } from "yaml";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
	telegram: {
		bot_token: string;
		chat_id?: number;
	};
	pi: {
		cwd: string;
		model?: string;
		session_dir: string;
	};
	log_level: LogLevel;
}

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".config", "pi-telegram-bot");
const DEFAULT_CONFIG_FILE = path.join(DEFAULT_CONFIG_DIR, "config.yaml");

function configFilePath(): string {
	return process.env.PI_TELEGRAM_BOT_CONFIG || DEFAULT_CONFIG_FILE;
}

export function loadConfig(): Config {
	const configFile = configFilePath();
	if (!fs.existsSync(configFile)) {
		console.error(`Config not found: ${configFile}`);
		console.error(`Create it from the example:\n  mkdir -p ${DEFAULT_CONFIG_DIR}\n  cp config.example.yaml ${configFile}`);
		process.exit(1);
	}

	const raw = fs.readFileSync(configFile, "utf8");
	const parsed = parseYaml(raw);

	if (!parsed?.telegram?.bot_token) {
		console.error(`Missing required field: telegram.bot_token in ${configFile}`);
		process.exit(1);
	}

	return {
		telegram: {
			bot_token: parsed.telegram.bot_token,
			chat_id: parsed.telegram.chat_id ?? undefined,
		},
		pi: {
			cwd: parsed.pi?.cwd ?? os.homedir(),
			model: parsed.pi?.model ?? undefined,
			session_dir: parsed.pi?.session_dir ?? path.join(os.homedir(), ".local", "share", "pi-telegram-bot", "sessions"),
		},
		log_level: (["debug", "info", "warn", "error"].includes(parsed.log_level) ? parsed.log_level : "info") as LogLevel,
	};
}
