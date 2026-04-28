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

Edit `~/.config/pi-telegram-bot/config.yaml` (or set `PI_TELEGRAM_BOT_CONFIG` to an explicit config file path):

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

### Run as a container

Release builds publish a Linux image to GHCR:

```bash
docker run --rm \
  -v "$HOME/.config/pi-telegram-bot:/config/pi-telegram-bot" \
  -v "$HOME/.pi/agent:/config/.pi/agent" \
  -v "$HOME/code:/config/code" \
  ghcr.io/adampetrovic/pi-telegram-bot:latest
```

The image includes `pi`, Node.js, Git, GitHub CLI, Jujutsu, kubectl, Flux, SOPS, Task, Python, curl, jq, and OpenSSH for Kubernetes-hosted agent usage.

### Local container test

Do not run this while the Homebrew service is also polling the same Telegram bot token.

```bash
# Stop the laptop service first
brew services stop pi-telegram-bot

# Create an isolated test home and copy your existing bot config
TEST_HOME="$HOME/.local/share/pi-telegram-bot-container-test"
mkdir -p "$TEST_HOME/pi-telegram-bot" "$TEST_HOME/code"
cp "$HOME/.config/pi-telegram-bot/config.yaml" "$TEST_HOME/pi-telegram-bot/config.yaml"

# Complete Pi OAuth login inside the container; auth.json is written under $TEST_HOME/.pi/agent
# Use the published semver tag once the release workflow has run, e.g. :v1.0.16
docker run --rm -it \
  -v "$TEST_HOME:/config" \
  ghcr.io/adampetrovic/pi-telegram-bot:latest \
  pi

# Then run the bot using the same /config volume
docker run --rm -it --name pi-telegram-bot-test \
  -v "$TEST_HOME:/config" \
  ghcr.io/adampetrovic/pi-telegram-bot:latest

# Restart the laptop service when finished, if desired
brew services start pi-telegram-bot
```

Useful container/Kubernetes environment variables:

| Variable | Description |
|----------|-------------|
| `PI_TELEGRAM_BOT_CONFIG` | Path to `config.yaml` (the image sets `/config/pi-telegram-bot/config.yaml`) |
| `PI_TELEGRAM_SUMMARIZER_MODEL` | Override the activity summarizer model (defaults to `openai-codex/gpt-5.4-mini`) |
| `PI_BIN` | Path/name for the `pi` executable spawned by the bot |

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
