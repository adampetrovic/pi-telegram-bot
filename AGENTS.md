# pi-telegram-bot

Standalone Telegram bot service that orchestrates pi coding agent sessions via the RPC protocol.

## Architecture

- **Always-on service**: Runs as a Homebrew launchd service on macOS
- **Telegram bot polling**: Raw HTTPS against Telegram Bot API (no dependencies)
- **Pi RPC integration**: Spawns `pi --mode rpc` subprocess per session
- **Session management**: Long-running sessions with `/new` to start fresh
- **Voice transcription**: whisper.cpp for voice notes
- **Image support**: Photos forwarded to pi as base64

## Project Structure

```
src/
  index.ts          # Entry point, service lifecycle
  telegram.ts       # Telegram Bot API client (polling, sending)
  pi-session.ts     # Pi RPC subprocess management
  commands.ts       # Telegram command handlers
  transcribe.ts     # Voice note transcription via whisper.cpp
  types.ts          # Shared types
bin/
  pi-telegram-bot   # Shell launcher for brew service
```

## Commands

- `/new [cwd]` — Start a new pi session (optionally in a directory)
- `/handoff <goal>` — Transfer context to a new session with a generated prompt
- `/abort` — Stop the current agent operation
- `/steer <msg>` — Interrupt and redirect the agent
- `/followup <msg>` — Queue message for after agent finishes
- `/compact` — Compact session context
- `/model [pattern]` — Show or switch model
- `/status` — Show session info

## Configuration

Config file: `~/.config/pi-telegram-bot/config.yaml`

```yaml
telegram:
  bot_token: "..."       # Required — from @BotFather
  chat_id: 12345678      # Optional — restrict to specific chat

pi:
  cwd: ~/                # Default working directory
  model: ...             # Optional — default model
  session_dir: ...       # Optional — session storage path
```

## Development

```bash
npm install
npm run build
npm start          # Run directly
npm run dev        # Run with tsx (no build)
```

## Deployment

```bash
brew services restart pi-telegram-bot
```

## Version Control

Uses jj (Jujutsu). See the jj skill for commands.
