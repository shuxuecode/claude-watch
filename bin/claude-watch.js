#!/usr/bin/env node

'use strict';

const { startServer } = require('../src/server/server');
const { listSessions, listActiveSessions } = require('../src/watcher/watcher');

const VERSION = '0.0.1';

function printHelp() {
  console.log(`claude-watch v${VERSION}

Stream Claude Code's hidden output (thinking, tool calls, subagents)
to a web browser.

USAGE:
    claude-watch [OPTIONS]

OPTIONS:
    -p, --port <port>    HTTP port (default: 23000)
    -h, --host <host>    Bind host (default: 127.0.0.1)
    -s <ID>     Watch a specific session by ID
    -n          Start from newest (skip history, live only)
    -l [N]      List recent sessions (default 10) and exit
    -a [N]      List active sessions (default all) and exit
    -w <dur>    Active window duration (default 5m, e.g. 30s, 2m, 10m)
    -m <N>      Max sessions to show in tree (default 0=unlimited)
    -c <dur>    Auto-collapse sessions inactive for this duration (e.g. 2m)
    -D          Debug: show raw type:subtype for every JSONL line we'd drop
    --poll <ms> Polling interval in milliseconds (default: 500)
    -v          Show version
    --help      Show this help

ENVIRONMENT:
    CLAUDE_HOME     Override Claude config directory (default: ~/.claude)
`);
}

function parseDuration(s) {
  const match = s.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) throw new Error(`Invalid duration: ${s}`);
  const val = parseInt(match[1], 10);
  switch (match[2]) {
    case 'ms': return val;
    case 's': return val * 1000;
    case 'm': return val * 60 * 1000;
    case 'h': return val * 3600 * 1000;
    default: throw new Error(`Invalid duration unit: ${match[2]}`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  const options = {
    port: 23000,
    host: '127.0.0.1',
    sessionID: '',
    skipHistory: false,
    pollMs: 500,
    activeWindow: 5 * 60 * 1000,
    maxSessions: 0,
    collapseAfter: 0,
    debugAll: false,
  };

  // First pass: collect all option values
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-s':
        options.sessionID = args[++i] || '';
        break;
      case '-n':
        options.skipHistory = true;
        break;
      case '-p':
      case '--port':
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          console.error(`Error: ${args[i]} requires a port number`);
          process.exit(1);
        }
        const pv = parseInt(args[++i], 10);
        if (isNaN(pv)) {
          console.error(`Error: ${args[i - 1]} requires a numeric port, got '${args[i]}'`);
          process.exit(1);
        }
        options.port = pv;
        break;
      case '-h':
      case '--host':
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          console.error(`Error: ${args[i]} requires a host address`);
          process.exit(1);
        }
        options.host = args[++i];
        break;
      case '-w':
        try {
          options.activeWindow = parseDuration(args[++i] || '5m');
        } catch {
          options.activeWindow = 5 * 60 * 1000;
        }
        break;
      case '-c':
        try {
          options.collapseAfter = parseDuration(args[++i] || '5m');
        } catch {
          options.collapseAfter = 5 * 60 * 1000;
        }
        break;
      case '-m':
        options.maxSessions = parseInt(args[++i], 10) || 0;
        break;
      case '-D':
        options.debugAll = true;
        break;
      case '--poll':
        options.pollMs = parseInt(args[++i], 10) || 500;
        break;
      default:
        break;
    }
  }

  // Second pass: execute action flags with fully resolved options
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-l': {
        const v = parseInt(args[i + 1]);
        const limit = !isNaN(v) ? v : 10;
        if (!isNaN(v)) i++;
        const sessions = await listSessions(limit);
        if (sessions.length === 0) {
          console.log('No sessions found.');
        } else {
          const now = Date.now();
          for (const s of sessions) {
            const age = Math.round((now - new Date(s.modified).getTime()) / 1000);
            const ageStr = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.floor(age / 60)}m ago` : `${Math.floor(age / 3600)}h ago`;
            const active = s.isActive ? '●' : '○';
            const id = s.id.length > 40 ? s.id.slice(0, 37) + '...' : s.id;
            console.log(`${active} ${id}  ${s.projectPath || '?'}  ${ageStr}`);
          }
        }
        return;
      }
      case '-a': {
        const v = parseInt(args[i + 1]);
        const limit = !isNaN(v) ? v : 0;
        if (!isNaN(v)) i++;
        const sessions = await listActiveSessions(options.activeWindow);
        const result = limit > 0 ? sessions.slice(0, limit) : sessions;
        if (result.length === 0) {
          console.log('No active sessions found.');
        } else {
          const now = Date.now();
          for (const s of result) {
            const age = Math.round((now - new Date(s.modified).getTime()) / 1000);
            const ageStr = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.floor(age / 60)}m ago` : `${Math.floor(age / 3600)}h ago`;
            const id = s.id.length > 40 ? s.id.slice(0, 37) + '...' : s.id;
            console.log(`● ${id}  ${s.projectPath || '?'}  ${ageStr}`);
          }
        }
        return;
      }
      case '-v':
        console.log(`claude-watch v${VERSION}`);
        return;
      case '--help':
        printHelp();
        return;
      default:
        if (args[i].startsWith('-')) {
          console.error(`Unknown option: ${args[i]}`);
          printHelp();
          process.exit(1);
        }
    }
  }

  startServer(options);
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
