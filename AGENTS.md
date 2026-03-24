# pi-telegram-bot

Standalone Telegram bot service that orchestrates pi coding agent sessions via the RPC protocol.

## Architecture

- **Always-on service**: Runs as a Homebrew launchd service on macOS
- **Telegram bot polling**: Raw HTTPS against Telegram Bot API (zero dependencies)
- **Pi RPC integration**: Spawns `pi --mode rpc` subprocess per session
- **Summarizer**: Dedicated Haiku RPC process for human-readable activity descriptions
- **Session management**: Long-running sessions with `/new` to start fresh
- **Voice transcription**: whisper.cpp for voice notes
- **Image support**: Photos forwarded to pi as base64

## Project Structure

```
src/
  index.ts          # Entry point, Telegram polling loop, command routing
  config.ts         # YAML config loader (~/.config/pi-telegram-bot/config.yaml)
  telegram.ts       # Telegram Bot API client, logging utilities
  pi-session.ts     # Pi RPC subprocess management (JSONL protocol)
  summarizer.ts     # Dedicated Haiku RPC process for activity descriptions
  activity.ts       # Live-updating Telegram message (rate-limited)
  transcribe.ts     # Voice note transcription via whisper.cpp
  types.ts          # Shared TypeScript types
  *.test.ts         # Unit tests (vitest)
bin/
  pi-telegram-bot   # Shell launcher for brew service
```

## Commands

| Command | Description |
|---------|-------------|
| `/new [cwd]` | Start a new pi session (optionally in a directory) |
| `/handoff <goal>` | Transfer context to new session with a generated prompt |
| `/abort` | Stop the current agent operation |
| `/steer <msg>` | Interrupt and redirect the agent |
| `/followup <msg>` | Queue message for after agent finishes |
| `/compact` | Compact session context |
| `/model [provider/id]` | Show or switch model |
| `/thinking [level]` | Show or set thinking level (off/minimal/low/medium/high) |
| `/status` | Show session info |
| `/detach` | Stop RPC process, print session file for terminal use |

## Configuration

Config file: `~/.config/pi-telegram-bot/config.yaml`

```yaml
telegram:
  bot_token: "..."
  chat_id: 12345678

pi:
  cwd: ~/
  # model: anthropic/claude-sonnet-4-20250514
  # session_dir: ~/.local/share/pi-telegram-bot/sessions

# log_level: info  # debug | info | warn | error
```

## Development

### Prerequisites

- Node.js 20+
- pi installed with API keys configured

### Commands

```bash
npm install          # Install dependencies
npm run check        # Run lint + build + tests (do this before every commit)
npm run lint         # ESLint only
npm run lint:fix     # ESLint with auto-fix
npm run build        # TypeScript compilation
npm run test         # Run tests
npm run test:watch   # Run tests in watch mode
npm run dev          # Run with tsx (no build step)
```

### Before every commit

Always run the full check before committing:

```bash
npm run check
```

This runs lint → build → tests. All three must pass. CI enforces this on push and PR.

### Adding new features

1. Write the code
2. Add tests for new logic in `src/<module>.test.ts`
3. Run `npm run check` — fix any lint errors or test failures
4. Commit and push

### Testing

Tests use [vitest](https://vitest.dev/). Test files live alongside source as `*.test.ts`.

```bash
npm run test              # Run once
npm run test:watch        # Watch mode
npm run test:coverage     # With coverage report
```

### Deployment

```bash
# Local development — brew service runs from dist/
npm run build
brew services restart pi-telegram-bot

# Production release — push to main triggers CI + release pipeline
# The release workflow runs lint + test + build before creating a release
```

## Version Control

Uses jj (Jujutsu). See the jj skill for commands.

## CI/CD

- **CI** (`ci.yml`): Runs lint + build + test on every push/PR to main
- **Release** (`release.yml`): On push to main, bumps version, runs checks, creates GitHub release, updates Homebrew tap
