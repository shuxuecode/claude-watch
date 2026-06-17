'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');
var cp = require('child_process');
var readline = require('readline');
var { WebSocketServer } = require('ws');
var { compareVersions } = require('../cli-helpers');
var { Watcher, listSessions, listActiveSessions } = require('../watcher/watcher');
var { setDebugAll, contextWindowFor } = require('../parser/parser');
var { fullScanTokenUsage } = require('../scanner/scanner');

var PACKAGE_VERSION = require('../../package.json').version;

function fetchLatestVersion() {
  return new Promise(function(resolve, reject) {
    var opts = {
      hostname: 'registry.npmjs.org',
      path: '/claude-code-watch/latest',
      timeout: 5000,
    };
    var req = require('https').get(opts, function(res) {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve(JSON.parse(data).version); }
        catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

var MAX_ITEM_BUFFER = 9999;
var CONTEXT_STALE_MS = 60 * 60 * 1000; // 60 minutes

class DashboardServer {
  constructor(options = {}) {
    this.port = options.port || 23000;
    this.host = options.host || '127.0.0.1';
    this.collapseAfterMs = options.collapseAfter || 0;
    this.watcher = null;
    this.clients = new Set();
    this.itemBuffer = [];
    this.contextMap = new Map();
    this._contextCleanupTimer = null;
    this._pendingItems = [];
    this._flushTimer = null;
    this._tokenStatsDirty = false;

    // Incremental last-activity tracking: "sessionID:agentID" → { toolName, content }
    this.lastActivities = new Map();

    // Time-series token stats: daily aggregation (never cleaned up)
    // Key: "YYYY-MM-DD", value: { messages, input, output, cacheCreation, cacheRead, models: { modelName: { input, output, cacheCreation, cacheRead } } }
    this.dailyStats = new Map();

    // Hourly distribution: 24-hour array of API call counts (local timezone)
    this.hourlyStats = new Array(24).fill(0);

    this.server = null;
    this.wss = null;
    this._heartbeatTimer = null;
    this._allowedPrefix = null;
    this.latestVersion = null;
    this._versionCheckTimer = null;

    setDebugAll(options.debugAll || false);
    this.debugAll = options.debugAll || false;
  }

  getCtxKey(sessionID, agentID) {
    return sessionID + ':' + (agentID || '');
  }

  async _getAllowedPrefix() {
    if (!this._allowedPrefix) {
      const homeReal = await fs.promises.realpath(os.homedir());
      this._allowedPrefix = path.join(homeReal, '.claude', 'projects');
    }
    return this._allowedPrefix;
  }

  itemTime(item) {
    if (item.timestamp) {
      const ts = item.timestamp instanceof Date ? item.timestamp : new Date(item.timestamp);
      if (!isNaN(ts.getTime())) return ts.getTime();
    }
    return Date.now();
  }

  _getDateKey(ts) {
    let d = new Date(ts);
    if (isNaN(d.getTime())) d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  updateContext(item) {
    const key = this.getCtxKey(item.sessionID, item.agentID);
    let ctx = this.contextMap.get(key);
    if (!ctx) {
      ctx = { inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0, model: '', contextWindow: 200000, lastActivity: this.itemTime(item) };
      this.contextMap.set(key, ctx);
    }
    // inputTokens: Claude API returns cumulative total per call, not incremental — use Math.max
    // outputTokens/cache tokens: API returns incremental values — use +=
    if (item.inputTokens) ctx.inputTokens = Math.max(ctx.inputTokens, item.inputTokens);
    if (item.outputTokens) ctx.outputTokens += item.outputTokens;
    if (item.cacheCreationTokens) ctx.cacheCreation += item.cacheCreationTokens;
    if (item.cacheReadTokens) ctx.cacheRead += item.cacheReadTokens;
    if (item.model) {
      ctx.model = item.model;
      ctx.contextWindow = contextWindowFor(item.model);
    }
    ctx.lastActivity = Math.max(ctx.lastActivity || 0, this.itemTime(item));

    // ── Time-series aggregation for token stats ──
    // All 4 token fields are summed (incremental for billing/consumption perspective)
    const hasTokens = item.inputTokens || item.outputTokens || item.cacheCreationTokens || item.cacheReadTokens;
    if (hasTokens) {
      const dateKey = this._getDateKey(this.itemTime(item));
      let day = this.dailyStats.get(dateKey);
      if (!day) {
        day = { messages: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, models: {} };
        this.dailyStats.set(dateKey, day);
      }
      day.messages++;
      if (item.inputTokens) day.input += item.inputTokens;
      if (item.outputTokens) day.output += item.outputTokens;
      if (item.cacheCreationTokens) day.cacheCreation += item.cacheCreationTokens;
      if (item.cacheReadTokens) day.cacheRead += item.cacheReadTokens;

      // Hourly distribution: increment the hour bucket
      const tsDate = new Date(this.itemTime(item));
      if (!isNaN(tsDate.getTime())) {
        this.hourlyStats[tsDate.getHours()]++;
      }

      // Per-model breakdown within this day
      if (item.model) {
        let m = day.models[item.model];
        if (!m) {
          m = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
          day.models[item.model] = m;
        }
        if (item.inputTokens) m.input += item.inputTokens;
        if (item.outputTokens) m.output += item.outputTokens;
        if (item.cacheCreationTokens) m.cacheCreation += item.cacheCreationTokens;
        if (item.cacheReadTokens) m.cacheRead += item.cacheReadTokens;
      }
    }
  }

  cleanupContextMap() {
    const now = Date.now();
    for (const [key, ctx] of this.contextMap) {
      if (now - ctx.lastActivity > CONTEXT_STALE_MS) {
        this.contextMap.delete(key);
      }
    }
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

  getTokenStatsSnapshot() {
    // Convert dailyStats Map to plain object, sorted by date descending
    const daily = {};
    const sortedKeys = [...this.dailyStats.keys()].sort().reverse();
    for (const k of sortedKeys) {
      const d = this.dailyStats.get(k);
      daily[k] = {
        messages: d.messages,
        input: d.input,
        output: d.output,
        cacheCreation: d.cacheCreation,
        cacheRead: d.cacheRead,
        models: d.models,
      };
    }

    // Compute global totals
    let totalMessages = 0, totalInput = 0, totalOutput = 0, totalCacheCreation = 0, totalCacheRead = 0;
    const modelTotals = {};
    for (const [, d] of this.dailyStats) {
      totalMessages += d.messages;
      totalInput += d.input;
      totalOutput += d.output;
      totalCacheCreation += d.cacheCreation;
      totalCacheRead += d.cacheRead;
      for (const [modelName, m] of Object.entries(d.models)) {
        if (!modelTotals[modelName]) modelTotals[modelName] = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
        modelTotals[modelName].input += m.input;
        modelTotals[modelName].output += m.output;
        modelTotals[modelName].cacheCreation += m.cacheCreation;
        modelTotals[modelName].cacheRead += m.cacheRead;
      }
    }

    return {
      totals: { messages: totalMessages, input: totalInput, output: totalOutput, cacheCreation: totalCacheCreation, cacheRead: totalCacheRead, days: this.dailyStats.size },
      modelTotals,
      daily,
      hourly: this.hourlyStats,
    };
  }

  broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload });
    const toRemove = [];
    for (const ws of this.clients) {
      if (ws.readyState === 1) {
        try { ws.send(msg); } catch { toRemove.push(ws); }
      }
    }
    for (const ws of toRemove) {
      this.clients.delete(ws);
      try { ws.terminate(); } catch (err) {
        if (this.debugAll) console.error('[server] terminate error:', err.message);
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
      // Vendor files (highlight.js, marked, DOMPurify, CSS) are versioned with the
      // package and rarely change — cache for 1 year. Everything else (index.html,
      // favicon) stays no-cache to ensure users always get the latest.
      const isVendor = filePath.includes('/vendor/');
      const cacheControl = isVendor
        ? 'public, max-age=31536000, immutable'
        : 'no-cache, no-store, must-revalidate';
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': cacheControl,
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
  }

  async handleHTTP(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    if (p === '/' || p === '/index.html') {
      await this.serveStatic(res, path.join(__dirname, '../../public/index.html'));
      return;
    }

    if (p.startsWith('/api/')) {
      await this.handleAPI(req, res, url);
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

  async handleAPI(req, res, url) {
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
          realCwd: s.realCwd,
          isObserver: s.isObserver,
          observedRequest: s.observedRequest,
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

    if (route === '/token-stats') {
      this.sendJSON(res, this.getTokenStatsSnapshot());
      return;
    }

    if (route === '/task-output') {
      const filePath = params.get('path');
      if (!filePath) { this.sendJSON(res, { error: 'Missing path param' }, 400); return; }
      const resolved = path.resolve(filePath);
      // Resolve both the user-provided path AND the allowed prefix through realpath
      // to ensure consistent comparison even if homedir contains symlinks
      let realPath;
      let allowedPrefix;
      try {
        allowedPrefix = await this._getAllowedPrefix();
        realPath = await fs.promises.realpath(resolved);
        if (!realPath.startsWith(allowedPrefix)) {
          this.sendJSON(res, { error: 'Access denied' }, 403);
          return;
        }
      } catch {
        // realpath fails for non-existent files or if homedir can't be resolved — block them
        this.sendJSON(res, { error: 'Access denied' }, 403);
        return;
      }
      try {
        const content = await fs.promises.readFile(realPath, 'utf-8');
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
      } catch (err) {
        if (this.debugAll) console.error('[server] WS message error:', err.message);
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
    });

    ws.on('error', (err) => {
      if (this.debugAll) console.error('[server] WS client error:', err.message);
    });

    this.sendSnapshot(ws);
    this.sendItemBatch(ws);
    this.sendContext(ws);
    this.sendTokenStats(ws);
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
        if (typeof cmd.sessionID === 'string' && cmd.sessionID) {
          this.watcher.removeSession(cmd.sessionID);
          this.broadcast('sessionRemoved', { sessionID: cmd.sessionID });
        }
        break;
      case 'setSkipHistory':
        this.watcher.setSkipHistory(cmd.skip === true);
        break;
      case 'getContext':
        this.sendContext(ws);
        break;
      default:
        break;
    }
  }

  send(ws, type, payload) {
    try { ws.send(JSON.stringify({ type, payload })); } catch {}
  }

  sendTokenStats(ws) {
    this.send(ws, 'tokenStats', this.getTokenStatsSnapshot());
  }

  sendSnapshot(ws) {
    if (!this.watcher) return;
    const sessions = this.watcher.getSessionsSnapshot().map(s => ({
      id: s.id,
      projectPath: s.projectPath,
      realCwd: s.realCwd,
      isObserver: s.isObserver,
      observedRequest: s.observedRequest,
      birthtimeMs: s.birthtimeMs || 0,
      subagents: Object.entries(s.subagentTypes || s.subagents || {}).reduce((acc, [id, type]) => {
        acc[id] = { type: typeof type === 'string' ? type : '', birthtimeMs: (s.subagentBirthtimes && s.subagentBirthtimes[id]) || 0 };
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
    // Use incrementally maintained lastActivities map (O(1) instead of O(itemBuffer))
    const lastActivities = {};
    for (const [key, val] of this.lastActivities) {
      lastActivities[key] = val;
    }
    this.send(ws, 'snapshot', {
      sessions,
      autoDiscovery: this.watcher.isAutoDiscoveryEnabled(),
      lastActivities,
    });
  }

  sendItemBatch(ws) {
    this.send(ws, 'itemBatch', this.itemBuffer);
  }

  sendContext(ws) {
    this.send(ws, 'context', this.getContextSnapshot());
  }

  sendConfig(ws) {
    this.send(ws, 'config', { collapseAfter: this.collapseAfterMs, version: PACKAGE_VERSION, latestVersion: this.latestVersion });
  }

  _checkLatestVersion() {
    fetchLatestVersion().then((latest) => {
      if (compareVersions(latest, PACKAGE_VERSION) > 0) {
        this.latestVersion = latest;
        // Notify all connected clients
        this.broadcast('config', { collapseAfter: this.collapseAfterMs, version: PACKAGE_VERSION, latestVersion: latest });
      }
    }).catch(() => { /* network unavailable, skip */ });
  }

  setupWatcher(watcherOpts) {
    const w = new Watcher(watcherOpts);
    this.watcher = w;

    w.on('sessionRemoved', ({ sessionID }) => {
      for (const key of this.contextMap.keys()) {
        if (key.startsWith(sessionID + ':')) this.contextMap.delete(key);
      }
      for (const key of this.lastActivities.keys()) {
        if (key.startsWith(sessionID + ':')) this.lastActivities.delete(key);
      }
    });

    const FLUSH_BATCH_LIMIT = 50;
    w.on('item', (item) => {
      this.itemBuffer.push(item);
      if (this.itemBuffer.length > MAX_ITEM_BUFFER) {
        this.itemBuffer = this.itemBuffer.slice(-MAX_ITEM_BUFFER);
      }
      this.updateContext(item);

      // Incrementally track last activity per agent
      if (item.type === 'user_text') {
        const actKey = item.sessionID + ':' + (item.agentID || '');
        this.lastActivities.set(actKey, { toolName: '', content: (item.content || '').slice(0, 200) });
      } else if (item.type === 'tool_input' && item.agentID) {
        const actKey = item.sessionID + ':' + item.agentID;
        this.lastActivities.set(actKey, { toolName: item.toolName || '', content: (item.content || '').slice(0, 200) });
      }

      this._pendingItems.push(item);
      // Track if any item in this batch has token data (for tokenStats broadcast)
      if (item.inputTokens || item.outputTokens || item.cacheCreationTokens || item.cacheReadTokens) {
        this._tokenStatsDirty = true;
      }
      if (this._pendingItems.length >= FLUSH_BATCH_LIMIT) {
        // Batch size hit limit — flush immediately
        if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
        const batch = this._pendingItems;
        this._pendingItems = [];
        this.broadcast('itemBatch', batch);
        this.broadcast('context', this.getContextSnapshot());
        if (this._tokenStatsDirty) {
          this._tokenStatsDirty = false;
          this.broadcast('tokenStats', this.getTokenStatsSnapshot());
        }
      } else if (!this._flushTimer) {
        this._flushTimer = setTimeout(() => {
          this._flushTimer = null;
          const batch = this._pendingItems;
          this._pendingItems = [];
          if (batch.length === 1) {
            this.broadcast('item', batch[0]);
          } else if (batch.length > 1) {
            this.broadcast('itemBatch', batch);
          }
          this.broadcast('context', this.getContextSnapshot());
          if (this._tokenStatsDirty) {
            this._tokenStatsDirty = false;
            this.broadcast('tokenStats', this.getTokenStatsSnapshot());
          }
        }, 50);
      }
    });
    w.on('broadcast', (type, payload) => {
      this.broadcast(type, payload);
    });

    return w;
  }

  async killExistingPort(port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${port}`);
    }
    let cmd;
    if (process.platform === 'win32') {
      cmd = `netstat -ano | findstr :${port} | findstr LISTENING`;
    } else {
      cmd = `lsof -ti:${port}`;
    }
    try {
      const result = cp.execSync(cmd, { encoding: 'utf-8' }).trim();
      if (!result) return false;
      let pids = result.split('\n').map(s => s.trim()).filter(Boolean);
      if (process.platform === 'win32') {
        pids = pids.map(line => line.split(/\s+/).pop());
      }

      // Ask user for confirmation before killing
      const confirmed = await askYesNo(`Port ${port} is occupied by process(es) ${pids.join(', ')}. Kill them? [y/N] `);
      if (!confirmed) {
        console.error(`Port ${port} is in use. Exiting.`);
        this.stop();
        process.exit(1);
      }

      const myPid = process.pid;
      for (const pid of pids) {
        const parsedPid = parseInt(pid, 10);
        if (Number.isInteger(parsedPid) && parsedPid > 1 && parsedPid !== myPid) {
          try {
            if (process.platform === 'win32') {
              cp.execSync(`taskkill /PID ${parsedPid} /F`, { encoding: 'utf-8' });
            } else {
              process.kill(parsedPid, 'SIGTERM');
            }
          } catch (err) {
            console.error(`[server] Failed to SIGTERM pid ${parsedPid}: ${err.message}`);
          }
        }
      }

      // Wait for graceful shutdown, then escalate to SIGKILL if still alive
      if (process.platform !== 'win32') {
        await new Promise(r => setTimeout(r, 3000));
        for (const pid of pids) {
          const parsedPid = parseInt(pid, 10);
          if (Number.isInteger(parsedPid) && parsedPid > 1 && parsedPid !== myPid) {
            try { process.kill(parsedPid, 0); process.kill(parsedPid, 'SIGKILL'); } catch {
              // Process already gone — nothing to do
            }
          }
        }
      }

      // Wait briefly for the port to be released
      await new Promise(r => setTimeout(r, 500));
      return true;
    } catch {
      return false;
    }
  }

  async start(options = {}) {
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) {
      throw new Error(`Invalid port: ${this.port}`);
    }
    const skipHistory = options.skipHistory || false;
    const pollMs = options.pollMs || 500;
    const activeWindow = options.activeWindow || 100 * 60 * 1000;
    const maxSessions = options.maxSessions || 0;
    const openBrowser = options.openBrowser !== false;

    const watcherOpts = {
      sessionID: options.sessionID || '',
      pollInterval: pollMs,
      activeWindow,
      maxSessions,
      debugAll: this.debugAll,
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

    this.wss = new WebSocketServer({ server: this.server, maxPayload: 1024 * 1024 });
    this.wss.on('connection', (ws) => this.onWsConnection(ws));

    // Register error handler once (not inside doListen to avoid accumulation)
    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${this.port} is still in use after attempting to free it. Exiting.`);
        this.stop();
        process.exit(1);
      } else {
        console.error(`Server error: ${err.message}`);
        this.stop();
        process.exit(1);
      }
    });

    // ── Full-scan historical JSONL files for token stats ──
    // This runs BEFORE watcher starts, scanning ALL files regardless of age
    console.log('  Scanning historical token data...');
    try {
      const scanned = await fullScanTokenUsage((done, total) => {
        if (total > 0 && (done % 100 === 0 || done === total)) {
          console.log(`  Scanned ${done}/${total} files...`);
        }
      });
      // Merge scanned data into this.dailyStats and this.hourlyStats
      for (const [dateStr, day] of scanned.dailyStats) {
        this.dailyStats.set(dateStr, day);
      }
      for (let h = 0; h < 24; h++) {
        this.hourlyStats[h] += scanned.hourlyStats[h];
      }
      const totalDays = this.dailyStats.size;
      const totalMsgs = [...this.dailyStats.values()].reduce((s, d) => s + d.messages, 0);
      console.log(`  Token scan complete: ${totalDays} days, ${totalMsgs.toLocaleString()} messages`);
    } catch (err) {
      console.error('  Token scan error (non-critical, continuing):', err.message);
    }

    const w = this.setupWatcher(watcherOpts);

    try {
      await w.init();
      if (skipHistory) w.setSkipHistory(true);
      await w.start();
    } catch (err) {
      console.error('Watcher init error:', err.message);
      this.stop();
      process.exit(1);
    }

    this._contextCleanupTimer = setInterval(() => this.cleanupContextMap(), CONTEXT_STALE_MS);
    this._heartbeatTimer = setInterval(() => this.broadcast('heartbeat', null), 30000);

    // Check for latest version on startup and periodically (every hour)
    this._checkLatestVersion();
    this._versionCheckTimer = setInterval(() => this._checkLatestVersion(), 60 * 60 * 1000);

    // Start listening and wait for server to be ready before opening browser
    await new Promise((resolve) => {
      this.server.listen(this.port, this.host, () => {
        const url = `http://localhost:${this.port}`;
        console.log(`\n  claude-watch web server`);
        console.log(`  ───────────────────────────`);
        console.log(`  Local:   ${url}`);
        console.log(`  Network: http://${this.host}:${this.port}`);
        console.log(`  Quit:    Ctrl+C\n`);
        resolve();
      });
    });

    // Open browser AFTER server is confirmed listening and watcher is ready
    if (openBrowser) {
      const url = `http://localhost:${this.port}`;
      const platform = process.platform;
      if (platform === 'darwin') {
        cp.spawn('open', [url]);
      } else if (platform === 'win32') {
        cp.spawn('cmd', ['/c', 'start', '', url]);
      } else {
        cp.spawn('xdg-open', [url]);
      }
    }

    return { server: this.server, watcher: w };
  }

  stop() {
    if (this._contextCleanupTimer) clearInterval(this._contextCleanupTimer);
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    if (this._versionCheckTimer) clearInterval(this._versionCheckTimer);
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._pendingItems.length > 0) {
      this.broadcast('itemBatch', this._pendingItems);
      this._pendingItems = [];
    }
    if (this.wss) this.wss.close();
    if (this.server) this.server.close();
    if (this.watcher) this.watcher.stop();
    this.clients.clear();
  }
}

async function startServer(options = {}) {
  const ds = new DashboardServer(options);
  const shutdown = () => {
    ds.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return ds.start(options);
}

function askYesNo(prompt) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

module.exports = { DashboardServer, startServer };
