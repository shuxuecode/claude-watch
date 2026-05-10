'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const { WebSocketServer } = require('ws');
const { Watcher, listSessions, listActiveSessions } = require('../watcher/watcher');
const { setDebugAll, contextWindowFor, formatTokenCount } = require('../parser/parser');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const MAX_ITEM_BUFFER = 2000;

class DashboardServer {
  constructor(options = {}) {
    this.port = options.port || 23000;
    this.host = options.host || '127.0.0.1';
    this.collapseAfterMs = options.collapseAfter || 0;
    this.watcher = null;
    this.clients = new Set();
    this.itemBuffer = [];
    this.contextMap = new Map();

    this.server = null;
    this.wss = null;

    setDebugAll(options.debugAll || false);
  }

  getCtxKey(sessionID, agentID) {
    return sessionID + ':' + (agentID || '');
  }

  updateContext(item) {
    const key = this.getCtxKey(item.sessionID, item.agentID);
    let ctx = this.contextMap.get(key);
    if (!ctx) {
      ctx = { inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0, model: '', contextWindow: 200000, lastActivity: Date.now() };
      this.contextMap.set(key, ctx);
    }
    if (item.inputTokens) ctx.inputTokens += item.inputTokens;
    if (item.outputTokens) ctx.outputTokens += item.outputTokens;
    if (item.cacheCreationTokens) ctx.cacheCreation += item.cacheCreationTokens;
    if (item.cacheReadTokens) ctx.cacheRead += item.cacheReadTokens;
    if (item.model) {
      ctx.model = item.model;
      ctx.contextWindow = contextWindowFor(item.model);
    }
    ctx.lastActivity = Date.now();
  }

  getContextSnapshot() {
    const result = {};
    for (const [key, ctx] of this.contextMap) {
      result[key] = {
        inputTokens: ctx.inputTokens,
        outputTokens: ctx.outputTokens,
        cacheCreation: ctx.cacheCreation,
        cacheRead: ctx.cacheRead,
        model: ctx.model,
        contextWindow: ctx.contextWindow,
        lastActivity: ctx.lastActivity,
      };
    }
    return result;
  }

  broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload });
    for (const ws of this.clients) {
      if (ws.readyState === 1) {
        try { ws.send(msg); } catch {}
      }
    }
  }

  sendJSON(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  async serveStatic(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    try {
      const data = await fs.promises.readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
  }

  async handleHTTP(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (p === '/' || p === '/index.html') {
      await this.serveStatic(res, path.join(__dirname, '../../public/index.html'));
      return;
    }

    if (p.startsWith('/api/')) {
      this.handleAPI(req, res, url);
      return;
    }

    // Prevent path traversal
    const resolved = path.resolve(path.join(__dirname, '../../public', p));
    if (!resolved.startsWith(path.resolve(path.join(__dirname, '../../public')))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    await this.serveStatic(res, resolved);
  }

  handleAPI(req, res, url) {
    const route = url.pathname.slice('/api'.length);
    const params = url.searchParams;

    if (route === '/sessions') {
      listSessions(20).then(s => this.sendJSON(res, s)).catch(() => this.sendJSON(res, [], 500));
      return;
    }

    if (route === '/sessions/active') {
      const w = parseInt(params.get('window')) || 5 * 60 * 1000;
      listActiveSessions(w).then(s => this.sendJSON(res, s)).catch(() => this.sendJSON(res, [], 500));
      return;
    }

    if (route === '/status') {
      this.sendJSON(res, {
        sessions: this.watcher ? this.watcher.getSessionsSnapshot().map(s => ({
          id: s.id,
          projectPath: s.projectPath,
          agentCount: Object.keys(s.subagents).length,
          taskCount: Object.keys(s.backgroundTasks).length,
        })) : [],
        autoDiscovery: this.watcher ? this.watcher.isAutoDiscoveryEnabled() : true,
        itemBufferSize: this.itemBuffer.length,
        context: this.getContextSnapshot(),
      });
      return;
    }

    if (route === '/context') {
      this.sendJSON(res, this.getContextSnapshot());
      return;
    }

    if (route === '/task-output') {
      const filePath = params.get('path');
      if (!filePath) { this.sendJSON(res, { error: 'Missing path param' }, 400); return; }
      try {
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(path.resolve(os.homedir(), '.claude', 'projects'))) {
          this.sendJSON(res, { error: 'Access denied' }, 403);
          return;
        }
        const content = fs.readFileSync(resolved, 'utf-8');
        this.sendJSON(res, { content });
      } catch (err) {
        this.sendJSON(res, { error: err.message }, 404);
      }
      return;
    }

    this.sendJSON(res, { error: 'Not Found' }, 404);
  }

  onWsConnection(ws) {
    this.clients.add(ws);

    ws.on('message', (data) => {
      try {
        const cmd = JSON.parse(data.toString('utf-8'));
        this.handleCommand(ws, cmd);
      } catch {}
    });

    ws.on('close', () => {
      this.clients.delete(ws);
    });

    ws.on('error', () => {});

    this.sendSnapshot(ws);
    this.sendItemBatch(ws);
    this.sendContext(ws);
    this.sendConfig(ws);
  }

  handleCommand(ws, cmd) {
    if (!this.watcher) return;

    switch (cmd.action) {
      case 'toggleAutoDiscovery':
        this.watcher.toggleAutoDiscovery();
        this.broadcast('autoDiscoveryChanged', { enabled: this.watcher.isAutoDiscoveryEnabled() });
        break;
      case 'removeSession':
        this.watcher.removeSession(cmd.sessionID);
        this.broadcast('sessionRemoved', { sessionID: cmd.sessionID });
        break;
      case 'setSkipHistory':
        this.watcher.setSkipHistory(cmd.skip);
        break;
      case 'getContext':
        this.sendContext(ws);
        break;
      default:
        break;
    }
  }

  sendSnapshot(ws) {
    if (!this.watcher) return;
    const sessions = this.watcher.getSessionsSnapshot().map(s => ({
      id: s.id,
      projectPath: s.projectPath,
      subagents: Object.entries(s.subagentTypes || s.subagents || {}).reduce((acc, [id, type]) => {
        acc[id] = typeof type === 'string' ? type : '';
        return acc;
      }, {}),
      backgroundTasks: Object.entries(s.backgroundTasks || {}).map(([id, t]) => ({
        id,
        parentAgentID: t.parentAgentID,
        toolName: t.toolName,
        outputPath: t.outputPath,
        isComplete: t.isComplete,
      })),
    }));
    try {
      ws.send(JSON.stringify({
        type: 'snapshot',
        payload: {
          sessions,
          autoDiscovery: this.watcher.isAutoDiscoveryEnabled(),
        },
      }));
    } catch {}
  }

  sendItemBatch(ws) {
    try {
      ws.send(JSON.stringify({ type: 'itemBatch', payload: this.itemBuffer }));
    } catch {}
  }

  sendContext(ws) {
    try {
      ws.send(JSON.stringify({ type: 'context', payload: this.getContextSnapshot() }));
    } catch {}
  }

  sendConfig(ws) {
    try {
      ws.send(JSON.stringify({ type: 'config', payload: { collapseAfter: this.collapseAfterMs } }));
    } catch {}
  }

  setupWatcher(watcherOpts) {
    const w = new Watcher(watcherOpts);
    this.watcher = w;

    w.on('sessionRemoved', ({ sessionID }) => {
      for (const key of this.contextMap.keys()) {
        if (key.startsWith(sessionID + ':')) this.contextMap.delete(key);
      }
    });

    w.on('item', (item) => {
      this.itemBuffer.push(item);
      if (this.itemBuffer.length > MAX_ITEM_BUFFER) {
        const excess = this.itemBuffer.length - MAX_ITEM_BUFFER;
        this.itemBuffer.copyWithin(0, excess);
        this.itemBuffer.length = MAX_ITEM_BUFFER;
      }
      this.updateContext(item);
      this.broadcast('item', item);
    });
    w.on('broadcast', (type, payload) => {
      this.broadcast(type, payload);
    });

    return w;
  }

  async killExistingPort(port) {
    let cmd;
    if (process.platform === 'win32') {
      cmd = `netstat -ano | findstr :${port} | findstr LISTENING`;
    } else {
      cmd = `lsof -ti:${port}`;
    }
    try {
      const result = cp.execSync(cmd, { encoding: 'utf-8' }).trim();
      if (!result) return false;
      const pids = result.split('\n').map(s => s.trim()).filter(Boolean);
      for (const pid of pids) {
        try {
          if (process.platform === 'win32') {
            cp.execSync(`taskkill /PID ${pid} /F`, { encoding: 'utf-8' });
          } else {
            process.kill(parseInt(pid, 10), 'SIGKILL');
          }
        } catch {}
      }
      // Wait briefly for the port to be released
      await new Promise(r => setTimeout(r, 500));
      return true;
    } catch {
      return false;
    }
  }

  async start(options = {}) {
    const skipHistory = options.skipHistory || false;
    const pollMs = options.pollMs || 500;
    const activeWindow = options.activeWindow || 5 * 60 * 1000;
    const maxSessions = options.maxSessions || 0;

    const watcherOpts = {
      sessionID: options.sessionID || '',
      pollInterval: pollMs,
      activeWindow,
      maxSessions,
    };

    // Proactively kill any process occupying the port before starting
    const killed = await this.killExistingPort(this.port);
    if (killed) {
      console.log(`Previous instance on port ${this.port} killed, restarting...`);
    }

    this.server = http.createServer((req, res) => {
      this.handleHTTP(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      });
    });

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => this.onWsConnection(ws));

    // Register error handler once (not inside doListen to avoid accumulation)
    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${this.port} is still in use after attempting to free it. Exiting.`);
        process.exit(1);
      } else {
        console.error(`Server error: ${err.message}`);
        process.exit(1);
      }
    });

    const w = this.setupWatcher(watcherOpts);

    w.init().then(() => {
      if (skipHistory) w.setSkipHistory(true);
      w.start();

      // Open browser AFTER sessions are discovered, so new clients get a full snapshot
      const url = `http://localhost:${this.port}`;
      const platform = process.platform;
      if (platform === 'darwin') {
        cp.spawn('open', [url]);
      } else if (platform === 'win32') {
        cp.spawn('cmd', ['/c', 'start', '', url]);
      } else {
        cp.spawn('xdg-open', [url]);
      }
    }).catch(err => {
      console.error('Watcher init error:', err.message);
      process.exit(1);
    });

    this.server.listen(this.port, this.host, () => {
      const url = `http://localhost:${this.port}`;
      console.log(`\n  claude-watch web server`);
      console.log(`  ───────────────────────────`);
      console.log(`  Local:   ${url}`);
      console.log(`  Network: http://${this.host}:${this.port}`);
      console.log(`  Quit:    Ctrl+C\n`);
    });

    return { server: this.server, watcher: w };
  }

  stop() {
    if (this.wss) this.wss.close();
    if (this.server) this.server.close();
    if (this.watcher) this.watcher.stop();
    this.clients.clear();
  }
}

async function startServer(options = {}) {
  const ds = new DashboardServer(options);
  return ds.start(options);
}

module.exports = { DashboardServer, startServer };