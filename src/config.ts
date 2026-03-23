/**
 * Configuration loader — reads ~/.config/pi-telegram-bot/config.yaml
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseYaml } from "yaml";

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
}

const CONFIG_DIR = path.join(os.homedir(), ".config", "pi-telegram-bot");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.yaml");

export function loadConfig(): Config {
	if (!fs.existsSync(CONFIG_FILE)) {
		console.error(`Config not found: ${CONFIG_FILE}`);
		console.error(`Create it from the example:\n  mkdir -p ${CONFIG_DIR}\n  cp config.example.yaml ${CONFIG_FILE}`);
		process.exit(1);
	}

	const raw = fs.readFileSync(CONFIG_FILE, "utf8");
	const parsed = parseYaml(raw);

	if (!parsed?.telegram?.bot_token) {
		console.error(`Missing required field: telegram.bot_token in ${CONFIG_FILE}`);
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
	};
}
