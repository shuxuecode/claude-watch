'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const chokidar = require('chokidar');
const { parseLine, AgentIDDisplayLength } = require('../parser/parser');

// ============================================================================
// Constants
// ============================================================================

const AutoSkipLineThreshold = 100;
const KeepRecentLines = 10;
const CleanupInterval = 5 * 60 * 1000;
const FsnotifyDiscoveryInterval = 60 * 1000;
const RecentActivityThreshold = 2 * 60 * 1000;
const DebounceInterval = 50;

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
    } catch {}
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

function readAgentType(jsonlPath) {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
  try {
    const data = fs.readFileSync(metaPath, 'utf-8');
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

class Watcher extends require('events').EventEmitter {
  constructor({ sessionID, pollInterval, activeWindow, maxSessions } = {}) {
    super();
    this.claudeDir = getClaudeProjectsDir();
    this.pollInterval = pollInterval || 500;
    this.activeWindow = activeWindow || 5 * 60 * 1000;
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

    // Intervals / timers
    this._cleanupTimer = null;
    this._discoveryTimer = null;
    this._pollTimer = null;
    this._running = false;

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

  buildSession(mainFile) {
    const base = path.basename(mainFile);
    const id = base.replace(/\.jsonl$/, '');
    const projectDir = path.basename(path.dirname(mainFile));
    const projectPath = resolveProjectPath(projectDir);

    const session = new Session(id, projectPath, mainFile);

    // Find subagent files
    const subagentDir = path.join(path.dirname(mainFile), id, 'subagents');
    try {
      const entries = fs.readdirSync(subagentDir);
      for (const entry of entries) {
        if (entry.endsWith('.jsonl')) {
          const agentID = entry.replace(/^agent-/, '').replace(/\.jsonl$/, '');
          const jsonlPath = path.join(subagentDir, entry);
          session.subagents[agentID] = jsonlPath;
          const agentType = readAgentType(jsonlPath);
          if (agentType) {
            session.subagentTypes[agentID] = agentType;
          }
        }
      }
    } catch {}

    return session;
  }

  async discoverActiveSessions() {
    const now = Date.now();
    const discovered = [];

    try {
      await this._walkDir(this.claudeDir, (filePath, stats) => {
        if (!isMainSessionFile(filePath, stats)) return;
        if (now - stats.mtimeMs > this.activeWindow) return;

        const session = this.buildSession(filePath);
        discovered.push({ session, modTime: stats.mtimeMs });
      });
    } catch {}

    // Sort by most recent first
    discovered.sort((a, b) => b.modTime - a.modTime);
    if (this.maxSessions > 0 && discovered.length > this.maxSessions) {
      discovered.length = this.maxSessions;
    }

    for (const d of discovered) {
      if (!this.sessions.has(d.session.id)) {
        this.sessions.set(d.session.id, d.session);

        // Broadcast so connected clients learn about the new session
        this.emit('broadcast', 'newSession', { sessionID: d.session.id, projectPath: d.session.projectPath });
        for (const [agentID, agentType] of Object.entries(d.session.subagentTypes)) {
          this.emit('broadcast', 'newAgent', { sessionID: d.session.id, agentID, agentType });
        }

        const pending = this.pendingSubagents.get(d.session.id);
        if (pending) {
          this.pendingSubagents.delete(d.session.id);
          for (const sp of pending) {
            const agentID = path.basename(sp).replace(/^agent-/, '').replace(/\.jsonl$/, '');
            this._registerSubagent(d.session, d.session.id, agentID, sp);
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

  start() {
    if (this._running) return;
    this._running = true;

    if (this.useFsnotify) {
      this._startFsnotify();
    } else {
      this._startPolling();
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

  _startFsnotify() {
    // Set up watches
    try {
      if (fs.existsSync(this.claudeDir)) {
        this._addDirectoryWatches(this.claudeDir);
      } else {
        this._watchAncestor(this.claudeDir);
      }
    } catch {}

    const sessions = this.getSessionsSnapshot();
    this._initializeSessionReading(sessions);
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

  _addDirectoryWatches(root, maxDepth = 20) {
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
          this.discoverActiveSessions();
        } catch {}
      }
      return;
    }

    if (p.endsWith('.jsonl')) {
      if (p.includes('/subagents/')) {
        this._handleNewSubagentFile(p);
      } else if (this.watchActive) {
        this._handleNewSessionFile(p);
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
    const timer = setTimeout(() => {
      this.debounceTimers.delete(p);
      const agentType = this._lookupAgentType(ctx.sessionID, ctx.agentID);
      this._readFile(p, ctx.sessionID, ctx.agentID, agentType);
    }, DebounceInterval);
    this.debounceTimers.set(p, timer);
  }

  // =========================================================================
  // New session handlers
  // =========================================================================

  _handleNewSessionFile(p) {
    let stats;
    try { stats = fs.statSync(p); } catch { return; }
    if (!isMainSessionFile(p, stats)) return;

    // Only accept sessions within the active window
    if (Date.now() - stats.mtimeMs > this.activeWindow) return;

    const session = this.buildSession(p);
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

    this._registerSubagent(session, sessionID, agentID, p);
  }

  _registerSubagent(session, sessionID, agentID, p) {
    const agentType = readAgentType(p);
    if (session.subagents[agentID]) return;

    session.subagents[agentID] = p;
    if (agentType) session.subagentTypes[agentID] = agentType;

    this._addFileWatch(p, sessionID, agentID);
    this.emit('broadcast', 'newAgent', { sessionID, agentID, agentType });
  }

  _handleNewToolResultFile(p) {
    const toolID = path.basename(p).replace(/\.txt$/, '');
    const toolResultsDir = path.dirname(p);
    const sessionDir = path.dirname(toolResultsDir);
    const sessionID = path.basename(sessionDir);

    const session = this.sessions.get(sessionID);
    if (!session) return;
    if (session.backgroundTasks[toolID]) return;

    const parentAgentID = this._findBackgroundTaskParent(session, toolID);
    const isComplete = this._isBackgroundTaskComplete(session, toolID);

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

  _checkForNewSessions() {
    const now = Date.now();
    const candidates = [];

    try {
      _walkDirSyncSimple(this.claudeDir, (filePath, stats) => {
        if (!isMainSessionFile(filePath, stats)) return;
        if (now - stats.mtimeMs > this.activeWindow) return;

        const id = path.basename(filePath).replace(/\.jsonl$/, '');
        if (this.sessions.has(id)) return;

        const session = this.buildSession(filePath);
        candidates.push({ session, modTime: stats.mtimeMs });
      });
    } catch {}

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
          this._registerSubagent(c.session, c.session.id, agentID, sp);
        }
      }
    }
  }

  _checkForNewSubagents(session) {
    const subagentDir = path.join(path.dirname(session.mainFile), session.id, 'subagents');
    let entries;
    try { entries = fs.readdirSync(subagentDir); } catch { return; }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const agentID = entry.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      if (session.subagents[agentID]) continue;

      const agentPath = path.join(subagentDir, entry);
      const agentType = readAgentType(agentPath);
      session.subagents[agentID] = agentPath;
      if (agentType) session.subagentTypes[agentID] = agentType;

      this.emit('newAgent', { sessionID: session.id, agentID, agentType });
    }
  }

  _checkForBackgroundTasks(session) {
    const toolResultsDir = path.join(path.dirname(session.mainFile), session.id, 'tool-results');
    let entries;
    try { entries = fs.readdirSync(toolResultsDir); } catch { return; }

    for (const entry of entries) {
      if (!entry.endsWith('.txt')) continue;
      const toolID = entry.replace(/\.txt$/, '');
      if (session.backgroundTasks[toolID]) continue;

      const outputPath = path.join(toolResultsDir, entry);
      const parentAgentID = this._findBackgroundTaskParent(session, toolID);
      const isComplete = this._isBackgroundTaskComplete(session, toolID);

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

  _findBackgroundTaskParent(session, toolID) {
    const entry = session.toolIndex.get(toolID);
    if (entry) return entry.parentAgentID || '';
    if (!session.toolIndexPopulated) {
      this._populateToolIndex(session);
    }
    const cached = session.toolIndex.get(toolID);
    return cached ? (cached.parentAgentID || '') : '';
  }

  _isBackgroundTaskComplete(session, toolID) {
    const entry = session.toolIndex.get(toolID);
    if (entry) return entry.hasResult;
    if (!session.toolIndexPopulated) {
      this._populateToolIndex(session);
    }
    const cached = session.toolIndex.get(toolID);
    return cached ? cached.hasResult : false;
  }

  _populateToolIndex(session) {
    if (session.toolIndexPopulated) return;
    session.toolIndexPopulated = true;
    const files = [
      { path: session.mainFile, agentID: '' },
      ...Object.entries(session.subagents).map(([id, p]) => ({ path: p, agentID: id })),
    ];

    for (const { path: filePath, agentID } of files) {
      if (!filePath) continue;
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        for (const line of content.split('\n')) {
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
      } catch {}
    }
  }

  // =========================================================================
  // Polling mode
  // =========================================================================

  _startPolling() {
    const sessions = this.getSessionsSnapshot();
    this._initializeSessionReading(sessions);

    this._pollTimer = setInterval(() => {
      if (!this._running) return;
      this._handlePollTick();
    }, this.pollInterval);

    this._cleanupTimer = setInterval(() => {
      if (!this._running) return;
      this._cleanupFilePositions();
    }, CleanupInterval);
  }

  _handlePollTick() {
    if (this.watchActive) {
      this._checkForNewSessions();
    }
    for (const session of this.getSessionsSnapshot()) {
      this._checkForNewSubagents(session);
      this._checkForBackgroundTasks(session);
      this._readSessionFiles(session);
    }
  }

  // =========================================================================
  // File reading
  // =========================================================================

  _initializeSessionReading(sessions) {
    let shouldSkip = this.skipHistory;
    if (!shouldSkip) {
      let totalLines = 0;
      for (const session of sessions) {
        totalLines += this._countFileLines(session.mainFile);
        for (const agentPath of Object.values(session.subagents)) {
          totalLines += this._countFileLines(agentPath);
        }
      }
      shouldSkip = totalLines > AutoSkipLineThreshold;
    }

    if (shouldSkip) {
      for (const session of sessions) {
        this._skipToEndOfFiles(session);
        this._readSessionFiles(session);
      }
    } else {
      for (const session of sessions) {
        this._readSessionFiles(session);
      }
    }
  }

  _skipToEndOfFiles(session) {
    const mainPos = this._findPositionForLastNLines(session.mainFile, KeepRecentLines);
    this.filePositions.set(session.mainFile, mainPos);

    for (const agentPath of Object.values(session.subagents)) {
      const pos = this._findPositionForLastNLines(agentPath, KeepRecentLines);
      this.filePositions.set(agentPath, pos);
    }
  }

  _findPositionForLastNLines(filePath, n) {
    try {
      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      if (fileSize === 0) return 0;

      let fd;
      try {
        fd = fs.openSync(filePath, 'r');
        const chunkSize = 8192;
        const buf = Buffer.alloc(chunkSize);
        let newlineCount = 0;
        let position = fileSize;
        let lastNewlinePos = fileSize;

        while (position > 0 && newlineCount <= n) {
          const readLen = Math.min(chunkSize, position);
          position -= readLen;
          fs.readSync(fd, buf, 0, readLen, position);

          for (let i = readLen - 1; i >= 0; i--) {
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
        if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      }
    } catch {
      return 0;
    }
  }

  _readSessionFiles(session) {
    this._readFile(session.mainFile, session.id, '', '');
    for (const [agentID, agentPath] of Object.entries(session.subagents)) {
      const agentType = session.subagentTypes[agentID] || '';
      this._readFile(agentPath, session.id, agentID, agentType);
    }
  }

  _readFile(filePath, sessionID, agentID, agentType) {
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const pos = this.filePositions.get(filePath) || 0;
      const stats = fs.fstatSync(fd);
      if (pos >= stats.size) return;

      const readLen = stats.size - pos;
      const buf = Buffer.alloc(readLen);
      const bytesRead = fs.readSync(fd, buf, 0, readLen, pos);
      if (bytesRead === 0) return;

      let newPos = pos;
      const content = bytesRead < readLen ? buf.toString('utf-8', 0, bytesRead) : buf.toString('utf-8');
      const lines = content.split('\n');

      // Check whether the file has grown since we read it.
      // If yes, the last line may be incomplete (no trailing newline yet).
      let currentSize;
      try { currentSize = fs.fstatSync(fd).size; } catch { currentSize = stats.size; }
      const fileGrew = currentSize > pos + bytesRead;

      for (let i = 0; i < lines.length; i++) {
        const isLast = i === lines.length - 1;
        const rawLine = lines[i];

        // Trailing empty string after final newline — already processed
        if (isLast && rawLine === '' && content.endsWith('\n')) {
          continue;
        }

        // File has grown: last line may be missing its newline, defer it
        if (isLast && fileGrew) {
          continue;
        }

        // Advance file position (only for lines we actually consume)
        newPos += Buffer.byteLength(rawLine, 'utf-8');
        if (!isLast) newPos += 1;

        if (!rawLine.trim()) continue;

        const items = parseLine(rawLine);
        for (const item of items) {
          // Set session ID
          item.sessionID = sessionID;

          // Set agent ID and name from context
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

          // Populate tool index for O(1) lookups
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
    } catch {} finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
    }
  }

  _countFileLines(filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size === 0) return 0;
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(8192);
      let count = 0;
      let pos = 0;
      while (pos < stat.size) {
        const readLen = Math.min(8192, stat.size - pos);
        const bytesRead = fs.readSync(fd, buf, 0, readLen, pos);
        for (let i = 0; i < bytesRead; i++) {
          if (buf[i] === 0x0A) count++;
        }
        pos += bytesRead;
      }
      fs.closeSync(fd);
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

  _createWalkDir(readdirFn) {
    const walk = async (dir, callback) => {
      try {
        const entries = await readdirFn(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(fullPath, callback);
          } else {
            let stats;
            try { stats = fs.statSync(fullPath); } catch { continue; }
            callback(fullPath, stats);
          }
        }
      } catch {}
    };
    return walk;
  }

  _walkDir = this._createWalkDir(fsp.readdir);
}

// ============================================================================
// Pure synchronous directory walk (no async/Promise overhead)
// ============================================================================

function _walkDirSyncSimple(dir, callback) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        _walkDirSyncSimple(fullPath, callback);
      } else {
        let stats;
        try { stats = fs.statSync(fullPath); } catch { continue; }
        callback(fullPath, stats);
      }
    }
  } catch {}
}

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
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await _walkDirStatic(fullPath, callback);
      } else {
        let stats;
        try { stats = fs.statSync(fullPath); } catch { continue; }
        callback(fullPath, stats);
      }
    }
  } catch {}
}

module.exports = {
  Watcher,
  Session,
  BackgroundTask,
  listSessions,
  listActiveSessions,
};
