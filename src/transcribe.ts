/**
 * Voice note transcription via whisper.cpp
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { downloadFile, log } from "./telegram.js";

const WHISPER_MODEL = path.join(os.homedir(), ".local/share/whisper-cpp/models/ggml-large-v3-turbo.bin");

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(error);
			else resolve({ stdout, stderr });
		});
	});
}

export async function transcribeVoice(oggUrl: string): Promise<string> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-voice-"));

	try {
		const oggPath = path.join(tmpDir, "voice.ogg");
		await downloadFile(oggUrl, oggPath);

		const wavPath = path.join(tmpDir, "voice.wav");
		await run("ffmpeg", ["-i", oggPath, "-ar", "16000", "-ac", "1", "-y", wavPath]);

		const { stdout } = await run("whisper-cli", [
			"-m", WHISPER_MODEL,
			"-f", wavPath,
			"--no-timestamps",
			"-l", "en",
			"--no-prints",
		]);

		const text = stdout.trim();
		if (!text) throw new Error("Empty transcription");
		return text;
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}
