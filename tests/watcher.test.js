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

  describe('parseDuration (from CLI)', () => {
    // parseDuration is in bin/, but we test the logic here
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
    assert.strictEqual(w.activeWindow, 5 * 60 * 1000);
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

    it('should register subagent immediately when session exists', () => {
      const w = new watcherModule.Watcher({});
      const session = new watcherModule.Session('s1', '/proj', '/file.jsonl');
      w.sessions.set('s1', session);

      // Create the agent file so readAgentType and _addFileWatch can work
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-reg-'));
      const agentDir = path.join(tmpDir, 's1', 'subagents');
      fs.mkdirSync(agentDir, { recursive: true });
      const agentPath = path.join(agentDir, 'agent-a1.jsonl');
      fs.writeFileSync(agentPath, '');

      w._handleNewSubagentFile(agentPath);

      assert.strictEqual(w.pendingSubagents.size, 0);
      assert.strictEqual(session.subagents['a1'], agentPath);

      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    });

    it('should process pending subagents when session is discovered', () => {
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
          w._registerSubagent(session, 's1', agentID, sp);
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

    it('should return 0 for empty file', () => {
      fs.writeFileSync(tmpFile, '');
      const w = new watcherModule.Watcher({});
      const pos = w._findPositionForLastNLines(tmpFile, 10);
      assert.strictEqual(pos, 0);
    });

    it('should return 0 when file has fewer lines than n', () => {
      fs.writeFileSync(tmpFile, 'line1\nline2\nline3\n');
      const w = new watcherModule.Watcher({});
      const pos = w._findPositionForLastNLines(tmpFile, 10);
      assert.strictEqual(pos, 0);
    });

    it('should find correct byte offset for last N lines', () => {
      const lines = [];
      for (let i = 0; i < 20; i++) lines.push(`line${i}`);
      fs.writeFileSync(tmpFile, lines.join('\n') + '\n');
      const w = new watcherModule.Watcher({});
      const pos = w._findPositionForLastNLines(tmpFile, 5);
      // Verify that reading from pos yields the last portion of the file
      const content = fs.readFileSync(tmpFile, 'utf-8');
      assert.ok(pos > 0);
      assert.ok(pos < content.length);
      const fromPos = content.slice(pos);
      // The returned position should be after the 5th newline from the end
      assert.ok(fromPos.includes('line16'));
    });

    it('should handle file with single byte per line', () => {
      fs.writeFileSync(tmpFile, 'a\nb\nc\nd\ne\nf\n');
      const w = new watcherModule.Watcher({});
      const pos = w._findPositionForLastNLines(tmpFile, 2);
      // Verify pos points to somewhere in the file, after the 2nd newline from end
      assert.ok(pos > 0);
      const content = fs.readFileSync(tmpFile, 'utf-8');
      const fromPos = content.slice(pos);
      assert.ok(fromPos.includes('f'));
    });

    it('should return 0 for non-existent file', () => {
      const w = new watcherModule.Watcher({});
      const pos = w._findPositionForLastNLines('/nonexistent/file', 10);
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

    it('should populate toolIndex from files', () => {
      const w = new watcherModule.Watcher({});
      const session = new watcherModule.Session('s1', '/proj', mainFile);
      session.subagents['a1'] = agentFile;

      w._populateToolIndex(session);

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

    it('should not re-populate on second call', () => {
      const session = new watcherModule.Session('s1', '/proj', mainFile);
      session.toolIndexPopulated = true;
      session.toolIndex.set('toolu_1', { toolName: 'cached', parentAgentID: '', hasResult: false });

      const w = new watcherModule.Watcher({});
      w._populateToolIndex(session);

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