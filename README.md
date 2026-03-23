# pi-telegram-bot

Standalone Telegram bot that orchestrates [pi](https://github.com/badlogic/pi-mono) coding agent sessions via its RPC protocol. Runs as a macOS background service — always on, no terminal session required.

## Features

- **Long-running sessions** — context is preserved across messages (no more losing context between every interaction)
- **Always-on** — runs as a Homebrew launchd service, independent of any terminal
- **Session management** — `/new` to start fresh, `/handoff` to transfer context to a new session
- **Full agent control** — `/steer`, `/followup`, `/abort`, `/compact`, `/model`
- **Live activity feed** — see what the agent is doing in real-time (tool calls, file edits, etc.)
- **Voice notes** — transcribed via whisper.cpp and sent as prompts
- **Image support** — photos forwarded to the agent with vision
- **Telegram formatting** — responses formatted for Telegram's MarkdownV1

## Prerequisites

- [pi](https://github.com/badlogic/pi-mono) installed and configured with API keys
- [Node.js](https://nodejs.org/) 20+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- (Optional) [whisper.cpp](https://github.com/ggerganov/whisper.cpp) + ffmpeg for voice notes

## Install

```bash
# Clone
git clone https://github.com/adampetrovic/pi-telegram-bot.git
cd pi-telegram-bot

# Install dependencies & build
npm install
npm run build

# Configure
mkdir -p ~/.config/pi-telegram-bot
cp config.example.yaml ~/.config/pi-telegram-bot/config.yaml
# Edit config.yaml with your bot token and chat ID
```

### Configuration

Edit `~/.config/pi-telegram-bot/config.yaml`:

```yaml
telegram:
  bot_token: "your-bot-token-from-botfather"
  chat_id: 12345678  # optional, restricts to one chat

pi:
  cwd: ~/                          # default working directory
  # model: anthropic/claude-sonnet-4-20250514  # optional
  # session_dir: ~/.local/share/pi-telegram-bot/sessions
```

### Run directly

```bash
npm start
```

### Run as a macOS service (Homebrew)

```bash
brew tap adampetrovic/tap
brew install pi-telegram-bot
brew services start pi-telegram-bot
```

Logs:
```bash
tail -f /opt/homebrew/var/log/pi-telegram-bot.log
tail -f /opt/homebrew/var/log/pi-telegram-bot-error.log
```

Restart after code changes:
```bash
cd ~/code/pi-telegram-bot && npm run build
brew services restart pi-telegram-bot
```

## Commands

| Command | Description |
|---------|-------------|
| `/new [cwd]` | Start a new pi session (optionally in a directory) |
| `/handoff <goal>` | Transfer context to a new session with a generated prompt |
| `/abort` | Stop the current agent operation |
| `/steer <msg>` | Interrupt and redirect the agent mid-run |
| `/followup <msg>` | Queue message for after the agent finishes |
| `/compact [instructions]` | Compact session context to reduce token usage |
| `/model [provider/id]` | Show current model or switch to a new one |
| `/status` | Show session info (model, tokens, cost, cwd) |

Regular messages (without a `/` prefix) are sent as prompts to the active session. If no session exists, one is created automatically.

## How It Works

```
Telegram ←→ pi-telegram-bot ←→ pi (RPC subprocess)
              (always-on)         (manages sessions)
```

1. The bot polls Telegram for messages
2. On first message, spawns a `pi --mode rpc` subprocess
3. Messages are routed as RPC commands (`prompt`, `steer`, `follow_up`, `abort`, etc.)
4. Agent events stream back and are displayed as a live activity feed
5. Final response replaces the activity feed with the formatted output
6. The pi subprocess persists between messages, maintaining full conversation context

Sessions are stored in `~/.pi/telegram-sessions/`.

## Releasing

Every push to `main` automatically:
1. Bumps the patch version in `package.json`
2. Creates a git tag and GitHub release with a built tarball
3. Updates the Homebrew formula in [`adampetrovic/homebrew-tap`](https://github.com/adampetrovic/homebrew-tap)

Requires `HOMEBREW_TAP_GITHUB_TOKEN` secret on the repo (a PAT with push access to the tap).

## License

MIT
