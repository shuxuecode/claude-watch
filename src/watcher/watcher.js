'use strict';

var fs = require('fs');
var fsp = require('fs/promises');
var path = require('path');
var os = require('os');
var readline = require('readline');
var chokidar = require('chokidar');
var { EventEmitter } = require('events');
var { parseLine, AgentIDDisplayLength } = require('../parser/parser');

// ============================================================================
// Constants
// ============================================================================

var AutoSkipLineThreshold = 100;
var KeepRecentLines = 10;
var CleanupInterval = 5 * 60 * 1000;
var FsnotifyDiscoveryInterval = 60 * 1000;
var RecentActivityThreshold = 2 * 60 * 1000;
var DebounceInterval = 50;

// ============================================================================
// Helpers
// ============================================================================

function getClaudeProjectsDir() {
  if (process.env.CLAUDE_HOME) {
    return path.join(process.env.CLAUDE_HOME, 'projects');
  }
  return path.join(os.homedir(), '.claude', 'projects');
}

function resolveProjectPath(encoded) {
  let s = encoded;
  if (s.startsWith('-')) s = s.slice(1);
  if (!s) return '';

  const parts = s.split('-');

  // Try progressively joining segments from the right with dashes
  for (let joinFrom = parts.length - 1; joinFrom >= 1; joinFrom--) {
    const pathPart = parts.slice(0, joinFrom).join('/');
    const dirPart = parts.slice(joinFrom).join('-');
    const testPath = `/${pathPart}/${dirPart}`;
    try {
      fs.accessSync(testPath);
      return `${pathPart}/${dirPart}`;
    } catch {
      // Path doesn't exist, try next combination
    }
  }

  // Fallback to naive conversion
  return s.replace(/-/g, '/');
}

function isMainSessionFile(filePath, stats) {
  if (stats && stats.isDirectory()) return false;
  if (!filePath.endsWith('.jsonl')) return false;
  if (filePath.includes('/subagents/')) return false;
  const basename = path.basename(filePath);
  if (basename.startsWith('agent-')) return false;
  return true;
}

async function readAgentType(jsonlPath) {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
  try {
    const data = await fsp.readFile(metaPath, 'utf-8');
    const meta = JSON.parse(data);
    return meta.agentType || '';
  } catch {
    return '';
  }
}

// ============================================================================
// Session class
// ============================================================================

class Session {
  constructor(id, projectPath, mainFile) {
    this.id = id;
    this.projectPath = projectPath;
    this.mainFile = mainFile;
    this.subagents = {};       // agentID -> file path
    this.subagentTypes = {};   // agentID -> agentType
    this.backgroundTasks = {}; // toolID -> BackgroundTask
    this.toolIndex = new Map(); // toolID -> { toolName, parentAgentID, hasResult }
    this.toolIndexPopulated = false;
  }
}

class BackgroundTask {
  constructor(toolID, parentAgentID, toolName, outputPath, isComplete) {
    this.toolID = toolID;
    this.parentAgentID = parentAgentID;
    this.toolName = toolName;
    this.outputPath = outputPath;
    this.isComplete = isComplete;
  }
}

// ============================================================================
// Watcher class
// ============================================================================

class Watcher extends EventEmitter {
  constructor({ sessionID, pollInterval, activeWindow, maxSessions, debugAll } = {}) {
    super();
    this.claudeDir = getClaudeProjectsDir();
    this.pollInterval = pollInterval || 500;
    this.activeWindow = activeWindow || 100 * 60 * 1000;
    this.maxSessions = maxSessions || 0;
    this.sessions = new Map();
    this.filePositions = new Map();
    this.watchActive = !sessionID; // watch all active if no specific session
    this.skipHistory = false;

    // chokidar fields
    this.watcher = null;
    this.useFsnotify = false;
    this.fileContexts = new Map();
    this.debounceTimers = new Map();
    this.pendingSubagents = new Map();
    this._readLocks = new Map();
    this._pollRunning = false;

    // Intervals / timers
    this._cleanupTimer = null;
    this._discoveryTimer = null;
    this._pollTimer = null;
    this._running = false;
    this.debug = debugAll || false;

    this._sessionID = sessionID || '';
  }

  // =========================================================================
  // Initialization
  // =========================================================================

  async init() {
    // Try to set up chokidar
    try {
      this.watcher = chokidar.watch([], {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: false,
        usePolling: false,
        interval: 100,
      });
      this.useFsnotify = true;
    } catch {
      this.useFsnotify = false;
    }

    if (this._sessionID) {
      const session = await this.findSession(this._sessionID);
      if (session) {
        this.sessions.set(session.id, session);
      }
    } else {
      await this.discoverActiveSessions();
    }

    return this;
  }

  // =========================================================================
  // Session discovery
  // =========================================================================

  async findSession(sessionID) {
    const jsonlFiles = [];
    try {
      await this._walkDir(this.claudeDir, (filePath, stats) => {
        if (isMainSessionFile(filePath, stats)) {
          jsonlFiles.push(filePath);
        }
      });
    } catch {
      // Dir may not exist
    }

    if (jsonlFiles.length === 0) return null;

    // Sort by mtime (most recent first)
    jsonlFiles.sort((a, b) => {
      try {
        const sa = fs.statSync(a);
        const sb = fs.statSync(b);
        return sb.mtimeMs - sa.mtimeMs;
      } catch {
        return 0;
      }
    });

    let mainFile;
    if (sessionID) {
      mainFile = jsonlFiles.find(f => f.includes(sessionID));
      if (!mainFile) return null;
    } else {
      mainFile = jsonlFiles[0];
    }

    return this.buildSession(mainFile);
  }

  async buildSession(mainFile) {
    const base = path.basename(mainFile);
    const id = base.replace(/\.jsonl$/, '');
    const projectDir = path.basename(path.dirname(mainFile));
    const projectPath = resolveProjectPath(projectDir);

    const session = new Session(id, projectPath, mainFile);

    // Find subagent files
    const subagentDir = path.join(path.dirname(mainFile), id, 'subagents');
    try {
      const entries = await fsp.readdir(subagentDir);
      for (const entry of entries) {
        if (entry.endsWith('.jsonl')) {
          const agentID = entry.replace(/^agent-/, '').replace(/\.jsonl$/, '');
          const jsonlPath = path.join(subagentDir, entry);
          session.subagents[agentID] = jsonlPath;
          const agentType = await readAgentType(jsonlPath);
          if (agentType) {
            session.subagentTypes[agentID] = agentType;
          }
        }
      }
    } catch (err) {
      if (this.debug) console.error('[watcher] buildSession subagent scan error:', err.message);
    }

    return session;
  }

  async discoverActiveSessions() {
    const now = Date.now();
    const discovered = [];

    try {
      await this._walkDir(this.claudeDir, (filePath, stats) => {
        if (!isMainSessionFile(filePath, stats)) return;
        if (now - stats.mtimeMs > this.activeWindow) return;
        discovered.push({ filePath, modTime: stats.mtimeMs });
      });
    } catch (err) {
      if (this.debug) console.error('[watcher] discoverActiveSessions error:', err.message);
    }

    // Sort by most recent first
    discovered.sort((a, b) => b.modTime - a.modTime);
    if (this.maxSessions > 0 && discovered.length > this.maxSessions) {
      discovered.length = this.maxSessions;
    }

    for (const d of discovered) {
      const session = await this.buildSession(d.filePath);
      if (!this.sessions.has(session.id)) {
        this.sessions.set(session.id, session);

        // Broadcast so connected clients learn about the new session
        this.emit('broadcast', 'newSession', { sessionID: session.id, projectPath: session.projectPath });
        for (const [agentID, agentType] of Object.entries(session.subagentTypes)) {
          this.emit('broadcast', 'newAgent', { sessionID: session.id, agentID, agentType });
        }

        const pending = this.pendingSubagents.get(session.id);
        if (pending) {
          this.pendingSubagents.delete(session.id);
          for (const sp of pending) {
            const agentID = path.basename(sp).replace(/^agent-/, '').replace(/\.jsonl$/, '');
            await this._registerSubagent(session, session.id, agentID, sp);
          }
        }
      }
    }
  }

  getSessionsSnapshot() {
    return Array.from(this.sessions.values());
  }

  // =========================================================================
  // Start / Stop
  // =========================================================================

  async start() {
    if (this._running) return;
    this._running = true;

    if (this.useFsnotify) {
      await this._startFsnotify();
    } else {
      await this._startPolling();
    }
  }

  stop() {
    this._running = false;
    if (this.watcher) {
      this.watcher.close().catch(() => {});
    }
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    if (this._discoveryTimer) clearInterval(this._discoveryTimer);
    if (this._pollTimer) clearInterval(this._pollTimer);
    // Cancel all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  // =========================================================================
  // Chokidar (fsnotify) mode
  // =========================================================================

  async _startFsnotify() {
    // Set up watches
    try {
      if (fs.existsSync(this.claudeDir)) {
        this._addDirectoryWatches(this.claudeDir);
      } else {
        this._watchAncestor(this.claudeDir);
      }
    } catch (err) {
      if (this.debug) console.error('[watcher] start watch setup error:', err.message);
    }

    const sessions = this.getSessionsSnapshot();
    await this._initializeSessionReading(sessions);
    for (const session of sessions) {
      this._registerSessionWatches(session);
    }

    // chokidar events
    this.watcher.on('add', (p) => this._handleFsCreate(p));
    this.watcher.on('change', (p) => this._handleFsWrite(p));
    this.watcher.on('unlink', (p) => {
      this.filePositions.delete(p);
      this.fileContexts.delete(p);
    });
    this.watcher.on('error', (err) => this.emit('error', err));

    // Periodic cleanup and discovery
    this._cleanupTimer = setInterval(() => {
      if (!this._running) return;
      this._cleanupFilePositions();
    }, CleanupInterval);

    this._discoveryTimer = setInterval(() => {
      if (!this._running) return;
      if (this.watchActive) this._checkForNewSessions();
    }, FsnotifyDiscoveryInterval);
  }

  _watchAncestor(target) {
    let dir = target;
    while (true) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      try {
        fs.accessSync(parent);
        this.watcher.add(parent);
        return;
      } catch {}
      dir = parent;
    }
  }

  _addDirectoryWatches(root, maxDepth = 10) {
    const addRecursive = (dir, depth) => {
      if (depth > maxDepth) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        this.watcher.add(dir);
        for (const entry of entries) {
          if (entry.isDirectory()) {
            addRecursive(path.join(dir, entry.name), depth + 1);
          }
        }
      } catch {}
    };
    addRecursive(root, 0);
  }

  _registerSessionWatches(session) {
    this._addFileWatch(session.mainFile, session.id, '');
    for (const [agentID, agentPath] of Object.entries(session.subagents)) {
      this._addFileWatch(agentPath, session.id, agentID);
    }
  }

  _addFileWatch(filePath, sessionID, agentID) {
    try {
      this.watcher.add(filePath);
      this.fileContexts.set(filePath, { sessionID, agentID });
    } catch {}
  }

  // =========================================================================
  // chokidar event handlers
  // =========================================================================

  _handleFsCreate(p) {
    let stats;
    try { stats = fs.statSync(p); } catch { return; }

    if (stats.isDirectory()) {
      this.watcher.add(p);
      this._scanNewDirectory(p);
      if (p === this.claudeDir || this.claudeDir.startsWith(p)) {
        try {
          fs.accessSync(this.claudeDir);
          this._addDirectoryWatches(this.claudeDir);
          this.discoverActiveSessions().catch(err => {
            if (this.debug) console.error('[watcher] discoverActiveSessions error:', err.message);
          });
        } catch (err) {
          if (this.debug) console.error('[watcher] _handleFsCreate directory scan error:', err.message);
        }
      }
      return;
    }

    if (p.endsWith('.jsonl')) {
      if (p.includes('/subagents/')) {
        this._handleNewSubagentFile(p);
      } else if (this.watchActive) {
        this._handleNewSessionFile(p); // fire-and-forget, session will be discovered on next poll
      }
      return;
    }

    if (p.endsWith('.txt') && p.includes('/tool-results/')) {
      this._handleNewToolResultFile(p);
    }
  }

  _scanNewDirectory(dirPath) {
    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return; }
    const base = path.basename(dirPath);
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        this.watcher.add(fullPath);
        this._scanNewDirectory(fullPath);
        continue;
      }
      if (base === 'subagents' && entry.name.endsWith('.jsonl')) {
        this._handleNewSubagentFile(fullPath);
      } else if (base === 'tool-results' && entry.name.endsWith('.txt')) {
        this._handleNewToolResultFile(fullPath);
      }
    }
  }

  _handleFsWrite(p) {
    const ctx = this.fileContexts.get(p);
    if (!ctx) return;

    // Debounce
    const existing = this.debounceTimers.get(p);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(async () => {
      this.debounceTimers.delete(p);
      const agentType = this._lookupAgentType(ctx.sessionID, ctx.agentID);
      try {
        await this._readFile(p, ctx.sessionID, ctx.agentID, agentType);
      } catch (err) {
        this.emit('error', err);
      }
    }, DebounceInterval);
    this.debounceTimers.set(p, timer);
  }

  // =========================================================================
  // New session handlers
  // =========================================================================

  async _handleNewSessionFile(p) {
    let stats;
    try { stats = await fsp.stat(p); } catch { return; }
    if (!isMainSessionFile(p, stats)) return;

    // Only accept sessions within the active window
    if (Date.now() - stats.mtimeMs > this.activeWindow) return;

    const session = await this.buildSession(p);
    if (this.sessions.has(session.id)) return;

    this.sessions.set(session.id, session);
    this._registerSessionWatches(session);
    this.emit('broadcast', 'newSession', { sessionID: session.id, projectPath: session.projectPath });

    // Broadcast pre-existing subagents to frontend
    for (const [agentID, agentType] of Object.entries(session.subagentTypes)) {
      this.emit('broadcast', 'newAgent', { sessionID: session.id, agentID, agentType });
    }

    // Process any subagent files that arrived before the session was discovered
    const pending = this.pendingSubagents.get(session.id);
    if (pending) {
      this.pendingSubagents.delete(session.id);
      for (const sp of pending) {
        const agentID = path.basename(sp).replace(/^agent-/, '').replace(/\.jsonl$/, '');
        this._registerSubagent(session, session.id, agentID, sp);
      }
    }
  }

  _handleNewSubagentFile(p) {
    const agentID = path.basename(p).replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const subagentsDir = path.dirname(p);
    const sessionDir = path.dirname(subagentsDir);
    const sessionID = path.basename(sessionDir);

    const session = this.sessions.get(sessionID);
    if (!session) {
      const pending = this.pendingSubagents.get(sessionID) || [];
      if (!pending.includes(p)) pending.push(p);
      this.pendingSubagents.set(sessionID, pending);
      return;
    }

    this._registerSubagent(session, sessionID, agentID, p); // fire-and-forget, event handler context
  }

  async _registerSubagent(session, sessionID, agentID, p) {
    const agentType = await readAgentType(p);
    if (session.subagents[agentID]) return;

    session.subagents[agentID] = p;
    if (agentType) session.subagentTypes[agentID] = agentType;

    this._addFileWatch(p, sessionID, agentID);
    this.emit('broadcast', 'newAgent', { sessionID, agentID, agentType });
  }

  async _handleNewToolResultFile(p) {
    const toolID = path.basename(p).replace(/\.txt$/, '');
    const toolResultsDir = path.dirname(p);
    const sessionDir = path.dirname(toolResultsDir);
    const sessionID = path.basename(sessionDir);

    const session = this.sessions.get(sessionID);
    if (!session) return;
    if (session.backgroundTasks[toolID]) return;

    const parentAgentID = await this._findBackgroundTaskParent(session, toolID);
    const isComplete = await this._isBackgroundTaskComplete(session, toolID);

    const task = new BackgroundTask(toolID, parentAgentID, 'Background Task', p, isComplete);
    session.backgroundTasks[toolID] = task;

    this.emit('broadcast', 'newBackgroundTask', {
      sessionID,
      parentAgentID,
      toolID,
      toolName: 'Background Task',
      outputPath: p,
      isComplete,
    });
  }

  _lookupAgentType(sessionID, agentID) {
    if (!agentID) return '';
    const session = this.sessions.get(sessionID);
    if (!session) return '';
    return session.subagentTypes[agentID] || '';
  }

  // =========================================================================
  // Periodic checking (polling fallback + fsnotify discovery)
  // =========================================================================

  async _checkForNewSessions() {
    const now = Date.now();
    const fileCandidates = [];

    try {
      await this._walkDir(this.claudeDir, (filePath, stats) => {
        if (!isMainSessionFile(filePath, stats)) return;
        if (now - stats.mtimeMs > this.activeWindow) return;

        const id = path.basename(filePath).replace(/\.jsonl$/, '');
        if (this.sessions.has(id)) return;

        fileCandidates.push({ filePath, modTime: stats.mtimeMs });
      });
    } catch (err) {
      if (this.debug) console.error('[watcher] _checkForNewSessions error:', err.message);
    }

    const candidates = [];
    for (const fc of fileCandidates) {
      const session = await this.buildSession(fc.filePath);
      candidates.push({ session, modTime: fc.modTime });
    }

    candidates.sort((a, b) => b.modTime - a.modTime);

    for (const c of candidates) {
      if (this.maxSessions > 0 && this.sessions.size >= this.maxSessions) break;
      if (this.sessions.has(c.session.id)) continue;

      this.sessions.set(c.session.id, c.session);

      if (this.useFsnotify) {
        this._registerSessionWatches(c.session);
      }

      this.emit('broadcast', 'newSession', { sessionID: c.session.id, projectPath: c.session.projectPath });

      for (const [agentID, agentType] of Object.entries(c.session.subagentTypes)) {
        this.emit('broadcast', 'newAgent', { sessionID: c.session.id, agentID, agentType });
      }

      const pending = this.pendingSubagents.get(c.session.id);
      if (pending) {
        this.pendingSubagents.delete(c.session.id);
        for (const sp of pending) {
          const agentID = path.basename(sp).replace(/^agent-/, '').replace(/\.jsonl$/, '');
          await this._registerSubagent(c.session, c.session.id, agentID, sp);
        }
      }
    }
  }

  async _checkForNewSubagents(session) {
    const subagentDir = path.join(path.dirname(session.mainFile), session.id, 'subagents');
    let entries;
    try { entries = await fsp.readdir(subagentDir); } catch { return; }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const agentID = entry.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      if (session.subagents[agentID]) continue;

      const agentPath = path.join(subagentDir, entry);
      const agentType = await readAgentType(agentPath);
      session.subagents[agentID] = agentPath;
      if (agentType) session.subagentTypes[agentID] = agentType;

      this.emit('broadcast', 'newAgent', { sessionID: session.id, agentID, agentType });
    }
  }

  async _checkForBackgroundTasks(session) {
    const toolResultsDir = path.join(path.dirname(session.mainFile), session.id, 'tool-results');
    let entries;
    try { entries = await fsp.readdir(toolResultsDir); } catch { return; }

    for (const entry of entries) {
      if (!entry.endsWith('.txt')) continue;
      const toolID = entry.replace(/\.txt$/, '');
      if (session.backgroundTasks[toolID]) continue;

      const outputPath = path.join(toolResultsDir, entry);
      const parentAgentID = await this._findBackgroundTaskParent(session, toolID);
      const isComplete = await this._isBackgroundTaskComplete(session, toolID);

      const task = new BackgroundTask(toolID, parentAgentID, 'Background Task', outputPath, isComplete);
      session.backgroundTasks[toolID] = task;

      this.emit('broadcast', 'newBackgroundTask', {
        sessionID: session.id,
        parentAgentID,
        toolID,
        toolName: 'Background Task',
        outputPath,
        isComplete,
      });
    }
  }

  async _findBackgroundTaskParent(session, toolID) {
    const entry = session.toolIndex.get(toolID);
    if (entry) return entry.parentAgentID || '';
    if (!session.toolIndexPopulated) {
      await this._populateToolIndex(session);
    }
    const cached = session.toolIndex.get(toolID);
    return cached ? (cached.parentAgentID || '') : '';
  }

  async _isBackgroundTaskComplete(session, toolID) {
    const entry = session.toolIndex.get(toolID);
    if (entry) return entry.hasResult;
    if (!session.toolIndexPopulated) {
      await this._populateToolIndex(session);
    }
    const cached = session.toolIndex.get(toolID);
    return cached ? cached.hasResult : false;
  }

  async _populateToolIndex(session) {
    if (session.toolIndexPopulated) return;
    session.toolIndexPopulated = true;
    const files = [
      { path: session.mainFile, agentID: '' },
      ...Object.entries(session.subagents).map(([id, p]) => ({ path: p, agentID: id })),
    ];

    for (const { path: filePath, agentID } of files) {
      if (!filePath) continue;
      try {
        const input = fs.createReadStream(filePath, { encoding: 'utf-8' });
        const rl = readline.createInterface({ input, crlfDelay: Infinity });

        for await (const line of rl) {
          if (!line.includes('"tool_')) continue;

          if (line.includes('"tool_use"')) {
            const idMatch = line.match(/"id"\s*:\s*"([^"]+)"/);
            if (!idMatch) continue;
            const tid = idMatch[1];
            if (session.toolIndex.has(tid)) continue;
            const nameMatch = line.match(/"name"\s*:\s*"([^"]+)"/);
            session.toolIndex.set(tid, {
              toolName: nameMatch ? nameMatch[1] : '',
              parentAgentID: agentID,
              hasResult: false,
            });
          }

          if (line.includes('"tool_result"')) {
            const useIdMatch = line.match(/"tool_use_id"\s*:\s*"([^"]+)"/);
            if (!useIdMatch) continue;
            const tid = useIdMatch[1];
            const existing = session.toolIndex.get(tid);
            if (existing) {
              existing.hasResult = true;
            } else {
              session.toolIndex.set(tid, {
                toolName: '',
                parentAgentID: '',
                hasResult: true,
              });
            }
          }
        }
      } catch (err) {
        if (this.debug) console.error('[watcher] _populateToolIndex error reading', filePath + ':', err.message);
      }
    }
  }

  // =========================================================================
  // Polling mode
  // =========================================================================

  async _startPolling() {
    const sessions = this.getSessionsSnapshot();
    await this._initializeSessionReading(sessions);

    this._pollTimer = setInterval(() => {
      if (!this._running || this._pollRunning) return;
      this._pollRunning = true;
      this._handlePollTick()
        .then(() => { this._pollRunning = false; })
        .catch(() => { this._pollRunning = false; });
    }, this.pollInterval);

    this._cleanupTimer = setInterval(() => {
      if (!this._running) return;
      this._cleanupFilePositions();
    }, CleanupInterval);
  }

  async _handlePollTick() {
    if (this.watchActive) {
      await this._checkForNewSessions();
    }
    const sessions = this.getSessionsSnapshot();
    await Promise.all(sessions.map(s => this._processSessionTick(s)));
  }

  async _processSessionTick(session) {
    await Promise.all([
      this._checkForNewSubagents(session),
      this._checkForBackgroundTasks(session),
    ]);
    await this._readSessionFiles(session);
  }

  // =========================================================================
  // File reading
  // =========================================================================

  async _initializeSessionReading(sessions) {
    let shouldSkip = this.skipHistory;
    if (!shouldSkip) {
      let totalLines = 0;
      for (const session of sessions) {
        totalLines += await this._countFileLines(session.mainFile);
        for (const agentPath of Object.values(session.subagents)) {
          totalLines += await this._countFileLines(agentPath);
        }
      }
      shouldSkip = totalLines > AutoSkipLineThreshold;
    }

    if (shouldSkip) {
      for (const session of sessions) {
        await this._skipToEndOfFiles(session);
        await this._readSessionFiles(session);
      }
    } else {
      for (const session of sessions) {
        await this._readSessionFiles(session);
      }
    }
  }

  async _skipToEndOfFiles(session) {
    const mainPos = await this._findPositionForLastNLines(session.mainFile, KeepRecentLines);
    this.filePositions.set(session.mainFile, mainPos);

    for (const agentPath of Object.values(session.subagents)) {
      const pos = await this._findPositionForLastNLines(agentPath, KeepRecentLines);
      this.filePositions.set(agentPath, pos);
    }
  }

  async _findPositionForLastNLines(filePath, n) {
    try {
      const stat = await fsp.stat(filePath);
      const fileSize = stat.size;
      if (fileSize === 0) return 0;

      const handle = await fsp.open(filePath, 'r');
      try {
        const chunkSize = 8192;
        const buf = Buffer.alloc(chunkSize);
        let newlineCount = 0;
        let position = fileSize;
        let lastNewlinePos = fileSize;

        while (position > 0 && newlineCount <= n) {
          const readLen = Math.min(chunkSize, position);
          position -= readLen;
          const { bytesRead } = await handle.read(buf, 0, readLen, position);

          for (let i = bytesRead - 1; i >= 0; i--) {
            if (buf[i] === 0x0A) {
              newlineCount++;
              if (newlineCount === n) {
                lastNewlinePos = position + i + 1;
                break;
              }
            }
          }
        }

        if (newlineCount < n) return 0;
        return lastNewlinePos;
      } finally {
        await handle.close();
      }
    } catch {
      return 0;
    }
  }

  async _readSessionFiles(session) {
    const reads = [this._readFile(session.mainFile, session.id, '', '')];
    for (const [agentID, agentPath] of Object.entries(session.subagents)) {
      const agentType = session.subagentTypes[agentID] || '';
      reads.push(this._readFile(agentPath, session.id, agentID, agentType));
    }
    await Promise.all(reads);
  }

  async _readFile(filePath, sessionID, agentID, agentType) {
    // Serialize reads per file to prevent concurrent access
    const prev = this._readLocks.get(filePath) || Promise.resolve();
    let resolveLock;
    const lock = new Promise(r => { resolveLock = r; });
    this._readLocks.set(filePath, lock);

    try {
      await prev;

      let handle;
      let newPos = this.filePositions.get(filePath) || 0;
      try {
        handle = await fsp.open(filePath, 'r');
        const pos = this.filePositions.get(filePath) || 0;
        const stats = await handle.stat();
        if (pos >= stats.size) { await handle.close(); handle = null; return; }

        const readLen = stats.size - pos;
        const buf = Buffer.alloc(readLen);
        const { bytesRead } = await handle.read(buf, 0, readLen, pos);
        if (bytesRead === 0) { await handle.close(); handle = null; return; }

        newPos = pos;
        const content = bytesRead < readLen ? buf.toString('utf-8', 0, bytesRead) : buf.toString('utf-8');
        const rawLines = content.split('\n');

        // Detect Windows-style CRLF line endings
        const firstNl = content.indexOf('\n');
        const crlf = firstNl > 0 && content[firstNl - 1] === '\r';
        const nlLen = crlf ? 2 : 1;

        let currentSize;
        try { currentSize = (await handle.stat()).size; } catch { currentSize = stats.size; }
        const fileGrew = currentSize > pos + bytesRead;

        await handle.close();
        handle = null;

        for (let i = 0; i < rawLines.length; i++) {
          const isLast = i === rawLines.length - 1;
          let rawLine = rawLines[i];

          // Trailing empty line after a final newline — skip it, advance position
          if (isLast && rawLine === '' && content.endsWith('\n')) {
            newPos += nlLen;
            continue;
          }

          // Last line may be incomplete if file grew mid-read or lacks a trailing newline
          if (isLast && !content.endsWith('\n')) {
            // Don't process this line, don't advance position past it.
            // Next read will re-read from the current newPos and get the complete line.
            continue;
          }

          // Strip trailing \r for clean line processing (Windows CRLF)
          if (crlf && rawLine.endsWith('\r')) {
            rawLine = rawLine.slice(0, -1);
          }

          newPos += Buffer.byteLength(rawLine, 'utf-8');
          newPos += nlLen;

          if (!rawLine.trim()) continue;

          const items = parseLine(rawLine);
          for (const item of items) {
            item.sessionID = sessionID;

            if (agentID) {
              if (!item.agentID) item.agentID = agentID;
              if (agentType) {
                const idx = agentType.lastIndexOf(':');
                if (idx >= 0 && idx < agentType.length - 1) {
                  item.agentName = agentType.slice(idx + 1);
                } else {
                  item.agentName = agentType;
                }
              } else if (!item.agentName || item.agentName.startsWith('Agent-')) {
                item.agentName = `Agent-${agentID.slice(0, Math.min(AgentIDDisplayLength, agentID.length))}`;
              }
            }

            if (item.toolID) {
              const session = this.sessions.get(sessionID);
              if (session) {
                const existing = session.toolIndex.get(item.toolID);
                if (item.type === 'tool_output') {
                  if (existing) {
                    existing.hasResult = true;
                  } else {
                    session.toolIndex.set(item.toolID, { toolName: '', parentAgentID: agentID || '', hasResult: true });
                  }
                } else if (item.type === 'tool_input' && !existing) {
                  session.toolIndex.set(item.toolID, { toolName: item.toolName || '', parentAgentID: agentID || '', hasResult: false });
                }
              }
            }

            this.emit('item', item);
          }
        }

        this.filePositions.set(filePath, Math.min(newPos, stats.size));
      } catch (err) {
        if (newPos !== undefined) {
          this.filePositions.set(filePath, newPos);
        }
        this.emit('error', err);
      } finally {
        if (handle) {
          try { await handle.close(); } catch {}
        }
      }
    } finally {
      resolveLock();
      if (this._readLocks.get(filePath) === lock) {
        this._readLocks.delete(filePath);
      }
    }
  }

  async _countFileLines(filePath) {
    try {
      const stat = await fsp.stat(filePath);
      if (stat.size === 0) return 0;
      const handle = await fsp.open(filePath, 'r');
      const buf = Buffer.alloc(8192);
      let count = 0;
      let pos = 0;
      try {
        while (pos < stat.size) {
          const readLen = Math.min(8192, stat.size - pos);
          const { bytesRead } = await handle.read(buf, 0, readLen, pos);
          for (let i = 0; i < bytesRead; i++) {
            if (buf[i] === 0x0A) count++;
          }
          pos += bytesRead;
        }
      } finally {
        await handle.close();
      }
      return count;
    } catch {
      return 0;
    }
  }

  _cleanupFilePositions() {
    for (const p of this.filePositions.keys()) {
      try { fs.accessSync(p); } catch {
        this.filePositions.delete(p);
        this.fileContexts.delete(p);
      }
    }

    // Remove stale sessions whose main file is no longer active
    const now = Date.now();
    for (const [sessionID, session] of this.sessions) {
      let stats;
      try { stats = fs.statSync(session.mainFile); } catch {
        this.removeSession(sessionID);
        this.emit('broadcast', 'sessionRemoved', { sessionID });
        continue;
      }
      if (now - stats.mtimeMs > this.activeWindow) {
        this.removeSession(sessionID);
        this.emit('broadcast', 'sessionRemoved', { sessionID });
      }
    }
  }

  // =========================================================================
  // Public API
  // =========================================================================

  setSkipHistory(skip) {
    this.skipHistory = skip;
  }

  removeSession(sessionID) {
    const session = this.sessions.get(sessionID);
    if (session) {
      const paths = [session.mainFile, ...Object.values(session.subagents)];
      for (const p of paths) {
        if (p) {
          this.fileContexts.delete(p);
          this.filePositions.delete(p);
          const timer = this.debounceTimers.get(p);
          if (timer) {
            clearTimeout(timer);
            this.debounceTimers.delete(p);
          }
        }
      }
    }
    this.sessions.delete(sessionID);
    if (session) {
      this.emit('sessionRemoved', { sessionID });
    }
  }

  toggleAutoDiscovery() {
    this.watchActive = !this.watchActive;
  }

  isAutoDiscoveryEnabled() {
    return this.watchActive;
  }

  // =========================================================================
  // Directory walking
  // =========================================================================

  _walkDir = createWalkDir(fsp.readdir);
}

// ============================================================================
// Directory walking (shared factory for sync and async)
// ============================================================================

function createWalkDir(readdirFn) {
  const walk = async (dir, callback) => {
    try {
      const entries = await readdirFn(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath, callback);
        } else {
          let stats;
          try { stats = await fsp.stat(fullPath); } catch { continue; }
          callback(fullPath, stats);
        }
      }
    } catch {}
  };
  return walk;
}

var _walkDirAsync = createWalkDir(fsp.readdir);

// ============================================================================
// Static listing methods
// ============================================================================

async function listSessions(limit = 10) {
  return _listSessionsFiltered(limit, 0);
}

async function listActiveSessions(withinMs) {
  return _listSessionsFiltered(0, withinMs);
}

async function _listSessionsFiltered(limit, activeWithin) {
  const claudeDir = getClaudeProjectsDir();
  const sessions = [];
  const now = Date.now();

  try {
    await _walkDirStatic(claudeDir, (filePath, stats) => {
      if (!isMainSessionFile(filePath, stats)) return;
      if (activeWithin > 0 && (now - stats.mtimeMs) > activeWithin) return;

      const basename = path.basename(filePath);
      const projectDir = path.basename(path.dirname(filePath));
      const projectPath = resolveProjectPath(projectDir);

      sessions.push({
        id: basename.replace(/\.jsonl$/, ''),
        path: filePath,
        projectPath,
        modified: stats.mtime,
        isActive: (now - stats.mtimeMs) < RecentActivityThreshold,
      });
    });
  } catch {}

  sessions.sort((a, b) => b.modified - a.modified);
  if (limit > 0 && sessions.length > limit) sessions.length = limit;

  return sessions;
}

async function _walkDirStatic(dir, callback) {
  return _walkDirAsync(dir, callback);
}

module.exports = {
  Watcher,
  Session,
  BackgroundTask,
  listSessions,
  listActiveSessions,
};
