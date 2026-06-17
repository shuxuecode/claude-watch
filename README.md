# claude-watch

**English | [简体中文](README.zh-CN.md)**

> Stream Claude Code's hidden output (thinking, tool calls, subagents) to a web browser in real-time.

Claude Code writes detailed JSONL logs under `~/.claude/projects/` as it works — including thinking blocks, tool inputs/outputs, subagent activity, and token usage. `claude-watch` tails those logs and streams everything to a local web dashboard, so you can see exactly what Claude Code is doing under the hood.

![](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)

## Features

- **Real-time streaming** — thinking, tool calls, tool results, and text responses appear as they happen
- **Multi-session** — watch all Claude Code sessions in a tree view, grouped by date (plus a dedicated **Observer** folder for observer sessions); active sessions stay flat regardless of age
- **Observer session support** — automatically detects observer sessions (`.claude/mem/observer/sessions`) and shows them under a dedicated **Observer** folder with the real working directory and observed request in tooltips
- **Token statistics page** — independent Tokens tab with total usage, input/output/cache read/cache creation, message count, model ranking, usage trends, 52-week activity heatmap, hourly distribution, and daily/weekly/monthly breakdowns
- **Hash routing** — URL hash syncs with the current tab (`#stream` / `#tokens`), so refresh and browser back/forward keep your place
- **Dark / light theme** — one-click theme toggle with localStorage persistence
- **Version check** — automatically checks npm for newer versions and shows an update badge in the footer; run `claude-watch update` to upgrade from the CLI
- **Subagent tracking** — see subagent activity nested under their parent session
- **Color-coded session tags** — each session gets a unique colored hash prefix for easy visual distinction
- **Agent-level activity** — active dots on agent/main nodes (not just sessions) with configurable thresholds
- **Session hiding** — remove unwanted sessions; hidden state persists for 24h via localStorage
- **Code block copy** — one-click copy button on every markdown code block
- **Token & cost visibility** — tracks input/output/cache tokens per agent, with context window utilization
- **Filter controls** — toggle thinking, tool input, tool output, hook output, and text visibility independently
- **Auto-discovery** — automatically picks up new sessions as they start (toggleable)
- **HTML export** — export the current stream as a self-contained HTML file with embedded session list, token stats, filter state, and per-session filtering

## Quick Start

```bash
npx claude-code-watch
```

This starts the dashboard at `http://localhost:23000` and opens it in your browser.

It will auto-discover active Claude Code sessions from `~/.claude/projects/` and start streaming immediately.

## Installation

```bash
npm install -g claude-code-watch
```

Then run:

```bash
claude-code-watch
```

## Usage

```
claude-code-watch [OPTIONS]

Shorter alias: `cc-watch` (equivalent to `claude-code-watch`).

OPTIONS:
    -p, --port <port>    HTTP port (default: 23000)
    --host <host>        Bind host (default: 127.0.0.1)
    -s <ID>              Watch a specific session by ID
    -n                   Start from newest (skip history, live only)
    -l [N]               List recent sessions (default 10) and exit
    -a [N]               List active sessions (default all) and exit
    -w <dur>             Active window duration (default 24h, e.g. 30s, 2m, 10m)
    -m <N>               Max sessions to show in tree (default 0=unlimited)
    -c <dur>             Auto-collapse sessions inactive for this duration (e.g. 2m)
    -D                   Debug: show raw type:subtype for every JSONL line we'd drop
    --poll <ms>          Polling interval in milliseconds (default: 500)
    --no-open            Do not auto-open browser on start
    -v                   Show version
    -h, --help           Show this help

Subcommands:
    update               Check for latest version and install it globally
```

### Examples

```bash
# List recent sessions
claude-code-watch -l

# List active sessions from last 10 minutes
claude-code-watch -a -w 10m

# Watch a specific session
claude-code-watch -s abc123-def456

# Live-only mode (don't replay history)
claude-code-watch -n

# Custom port and host
claude-code-watch -p 8080 --host 0.0.0.0

# Do not auto-open browser
claude-code-watch --no-open

# Upgrade to the latest version
claude-code-watch update

# Limit tree to 5 most recent sessions, auto-collapse after 2m of inactivity
claude-code-watch -m 5 -c 2m

# Debug mode: see every unknown JSONL line type
claude-code-watch -D
```

## How It Works

`claude-watch` monitors the Claude Code project directory (`~/.claude/projects/`) for JSONL log files. Each Claude Code session writes structured JSON lines containing:

- `assistant` messages — thinking blocks, text responses, and tool use requests
- `user` messages — tool results and user prompts
- `system` messages — turn duration markers, compaction boundaries
- `attachment` messages — hook outputs and diagnostics
- Agent metadata — session titles, subagent type info

The watcher tails these files (via chokidar fsnotify events, with polling fallback), parses each line into structured stream items, and pushes them to the browser over WebSocket. The browser renders them in a terminal-style dashboard with filtering, tree navigation, and token tracking.

## Environment

| Variable | Description |
|----------|-------------|
| `CLAUDE_HOME` | Override Claude config directory (default: `~/.claude`) |

## License

MIT

## Acknowledgments

This project was inspired by and developed based on [claude-esp](https://github.com/phiat/claude-esp) by phiat.