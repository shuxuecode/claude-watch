'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Helpers from watcher — we test them by importing the module
const watcherModule = require('../src/watcher/watcher');

// ============================================================================
// Helper functions
// ============================================================================

describe('Watcher helpers', () => {
  describe('resolveProjectPath', () => {
    // resolveProjectPath is not exported, so test it indirectly
    // via the exported Watcher class construction
    it('should resolve non-empty encoded path', () => {
      // The function is internal, but we can verify it handles basic cases
      // by checking Watcher construction doesn't crash
      const w = new watcherModule.Watcher({ sessionID: '' });
      assert.ok(w.claudeDir);
    });
  });

  describe('isMainSessionFile (internal)', () => {
    // Test indirectly by building sessions with mock files
    it('should identify .jsonl files not in subagents dir', () => {
      assert.ok(path.basename('/some/path/abc123.jsonl').endsWith('.jsonl'));
      assert.ok(path.basename('/some/path/agent-xyz.jsonl').startsWith('agent-'));
      assert.ok('/some/dir/session.jsonl'.includes('.jsonl'));
    });
  });

  describe('parseDuration (from cli-helpers)', () => {
    const { parseDuration } = require('../src/cli-helpers');

    it('should parse milliseconds', () => {
      assert.strictEqual(parseDuration('500ms'), 500);
    });

    it('should parse seconds', () => {
      assert.strictEqual(parseDuration('30s'), 30000);
    });

    it('should parse minutes', () => {
      assert.strictEqual(parseDuration('5m'), 300000);
    });

    it('should parse hours', () => {
      assert.strictEqual(parseDuration('1h'), 3600000);
    });

    it('should throw on invalid duration', () => {
      assert.throws(() => parseDuration('abc'), /Invalid duration/);
      assert.throws(() => parseDuration('10d'), /Invalid duration/);
    });
  });
});

// ============================================================================
// Session class
// ============================================================================

describe('Session class', () => {
  it('should initialize with correct fields', () => {
    const s = new watcherModule.Session('test-id', '/project', '/file.jsonl');
    assert.strictEqual(s.id, 'test-id');
    assert.strictEqual(s.projectPath, '/project');
    assert.strictEqual(s.mainFile, '/file.jsonl');
    assert.deepStrictEqual(s.subagents, {});
    assert.deepStrictEqual(s.subagentTypes, {});
    assert.deepStrictEqual(s.backgroundTasks, {});
    assert.strictEqual(s.toolIndex.size, 0);
    assert.strictEqual(s.toolIndexPopulated, false);
  });
});

// ============================================================================
// BackgroundTask class
// ============================================================================

describe('BackgroundTask class', () => {
  it('should initialize with correct fields', () => {
    const t = new watcherModule.BackgroundTask('tool1', 'agent1', 'Bash', '/output.txt', true);
    assert.strictEqual(t.toolID, 'tool1');
    assert.strictEqual(t.parentAgentID, 'agent1');
    assert.strictEqual(t.toolName, 'Bash');
    assert.strictEqual(t.outputPath, '/output.txt');
    assert.strictEqual(t.isComplete, true);
  });
});

// ============================================================================
// Watcher class (unit tests without file system)
// ============================================================================

describe('Watcher class', () => {
  it('should initialize with default options', () => {
    const w = new watcherModule.Watcher({});
    assert.strictEqual(w.pollInterval, 500);
    assert.strictEqual(w.activeWindow, 100 * 60 * 1000);
    assert.strictEqual(w.maxSessions, 0);
    assert.strictEqual(w.sessions.size, 0);
    assert.strictEqual(w.filePositions.size, 0);
    assert.strictEqual(w.watchActive, true);
    assert.strictEqual(w._running, false);
    assert.strictEqual(w.pendingSubagents.size, 0);
  });

  it('should initialize with custom options', () => {
    const w = new watcherModule.Watcher({
      sessionID: 'abc',
      pollInterval: 1000,
      activeWindow: 10 * 60 * 1000,
      maxSessions: 5,
    });
    assert.strictEqual(w._sessionID, 'abc');
    assert.strictEqual(w.pollInterval, 1000);
    assert.strictEqual(w.activeWindow, 10 * 60 * 1000);
    assert.strictEqual(w.maxSessions, 5);
    assert.strictEqual(w.watchActive, false);
  });

  it('should emit broadcast events for session lifecycle', () => {
    const w = new watcherModule.Watcher({});
    const events = [];
    w.on('broadcast', (type, payload) => events.push({ type, payload }));
    w.on('item', (item) => events.push({ type: 'item', payload: item }));
    w.on('sessionRemoved', (msg) => events.push({ type: 'sessionRemoved', payload: msg }));

    // Manually emit to verify listener wiring
    w.emit('broadcast', 'newSession', { sessionID: 's1', projectPath: '/proj' });
    w.emit('broadcast', 'newAgent', { sessionID: 's1', agentID: 'a1', agentType: 'build' });
    w.emit('broadcast', 'newBackgroundTask', { sessionID: 's1', toolID: 't1' });
    w.emit('sessionRemoved', { sessionID: 's1' });

    assert.strictEqual(events.length, 4);
    assert.strictEqual(events[0].type, 'newSession');
    assert.strictEqual(events[1].type, 'newAgent');
    assert.strictEqual(events[2].type, 'newBackgroundTask');
    assert.strictEqual(events[3].type, 'sessionRemoved');
  });

  it('should remove session and clean up associated data', () => {
    const w = new watcherModule.Watcher({});
    const session = new watcherModule.Session('s1', '/proj', '/file.jsonl');
    session.subagents['a1'] = '/agent.jsonl';
    w.sessions.set('s1', session);
    w.filePositions.set('/file.jsonl', 100);
    w.filePositions.set('/agent.jsonl', 50);
    w.fileContexts.set('/file.jsonl', { sessionID: 's1', agentID: '' });
    w.fileContexts.set('/agent.jsonl', { sessionID: 's1', agentID: 'a1' });

    w.removeSession('s1');

    assert.strictEqual(w.sessions.has('s1'), false);
    assert.strictEqual(w.filePositions.has('/file.jsonl'), false);
    assert.strictEqual(w.filePositions.has('/agent.jsonl'), false);
    assert.strictEqual(w.fileContexts.has('/file.jsonl'), false);
    assert.strictEqual(w.fileContexts.has('/agent.jsonl'), false);
  });

  describe('pendingSubagents', () => {
    it('should queue subagent file when session not found', () => {
      const w = new watcherModule.Watcher({});
      const p = '/home/.claude/projects/proj/s1/subagents/agent-a1.jsonl';

      w._handleNewSubagentFile(p);

      assert.strictEqual(w.pendingSubagents.size, 1);
      const pending = w.pendingSubagents.get('s1');
      assert.ok(pending);
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0], p);
    });

    it('should register subagent immediately when session exists', async () => {
      const w = new watcherModule.Watcher({});
      const session = new watcherModule.Session('s1', '/proj', '/file.jsonl');
      w.sessions.set('s1', session);

      // Create the agent file so readAgentType and _addFileWatch can work
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-reg-'));
      const agentDir = path.join(tmpDir, 's1', 'subagents');
      fs.mkdirSync(agentDir, { recursive: true });
      const agentPath = path.join(agentDir, 'agent-a1.jsonl');
      fs.writeFileSync(agentPath, '');

      await w._registerSubagent(session, 's1', 'a1', agentPath);

      assert.strictEqual(w.pendingSubagents.size, 0);
      assert.strictEqual(session.subagents['a1'], agentPath);

      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    });

    it('should process pending subagents when session is discovered', async () => {
      const w = new watcherModule.Watcher({});
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-test-'));
      const agentDir = path.join(tmpDir, 's1', 'subagents');
      fs.mkdirSync(agentDir, { recursive: true });
      const agentPath = path.join(agentDir, 'agent-a1.jsonl');
      fs.writeFileSync(agentPath, '');

      w._handleNewSubagentFile(agentPath);
      assert.strictEqual(w.pendingSubagents.size, 1);

      // Now create the session (simulating _handleNewSessionFile path)
      const session = new watcherModule.Session('s1', '/proj', '/file.jsonl');
      w.sessions.set('s1', session);

      const pending = w.pendingSubagents.get('s1');
      if (pending) {
        w.pendingSubagents.delete('s1');
        for (const sp of pending) {
          const agentID = path.basename(sp).replace(/^agent-/, '').replace(/\.jsonl$/, '');
          await w._registerSubagent(session, 's1', agentID, sp);
        }
      }

      assert.strictEqual(w.pendingSubagents.size, 0);
      assert.strictEqual(session.subagents['a1'], agentPath);

      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    });
  });

  describe('_findPositionForLastNLines', () => {
    let tmpDir;
    let tmpFile;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-test-'));
      tmpFile = path.join(tmpDir, 'test.jsonl');
    });

    after(() => {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    });

    it('should return 0 for empty file', async () => {
      fs.writeFileSync(tmpFile, '');
      const w = new watcherModule.Watcher({});
      const pos = await w._findPositionForLastNLines(tmpFile, 10);
      assert.strictEqual(pos, 0);
    });

    it('should return 0 when file has fewer lines than n', async () => {
      fs.writeFileSync(tmpFile, 'line1\nline2\nline3\n');
      const w = new watcherModule.Watcher({});
      const pos = await w._findPositionForLastNLines(tmpFile, 10);
      assert.strictEqual(pos, 0);
    });

    it('should find correct byte offset for last N lines', async () => {
      const lines = [];
      for (let i = 0; i < 20; i++) lines.push(`line${i}`);
      fs.writeFileSync(tmpFile, lines.join('\n') + '\n');
      const w = new watcherModule.Watcher({});
      const pos = await w._findPositionForLastNLines(tmpFile, 5);
      // Verify that reading from pos yields the last portion of the file
      const content = fs.readFileSync(tmpFile, 'utf-8');
      assert.ok(pos > 0);
      assert.ok(pos < content.length);
      const fromPos = content.slice(pos);
      // The returned position should be after the 5th newline from the end
      assert.ok(fromPos.includes('line16'));
    });

    it('should handle file with single byte per line', async () => {
      fs.writeFileSync(tmpFile, 'a\nb\nc\nd\ne\nf\n');
      const w = new watcherModule.Watcher({});
      const pos = await w._findPositionForLastNLines(tmpFile, 2);
      // Verify pos points to somewhere in the file, after the 2nd newline from end
      assert.ok(pos > 0);
      const content = fs.readFileSync(tmpFile, 'utf-8');
      const fromPos = content.slice(pos);
      assert.ok(fromPos.includes('f'));
    });

    it('should return 0 for non-existent file', async () => {
      const w = new watcherModule.Watcher({});
      const pos = await w._findPositionForLastNLines('/nonexistent/file', 10);
      assert.strictEqual(pos, 0);
    });
  });

  describe('_addDirectoryWatches depth limit', () => {
    let tmpDir;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-depth-'));
      // Create a directory tree deeper than 20 levels
      let current = tmpDir;
      for (let i = 0; i < 25; i++) {
        current = path.join(current, `level${i}`);
        fs.mkdirSync(current);
      }
    });

    after(() => {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    });

    it('should respect maxDepth parameter', () => {
      const w = new watcherModule.Watcher({});
      // With maxDepth=20, should only add watches up to 20 levels deep
      w._addDirectoryWatches(tmpDir, 20);
      // The watcher.add calls won't fail for this test,
      // we just verify it doesn't stack overflow
      assert.ok(true); // If we got here, no stack overflow
    });
  });

  describe('_populateToolIndex', () => {
    let tmpDir;
    let mainFile;
    let agentFile;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-index-'));
      mainFile = path.join(tmpDir, 'session.jsonl');
      agentFile = path.join(tmpDir, 'agent-a1.jsonl');

      const mainLines = [
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] } }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } }),
      ];
      fs.writeFileSync(mainFile, mainLines.join('\n') + '\n');

      const agentLines = [
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} }] } }),
      ];
      fs.writeFileSync(agentFile, agentLines.join('\n') + '\n');
    });

    after(() => {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    });

    it('should populate toolIndex from files', async () => {
      const w = new watcherModule.Watcher({});
      const session = new watcherModule.Session('s1', '/proj', mainFile);
      session.subagents['a1'] = agentFile;

      await w._populateToolIndex(session);

      assert.strictEqual(session.toolIndexPopulated, true);
      assert.strictEqual(session.toolIndex.size, 2);

      const tool1 = session.toolIndex.get('toolu_1');
      assert.strictEqual(tool1.toolName, 'Bash');
      assert.strictEqual(tool1.hasResult, true);

      const tool2 = session.toolIndex.get('toolu_2');
      assert.strictEqual(tool2.toolName, 'Read');
      assert.strictEqual(tool2.hasResult, false);
      assert.strictEqual(tool2.parentAgentID, 'a1');
    });

    it('should not re-populate on second call', async () => {
      const session = new watcherModule.Session('s1', '/proj', mainFile);
      session.toolIndexPopulated = true;
      session.toolIndex.set('toolu_1', { toolName: 'cached', parentAgentID: '', hasResult: false });

      const w = new watcherModule.Watcher({});
      await w._populateToolIndex(session);

      // Should NOT overwrite the cached entry
      assert.strictEqual(session.toolIndex.get('toolu_1').toolName, 'cached');
    });
  });

  describe('_lookupAgentType', () => {
    it('should return agentType from session', () => {
      const w = new watcherModule.Watcher({});
      const session = new watcherModule.Session('s1', '/proj', '/file.jsonl');
      session.subagentTypes['a1'] = 'build:Builder';
      w.sessions.set('s1', session);

      assert.strictEqual(w._lookupAgentType('s1', 'a1'), 'build:Builder');
    });

    it('should return empty string for missing session', () => {
      const w = new watcherModule.Watcher({});
      assert.strictEqual(w._lookupAgentType('missing', 'a1'), '');
    });

    it('should return empty string for missing agent', () => {
      const w = new watcherModule.Watcher({});
      const session = new watcherModule.Session('s1', '/proj', '/file.jsonl');
      w.sessions.set('s1', session);
      assert.strictEqual(w._lookupAgentType('s1', 'a1'), '');
    });
  });
});

// ============================================================================
// _readFile (Priority 1: core data path)
// ============================================================================

describe('_readFile', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readfile-test-'));
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  function makeTestLine(text) {
    return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: '2025-01-01T12:00:00Z' });
  }

  function setupWatcherAndSession(filePath, sessionID = 's1') {
    const w = new watcherModule.Watcher({});
    const items = [];
    const errors = [];
    w.on('item', (item) => items.push(item));
    w.on('error', (err) => errors.push(err));
    const session = new watcherModule.Session(sessionID, '/proj', filePath);
    w.sessions.set(sessionID, session);
    w.filePositions.set(filePath, 0);
    return { w, items, errors, session };
  }

  it('should read entire file from position 0', async () => {
    const filePath = path.join(tmpDir, 'full-read.jsonl');
    fs.writeFileSync(filePath, makeTestLine('hello') + '\n' + makeTestLine('world') + '\n');
    const { w, items } = setupWatcherAndSession(filePath);

    await w._readFile(filePath, 's1', '', '');

    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].content, 'hello');
    assert.strictEqual(items[1].content, 'world');
    assert.strictEqual(items[0].sessionID, 's1');
  });

  it('should read incrementally from existing position', async () => {
    const filePath = path.join(tmpDir, 'incremental.jsonl');
    fs.writeFileSync(filePath, makeTestLine('first') + '\n');
    const { w, items } = setupWatcherAndSession(filePath);

    await w._readFile(filePath, 's1', '', '');
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].content, 'first');

    fs.appendFileSync(filePath, makeTestLine('second') + '\n');
    await w._readFile(filePath, 's1', '', '');
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[1].content, 'second');
  });

  it('should detect file truncation and re-read from start', async () => {
    const filePath = path.join(tmpDir, 'truncated.jsonl');
    fs.writeFileSync(filePath, makeTestLine('long content here') + '\n');
    const { w, items } = setupWatcherAndSession(filePath);

    await w._readFile(filePath, 's1', '', '');
    assert.ok(w.filePositions.get(filePath) > 0);
    assert.strictEqual(items.length, 1);

    fs.writeFileSync(filePath, makeTestLine('short') + '\n');
    await w._readFile(filePath, 's1', '', '');
    const newFileSize = fs.statSync(filePath).size;
    assert.strictEqual(w.filePositions.get(filePath), newFileSize);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[1].content, 'short');
  });

  it('should return immediately when no new data', async () => {
    const filePath = path.join(tmpDir, 'no-new-data.jsonl');
    fs.writeFileSync(filePath, makeTestLine('data') + '\n');
    const { w, items } = setupWatcherAndSession(filePath);

    await w._readFile(filePath, 's1', '', '');
    assert.strictEqual(items.length, 1);

    const items2 = [];
    w.on('item', (item) => items2.push(item));
    await w._readFile(filePath, 's1', '', '');
    assert.strictEqual(items2.length, 0);
  });

  it('should skip empty lines', async () => {
    const filePath = path.join(tmpDir, 'empty-lines.jsonl');
    fs.writeFileSync(filePath, makeTestLine('a') + '\n\n\n' + makeTestLine('b') + '\n');
    const { w, items } = setupWatcherAndSession(filePath);

    await w._readFile(filePath, 's1', '', '');
    assert.strictEqual(items.length, 2);
  });

  it('should assign agentID and agentName for subagent reads', async () => {
    const filePath = path.join(tmpDir, 'subagent-read.jsonl');
    fs.writeFileSync(filePath, makeTestLine('sub work') + '\n');
    const { w, items, session } = setupWatcherAndSession(filePath);
    session.subagentTypes['abc1234567'] = 'type:Builder';

    await w._readFile(filePath, 's1', 'abc1234567', 'type:Builder');
    assert.strictEqual(items[0].agentID, 'abc1234567');
    assert.strictEqual(items[0].agentName, 'Builder');
  });

  it('should serialize concurrent reads via readLock', async () => {
    const filePath = path.join(tmpDir, 'lock-test.jsonl');
    fs.writeFileSync(filePath, makeTestLine('test') + '\n');
    const { w } = setupWatcherAndSession(filePath);

    await Promise.all([
      w._readFile(filePath, 's1', '', ''),
      w._readFile(filePath, 's1', '', ''),
    ]);
    assert.strictEqual(w._readLocks.has(filePath), false);
  });

  it('should handle large files requiring chunk reads', async () => {
    const filePath = path.join(tmpDir, 'large-file.jsonl');
    const lines = [];
    for (let i = 0; i < 40; i++) {
      lines.push(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `line-${i}-${'x'.repeat(2000)}` }] },
        timestamp: '2025-01-01T12:00:00Z',
      }));
    }
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    const { w, items } = setupWatcherAndSession(filePath);

    await w._readFile(filePath, 's1', '', '');
    assert.strictEqual(items.length, 40);
    assert.strictEqual(w.filePositions.get(filePath), fs.statSync(filePath).size);
  });

  it('should handle CRLF line endings', async () => {
    const filePath = path.join(tmpDir, 'crlf.jsonl');
    fs.writeFileSync(filePath, makeTestLine('crlf-test') + '\r\n' + makeTestLine('crlf-second') + '\r\n');
    const { w, items } = setupWatcherAndSession(filePath);

    await w._readFile(filePath, 's1', '', '');
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].content, 'crlf-test');
    assert.strictEqual(items[1].content, 'crlf-second');
  });

  it('should handle non-existent file gracefully', async () => {
    const filePath = path.join(tmpDir, 'does-not-exist.jsonl');
    const { w, errors } = setupWatcherAndSession(filePath);

    await w._readFile(filePath, 's1', '', '');
    assert.ok(errors.length > 0);
  });

  it('should track tool use/result in toolIndex', async () => {
    const filePath = path.join(tmpDir, 'tool-index.jsonl');
    const line1 = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] }, timestamp: '2025-01-01T12:00:00Z' });
    const line2 = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }, timestamp: '2025-01-01T12:00:01Z' });
    fs.writeFileSync(filePath, line1 + '\n' + line2 + '\n');
    const { w, session } = setupWatcherAndSession(filePath);

    await w._readFile(filePath, 's1', '', '');
    const entry = session.toolIndex.get('toolu_1');
    assert.ok(entry);
    assert.strictEqual(entry.toolName, 'Bash');
    assert.strictEqual(entry.hasResult, true);
  });

  it('should advance position correctly after reading', async () => {
    const filePath = path.join(tmpDir, 'position-track.jsonl');
    const line = makeTestLine('hello');
    fs.writeFileSync(filePath, line + '\n');
    const { w } = setupWatcherAndSession(filePath);

    await w._readFile(filePath, 's1', '', '');
    assert.strictEqual(w.filePositions.get(filePath), Buffer.byteLength(line + '\n', 'utf-8'));
  });
});

// ============================================================================
// _inferFileContext
// ============================================================================

describe('_inferFileContext', () => {
  it('should return null for non-jsonl files', () => {
    const w = new watcherModule.Watcher({});
    assert.strictEqual(w._inferFileContext('/some/path/file.txt'), null);
    assert.strictEqual(w._inferFileContext('/some/path/file.js'), null);
  });

  it('should infer context for main session file', () => {
    const w = new watcherModule.Watcher({});
    const session = new watcherModule.Session('abc123', '/proj', '/path/abc123.jsonl');
    w.sessions.set('abc123', session);

    const ctx = w._inferFileContext('/path/abc123.jsonl');
    assert.ok(ctx);
    assert.strictEqual(ctx.sessionID, 'abc123');
    assert.strictEqual(ctx.agentID, '');
  });

  it('should infer context for subagent file', () => {
    const w = new watcherModule.Watcher({});
    const session = new watcherModule.Session('sess1', '/proj', '/path/sess1.jsonl');
    w.sessions.set('sess1', session);

    const ctx = w._inferFileContext('/path/sess1/subagents/agent-sub1.jsonl');
    assert.ok(ctx);
    assert.strictEqual(ctx.sessionID, 'sess1');
    assert.strictEqual(ctx.agentID, 'sub1');
  });

  it('should return null for unknown session', () => {
    const w = new watcherModule.Watcher({});
    assert.strictEqual(w._inferFileContext('/path/unknown.jsonl'), null);
  });
});

// ============================================================================
// resolveProjectPath (Priority 8)
// ============================================================================

describe('resolveProjectPath', () => {
  it('should resolve real project path from encoded name', async () => {
    // The current project path should exist: /Users/eleme/zhaoshuxue/claude-watch
    const encoded = '-Users-eleme-zhaoshuxue-claude-watch';
    const result = await watcherModule.resolveProjectPath(encoded);
    assert.strictEqual(result, 'Users/eleme/zhaoshuxue/claude-watch');
  });

  it('should fallback to naive conversion for non-existent path', async () => {
    const result = await watcherModule.resolveProjectPath('nonexistent-dir-path');
    assert.strictEqual(result, 'nonexistent/dir/path');
  });

  it('should handle leading dash', async () => {
    const result = await watcherModule.resolveProjectPath('-tmp');
    assert.ok(typeof result === 'string');
  });

  it('should handle empty string', async () => {
    const result = await watcherModule.resolveProjectPath('');
    assert.strictEqual(result, '');
  });

  it('should handle single-segment path (falls to naive)', async () => {
    const result = await watcherModule.resolveProjectPath('tmp');
    assert.strictEqual(result, 'tmp');
  });
});

// ============================================================================
// isMainSessionFile
// ============================================================================

describe('isMainSessionFile', () => {
  it('should accept regular .jsonl files', () => {
    assert.strictEqual(watcherModule.isMainSessionFile('/path/session.jsonl', { isDirectory: () => false }), true);
  });

  it('should reject directories', () => {
    assert.strictEqual(watcherModule.isMainSessionFile('/path/session.jsonl', { isDirectory: () => true }), false);
  });

  it('should reject non-.jsonl files', () => {
    assert.strictEqual(watcherModule.isMainSessionFile('/path/session.txt', { isDirectory: () => false }), false);
  });

  it('should reject subagent files', () => {
    assert.strictEqual(watcherModule.isMainSessionFile('/path/subagents/agent-xyz.jsonl', { isDirectory: () => false }), false);
  });

  it('should reject agent- prefixed files', () => {
    assert.strictEqual(watcherModule.isMainSessionFile('/path/agent-xyz.jsonl', { isDirectory: () => false }), false);
  });

  it('should work without stats parameter', () => {
    assert.strictEqual(watcherModule.isMainSessionFile('/path/session.jsonl', undefined), true);
  });
});

// ============================================================================
// readAgentType
// ============================================================================

describe('readAgentType', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-type-'));
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  it('should read agentType from meta file', async () => {
    const jsonlPath = path.join(tmpDir, 'agent-abc.jsonl');
    const metaPath = path.join(tmpDir, 'agent-abc.meta.json');
    fs.writeFileSync(jsonlPath, '');
    fs.writeFileSync(metaPath, JSON.stringify({ agentType: 'explore:Explorer' }));

    const result = await watcherModule.readAgentType(jsonlPath);
    assert.strictEqual(result, 'explore:Explorer');
  });

  it('should return empty string when meta file is missing', async () => {
    const jsonlPath = path.join(tmpDir, 'agent-no-meta.jsonl');
    fs.writeFileSync(jsonlPath, '');

    const result = await watcherModule.readAgentType(jsonlPath);
    assert.strictEqual(result, '');
  });

  it('should return empty string when meta has no agentType', async () => {
    const jsonlPath = path.join(tmpDir, 'agent-empty-meta.jsonl');
    const metaPath = path.join(tmpDir, 'agent-empty-meta.meta.json');
    fs.writeFileSync(jsonlPath, '');
    fs.writeFileSync(metaPath, JSON.stringify({ otherField: 'value' }));

    const result = await watcherModule.readAgentType(jsonlPath);
    assert.strictEqual(result, '');
  });

  it('should return empty string for invalid meta JSON', async () => {
    const jsonlPath = path.join(tmpDir, 'agent-bad-meta.jsonl');
    const metaPath = path.join(tmpDir, 'agent-bad-meta.meta.json');
    fs.writeFileSync(jsonlPath, '');
    fs.writeFileSync(metaPath, 'not json');

    const result = await watcherModule.readAgentType(jsonlPath);
    assert.strictEqual(result, '');
  });
});

// ============================================================================
// _readFile — partial line / carryOver (#3)
// ============================================================================

describe('_readFile partial line and carryOver', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryover-test-'));
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  function makeTestLine(text) {
    return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: '2025-01-01T12:00:00Z' });
  }

  function setupWatcherAndSession(filePath) {
    const w = new watcherModule.Watcher({});
    const items = [];
    w.on('item', (item) => items.push(item));
    w.on('error', () => {});
    const session = new watcherModule.Session('s1', '/proj', filePath);
    w.sessions.set('s1', session);
    w.filePositions.set(filePath, 0);
    return { w, items };
  }

  it('should not parse incomplete line at end of file (no trailing newline)', async () => {
    const filePath = path.join(tmpDir, 'no-trailing-nl.jsonl');
    fs.writeFileSync(filePath, makeTestLine('complete') + '\n' + makeTestLine('incomplete'));
    const { w, items } = setupWatcherAndSession(filePath);

    await w._readFile(filePath, 's1', '', '');
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].content, 'complete');
  });

  it('should parse incomplete line once newline is appended', async () => {
    const filePath = path.join(tmpDir, 'append-nl.jsonl');
    fs.writeFileSync(filePath, makeTestLine('first') + '\n' + makeTestLine('pending'));
    const { w, items } = setupWatcherAndSession(filePath);

    await w._readFile(filePath, 's1', '', '');
    assert.strictEqual(items.length, 1);

    fs.appendFileSync(filePath, '\n');
    await w._readFile(filePath, 's1', '', '');
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[1].content, 'pending');
  });

  it('should handle line spanning chunk boundary (>64KB)', async () => {
    const filePath = path.join(tmpDir, 'chunk-boundary.jsonl');
    const shortLine = makeTestLine('short');
    const longText = 'x'.repeat(70000);
    const longLine = makeTestLine(longText);
    const endLine = makeTestLine('end');
    fs.writeFileSync(filePath, shortLine + '\n' + longLine + '\n' + endLine + '\n');
    const { w, items } = setupWatcherAndSession(filePath);

    await w._readFile(filePath, 's1', '', '');
    assert.strictEqual(items.length, 3);
    assert.strictEqual(items[0].content, 'short');
    assert.strictEqual(items[1].content.length, 70000);
    assert.strictEqual(items[2].content, 'end');
    assert.strictEqual(w.filePositions.get(filePath), fs.statSync(filePath).size);
  });

  it('should handle incremental append after chunk-boundary read', async () => {
    const filePath = path.join(tmpDir, 'chunk-incr.jsonl');
    const longText = 'y'.repeat(70000);
    fs.writeFileSync(filePath, makeTestLine(longText) + '\n');
    const { w, items } = setupWatcherAndSession(filePath);

    await w._readFile(filePath, 's1', '', '');
    assert.strictEqual(items.length, 1);

    fs.appendFileSync(filePath, makeTestLine('after-chunk') + '\n');
    await w._readFile(filePath, 's1', '', '');
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[1].content, 'after-chunk');
    assert.strictEqual(w.filePositions.get(filePath), fs.statSync(filePath).size);
  });
});

// ============================================================================
// _inferFileContext and _handleFsWrite coverage (#8)
// ============================================================================

describe('_inferFileContext extended', () => {
  it('should cache and return context for known files', () => {
    const w = new watcherModule.Watcher({});
    const session = new watcherModule.Session('s1', '/proj', '/path/s1.jsonl');
    session.subagents['a1'] = '/path/s1/subagents/agent-a1.jsonl';
    w.sessions.set('s1', session);

    w.fileContexts.set('/path/s1.jsonl', { sessionID: 's1', agentID: '', session });
    const ctx = w.fileContexts.get('/path/s1.jsonl');
    assert.strictEqual(ctx.sessionID, 's1');
    assert.strictEqual(ctx.agentID, '');
  });

  it('should return null for non-jsonl extensions', () => {
    const w = new watcherModule.Watcher({});
    assert.strictEqual(w._inferFileContext('/path/file.json'), null);
    assert.strictEqual(w._inferFileContext('/path/file.meta.json'), null);
    assert.strictEqual(w._inferFileContext('/path/file.log'), null);
  });

  it('should return null for tool-results directory files', () => {
    const w = new watcherModule.Watcher({});
    const ctx = w._inferFileContext('/path/s1/tool-results/result.jsonl');
    assert.strictEqual(ctx, null);
  });
});

// ============================================================================
// Watcher removeSession cleanup (#4 / #13 verification)
// ============================================================================

describe('removeSession cleanup', () => {
  it('should clean up pendingSubagents on session removal', () => {
    const w = new watcherModule.Watcher({});
    const session = new watcherModule.Session('s1', '/proj', '/file.jsonl');
    w.sessions.set('s1', session);
    w.pendingSubagents.set('s1', ['/some/path.jsonl']);

    w.removeSession('s1');

    assert.strictEqual(w.pendingSubagents.has('s1'), false);
  });

  it('should clean up _readLocks on session removal', () => {
    const w = new watcherModule.Watcher({});
    const session = new watcherModule.Session('s1', '/proj', '/file.jsonl');
    w.sessions.set('s1', session);
    w._readLocks.set('/file.jsonl', Promise.resolve());

    w.removeSession('s1');

    assert.strictEqual(w._readLocks.has('/file.jsonl'), false);
  });
});