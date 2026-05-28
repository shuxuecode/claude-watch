#!/usr/bin/env node

'use strict';

const https = require('https');
const cp = require('child_process');

const { startServer } = require('../src/server/server');
const { listSessions, listActiveSessions } = require('../src/watcher/watcher');
const { compareVersions, parseDuration } = require('../src/cli-helpers');

const { version: VERSION } = require('../package.json');

function printHelp() {
  console.log(`claude-watch v${VERSION}

Stream Claude Code's hidden output (thinking, tool calls, subagents)
to a web browser.

USAGE:
    claude-watch [OPTIONS]
    claude-watch update       Check for updates and install latest

OPTIONS:
    -p, --port <port>    HTTP port (default: 23000)
    --host <host>    Bind host (default: 127.0.0.1)
    -s <ID>     Watch a specific session by ID
    -n          Start from newest (skip history, live only)
    -l [N]      List recent sessions (default 10) and exit
    -a [N]      List active sessions (default all) and exit
    -w <dur>    Active window duration (default 24h, e.g. 30s, 2m, 10m)
    -m <N>      Max sessions to show in tree (default 0=unlimited)
    -c <dur>    Auto-collapse sessions inactive for this duration (e.g. 2m)
    -D          Debug: show raw type:subtype for every JSONL line we'd drop
    --poll <ms> Polling interval in milliseconds (default: 500)
    --no-open  Do not auto-open browser on start
    -v          Show version
    -h, --help      Show this help

ENVIRONMENT:
    CLAUDE_HOME     Override Claude config directory (default: ~/.claude)
`);
}

function printVersion() {
  console.log(`claude-watch v${VERSION}`);
}

function fetchLatestVersion() {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'registry.npmjs.org',
      path: '/claude-code-watch/latest',
      timeout: 5000,
    };

    const req = https.get(opts, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.version);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function checkForUpdate() {
  fetchLatestVersion().then((latest) => {
    if (compareVersions(latest, VERSION) > 0) {
      console.log(`\n  New version available: v${latest} (current: v${VERSION})`);
      console.log('  Updating in background...\n');
      const child = cp.spawn('npm', ['install', '-g', 'claude-code-watch@latest'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true,
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.unref();
      child.on('exit', (code) => {
        if (code === 0) {
          console.log(`  Updated to v${latest}. Changes take effect on next start.\n`);
        } else {
          console.error(`  Update failed (exit code ${code}): ${stderr.trim()}\n`);
        }
      });
    }
  }).catch(() => { /* network unavailable, skip */ });
}

async function runUpdate() {
  console.log(`  Current version: v${VERSION}`);
  console.log('  Checking for latest version...\n');

  let latest;
  try {
    latest = await fetchLatestVersion();
  } catch (err) {
    console.error(`  Failed to check for updates: ${err.message}`);
    process.exit(1);
  }

  if (compareVersions(latest, VERSION) <= 0) {
    console.log(`  Already up to date (v${VERSION}).`);
    return;
  }

  console.log(`  Latest version: v${latest}`);
  console.log('  Running npm install -g claude-code-watch@latest...\n');

  try {
    cp.execSync('npm install -g claude-code-watch@latest', { stdio: 'inherit' });
    console.log(`\n  Updated to v${latest}. Restart to use the new version.`);
  } catch {
    console.error('\n  Update failed. Try manually: npm install -g claude-code-watch@latest');
    process.exit(1);
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
    activeWindow: 24 * 60 * 60 * 1000,
    maxSessions: 0,
    collapseAfter: 0,
    debugAll: false,
    openBrowser: true,
  };

  // Action flags
  let listSessionsLimit = 0;   // 0 = no list, >0 = limit
  let listActiveLimit = 0;     // 0 = no list, >0 = limit, -1 = all
  let showVersion = false;
  let showHelp = false;
  let doUpdate = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '-s':
        options.sessionID = args[++i] || '';
        break;
      case '-n':
        options.skipHistory = true;
        break;
      case '-p':
      case '--port': {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          console.error(`Error: ${arg} requires a port number`);
          process.exit(1);
        }
        const pv = parseInt(args[++i], 10);
        if (isNaN(pv)) {
          console.error(`Error: ${args[i - 1]} requires a numeric port, got '${args[i]}'`);
          process.exit(1);
        }
        options.port = pv;
        break;
      }
      case '--host':
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          console.error(`Error: ${arg} requires a host address`);
          process.exit(1);
        }
        options.host = args[++i];
        break;
      case '-w':
        try {
          options.activeWindow = parseDuration(args[++i] || '30m');
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
      case '--no-open':
        options.openBrowser = false;
        break;
      case '-l': {
        const next = args[i + 1];
        const v = parseInt(next);
        listSessionsLimit = !isNaN(v) ? v : 10;
        if (!isNaN(v)) i++;
        break;
      }
      case '-a': {
        const next = args[i + 1];
        const v = parseInt(next);
        if (!isNaN(v)) { listActiveLimit = v; i++; }
        else { listActiveLimit = -1; }
        break;
      }
      case '-v':
        showVersion = true;
        break;
      case '-h':
      case '--help':
        showHelp = true;
        break;
      case 'update':
        doUpdate = true;
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          printHelp();
          process.exit(1);
        }
    }
  }

  // Execute action flags
  if (showVersion) {
    printVersion();
    return;
  }
  if (showHelp) {
    printHelp();
    return;
  }
  if (doUpdate) {
    await runUpdate();
    return;
  }
  if (listSessionsLimit > 0) {
    const sessions = await listSessions(listSessionsLimit);
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
  if (listActiveLimit !== 0) {
    const limit = listActiveLimit > 0 ? listActiveLimit : 0;
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

  checkForUpdate();
  startServer(options);
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
