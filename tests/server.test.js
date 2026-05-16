'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocket } = require('ws');
const { DashboardServer } = require('../src/server/server');
const { Session } = require('../src/watcher/watcher');

// ============================================================================
// Helpers
// ============================================================================

function createServer() {
  return new DashboardServer({ port: 0, host: '127.0.0.1', debugAll: false });
}

function makeRequest(server, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: server.port,
      path: pathname,
      method,
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function startBareServer(ds) {
  // Start just the HTTP + WS server without browser open, watcher init, or killExistingPort
  ds.server = http.createServer((req, res) => {
    ds.handleHTTP(req, res).catch(() => {
      if (!res.headersSent) { res.writeHead(500); res.end('Internal Server Error'); }
    });
  });

  const { WebSocketServer } = require('ws');
  ds.wss = new WebSocketServer({ server: ds.server });
  ds.wss.on('connection', (ws) => ds.onWsConnection(ws));

  return new Promise((resolve, reject) => {
    ds.server.listen(0, '127.0.0.1', () => {
      ds.port = ds.server.address().port;
      resolve();
    });
    ds.server.on('error', reject);
  });
}

// ============================================================================
// DashboardServer internals
// ============================================================================

describe('DashboardServer internals', () => {
  it('should construct with default options', () => {
    const ds = new DashboardServer();
    assert.strictEqual(ds.port, 23000);
    assert.strictEqual(ds.host, '127.0.0.1');
    assert.strictEqual(ds.collapseAfterMs, 0);
    assert.strictEqual(ds.itemBuffer.length, 0);
    assert.strictEqual(ds.contextMap.size, 0);
    assert.strictEqual(ds.watcher, null);
  });

  it('should construct with custom options', () => {
    const ds = new DashboardServer({ port: 8080, host: '0.0.0.0', collapseAfter: 120000 });
    assert.strictEqual(ds.port, 8080);
    assert.strictEqual(ds.host, '0.0.0.0');
    assert.strictEqual(ds.collapseAfterMs, 120000);
  });

  describe('getCtxKey', () => {
    const ds = createServer();
    it('should combine sessionID and agentID', () => {
      assert.strictEqual(ds.getCtxKey('s1', 'a1'), 's1:a1');
    });
    it('should use empty string when agentID is omitted', () => {
      assert.strictEqual(ds.getCtxKey('s1'), 's1:');
      assert.strictEqual(ds.getCtxKey('s1', undefined), 's1:');
    });
  });

  describe('updateContext / getContextSnapshot', () => {
    const ds = createServer();

    it('should aggregate token counts per agent', () => {
      ds.updateContext({ sessionID: 's1', agentID: '', inputTokens: 100, outputTokens: 50 });
      ds.updateContext({ sessionID: 's1', agentID: 'a1', inputTokens: 200, outputTokens: 100 });
      ds.updateContext({ sessionID: 's1', agentID: '', inputTokens: 50, outputTokens: 25 });

      const snap = ds.getContextSnapshot();
      assert.strictEqual(Object.keys(snap).length, 2);
      assert.strictEqual(snap['s1:'].inputTokens, 100);
      assert.strictEqual(snap['s1:'].outputTokens, 75);
      assert.strictEqual(snap['s1:a1'].inputTokens, 200);
    });

    it('should update model and contextWindow', () => {
      ds.updateContext({ sessionID: 's2', agentID: '', model: 'claude-opus-4-7', inputTokens: 10 });
      const snap = ds.getContextSnapshot();
      assert.strictEqual(snap['s2:'].model, 'claude-opus-4-7');
      assert.strictEqual(snap['s2:'].contextWindow, 1000000);
    });

    it('should aggregate cache tokens', () => {
      ds.updateContext({ sessionID: 's3', agentID: '', cacheCreationTokens: 500, cacheReadTokens: 300 });
      ds.updateContext({ sessionID: 's3', agentID: '', cacheCreationTokens: 200, cacheReadTokens: 100 });
      const snap = ds.getContextSnapshot();
      assert.strictEqual(snap['s3:'].cacheCreation, 700);
      assert.strictEqual(snap['s3:'].cacheRead, 400);
    });

    it('should clean up context entries for removed session', () => {
      ds.updateContext({ sessionID: 'rm', agentID: '', inputTokens: 1 });
      ds.updateContext({ sessionID: 'rm', agentID: 'x', inputTokens: 2 });
      assert.ok(ds.getContextSnapshot()['rm:']);
      assert.ok(ds.getContextSnapshot()['rm:x']);

      // Simulate the sessionRemoved handler logic
      for (const key of ds.contextMap.keys()) {
        if (key.startsWith('rm:')) ds.contextMap.delete(key);
      }

      assert.ok(!ds.getContextSnapshot()['rm:']);
      assert.ok(!ds.getContextSnapshot()['rm:x']);
    });
  });

  describe('itemBuffer', () => {
    it('should push items and cap at MAX_ITEM_BUFFER', () => {
      const ds = createServer();
      for (let i = 0; i < 2500; i++) {
        ds.itemBuffer.push({ type: 'item', index: i });
        if (ds.itemBuffer.length > 2000) {
          ds.itemBuffer.splice(0, ds.itemBuffer.length - 2000);
        }
      }
      assert.strictEqual(ds.itemBuffer.length, 2000);
    });
  });
});

// ============================================================================
// HTTP integration tests
// ============================================================================

describe('HTTP API integration', () => {
  let ds;

  before(async () => {
    ds = createServer();
    await startBareServer(ds);
  });

  after(() => {
    ds.stop();
  });

  describe('static files', () => {
    it('should serve index.html for /', async () => {
      const res = await makeRequest(ds, '/');
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.headers['content-type'].includes('text/html'));
      assert.ok(res.body.includes('claude-watch'));
    });

    it('should serve index.html for /index.html', async () => {
      const res = await makeRequest(ds, '/index.html');
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.headers['content-type'].includes('text/html'));
    });

    it('should serve vendor JS files', async () => {
      const res = await makeRequest(ds, '/vendor/highlight.min.js');
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.headers['content-type'].includes('javascript'));
      assert.ok(res.body.length > 0);
    });

    it('should serve vendor CSS files', async () => {
      const res = await makeRequest(ds, '/vendor/github-dark.min.css');
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.headers['content-type'].includes('text/css'));
    });

    it('should return 404 for non-existent files', async () => {
      const res = await makeRequest(ds, '/nonexistent.css');
      assert.strictEqual(res.statusCode, 404);
    });

    it('should block path traversal via .. (returns 403 or 404)', async () => {
      // Node's URL + path.resolve normalizes .. away, so resolved path falls outside public/
      // and either gets blocked by the traversal check (403) or serveStatic (404)
      const res = await makeRequest(ds, '/../../../etc/passwd');
      assert.ok(res.statusCode === 403 || res.statusCode === 404);
    });
  });

  describe('API endpoints', () => {
    it('/api/status should return session list and context', async () => {
      ds.updateContext({ sessionID: 'test-s1', agentID: '', inputTokens: 100, outputTokens: 50 });
      const res = await makeRequest(ds, '/api/status');
      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.ok(Array.isArray(data.sessions));
      assert.ok('autoDiscovery' in data);
      assert.ok('context' in data);
      assert.strictEqual(data.context['test-s1:'].inputTokens, 100);
    });

    it('/api/context should return context snapshot', async () => {
      const res = await makeRequest(ds, '/api/context');
      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.ok('test-s1:' in data);
      assert.strictEqual(data['test-s1:'].inputTokens, 100);
    });

    it('/api/task-output without path param should return 400', async () => {
      const res = await makeRequest(ds, '/api/task-output');
      assert.strictEqual(res.statusCode, 400);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.error, 'Missing path param');
    });

    it('/api/task-output with path outside allowed dir should return 403', async () => {
      const res = await makeRequest(ds, '/api/task-output?path=/etc/passwd');
      assert.strictEqual(res.statusCode, 403);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.error, 'Access denied');
    });

    it('/api/task-output with non-existent file should return 403 (path unresolvable)', async () => {
      const fakePath = path.resolve(os.homedir(), '.claude', 'projects', 'nonexistent', 'file.txt');
      const res = await makeRequest(ds, `/api/task-output?path=${encodeURIComponent(fakePath)}`);
      assert.strictEqual(res.statusCode, 403);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.error, 'Access denied');
    });

    it('/api/sessions should return array', async () => {
      const res = await makeRequest(ds, '/api/sessions');
      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.ok(Array.isArray(data));
    });

    it('/api/sessions/active should return array', async () => {
      const res = await makeRequest(ds, '/api/sessions/active');
      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.ok(Array.isArray(data));
    });

    it('unknown API route should return 404', async () => {
      const res = await makeRequest(ds, '/api/unknown');
      assert.strictEqual(res.statusCode, 404);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.error, 'Not Found');
    });
  });
});

// ============================================================================
// WebSocket integration tests
// ============================================================================

describe('WebSocket integration', () => {
  let ds;

  before(async () => {
    ds = createServer();
    ds.updateContext({ sessionID: 'ws-s1', agentID: '', inputTokens: 42 });
    ds.itemBuffer.push({ type: 'text', sessionID: 'ws-s1', agentID: '', content: 'hello' });
    ds.collapseAfterMs = 300000;
    await startBareServer(ds);
  });

  after(() => {
    ds.stop();
  });

  it('should send context, itemBatch, and config on connection', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${ds.port}`);
    const messages = [];

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 3000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8'));
        messages.push(msg);
        if (messages.length >= 3) { clearTimeout(timer); ws.close(); resolve(); }
      });
      ws.on('error', () => { clearTimeout(timer); ws.close(); resolve(); });
      ws.on('close', () => { clearTimeout(timer); resolve(); });
    });

    const ctxMsg = messages.find(m => m.type === 'context');
    assert.ok(ctxMsg);
    assert.ok('ws-s1:' in ctxMsg.payload);
    assert.strictEqual(ctxMsg.payload['ws-s1:'].inputTokens, 42);

    const batchMsg = messages.find(m => m.type === 'itemBatch');
    assert.ok(batchMsg);
    assert.strictEqual(batchMsg.payload.length, 1);
    assert.strictEqual(batchMsg.payload[0].content, 'hello');

    const cfgMsg = messages.find(m => m.type === 'config');
    assert.ok(cfgMsg);
    assert.strictEqual(cfgMsg.payload.collapseAfter, 300000);
  });

  it('should broadcast items to all connected clients', async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${ds.port}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${ds.port}`);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(reject, 3000);
      let connected = 0;
      const onOpen = () => { connected++; if (connected === 2) { clearTimeout(timer); resolve(); } };
      ws1.on('open', onOpen);
      ws2.on('open', onOpen);
      ws1.on('error', () => {});
      ws2.on('error', () => {});
    });

    // Drain initial messages from both clients
    await new Promise(r => setTimeout(r, 50));

    const item = { type: 'thinking', sessionID: 'ws-s1', agentID: '', content: 'test broadcast' };
    ds.broadcast('item', item);

    const msgs1 = [];
    const msgs2 = [];

    await new Promise((resolve) => {
      ws1.on('message', (d) => { msgs1.push(JSON.parse(d.toString())); });
      ws2.on('message', (d) => { msgs2.push(JSON.parse(d.toString())); });
      setTimeout(() => { ws1.close(); ws2.close(); resolve(); }, 200);
    });

    const itemMsg1 = msgs1.find(m => m.type === 'item');
    const itemMsg2 = msgs2.find(m => m.type === 'item');
    assert.ok(itemMsg1);
    assert.ok(itemMsg2);
    assert.strictEqual(itemMsg1.payload.content, 'test broadcast');
    assert.strictEqual(itemMsg2.payload.content, 'test broadcast');
  });

  it('should track connected clients', async () => {
    const freshDs = createServer();
    freshDs.collapseAfterMs = 10000;
    await startBareServer(freshDs);

    assert.strictEqual(freshDs.clients.size, 0);
    const ws = new WebSocket(`ws://127.0.0.1:${freshDs.port}`);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 3000);
      ws.on('open', () => { clearTimeout(timer); resolve(); });
      ws.on('error', () => { clearTimeout(timer); ws.close(); resolve(); });
    });

    assert.strictEqual(freshDs.clients.size, 1);

    ws.close();
    // Wait for server-side close handler to remove from clients
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.strictEqual(freshDs.clients.size, 0);
    freshDs.stop();
  });
});

// ============================================================================
// /api/task-output success path (Priority 3)
// ============================================================================

describe('/api/task-output success path', () => {
  let ds;
  let testDir;
  let testFile;

  before(async () => {
    testDir = path.join(os.homedir(), '.claude', 'projects', '__test_task_output__');
    testFile = path.join(testDir, 'result.txt');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(testFile, 'test output content');

    ds = createServer();
    await startBareServer(ds);
  });

  after(() => {
    ds.stop();
    try { fs.rmSync(testDir, { recursive: true }); } catch {}
  });

  it('should return file content for valid path within allowed directory', async () => {
    const res = await makeRequest(ds, `/api/task-output?path=${encodeURIComponent(testFile)}`);
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.content, 'test output content');
  });
});

// ============================================================================
// cleanupContextMap (Priority 5)
// ============================================================================

describe('cleanupContextMap', () => {
  it('should remove stale context entries', () => {
    const ds = createServer();
    ds.contextMap.set('s1:', { inputTokens: 100, outputTokens: 0, cacheCreation: 0, cacheRead: 0, model: '', contextWindow: 200000, lastActivity: Date.now() });
    ds.contextMap.set('s2:', { inputTokens: 200, outputTokens: 0, cacheCreation: 0, cacheRead: 0, model: '', contextWindow: 200000, lastActivity: Date.now() - 61 * 60 * 1000 });

    ds.cleanupContextMap();

    assert.ok(ds.contextMap.has('s1:'));
    assert.ok(!ds.contextMap.has('s2:'));
  });

  it('should keep entries within stale threshold', () => {
    const ds = createServer();
    ds.contextMap.set('s3:', { inputTokens: 50, outputTokens: 0, cacheCreation: 0, cacheRead: 0, model: '', contextWindow: 200000, lastActivity: Date.now() - 30 * 60 * 1000 });

    ds.cleanupContextMap();

    assert.ok(ds.contextMap.has('s3:'));
  });

  it('should remove all entries when all are stale', () => {
    const ds = createServer();
    ds.contextMap.set('old1:', { inputTokens: 1, outputTokens: 0, cacheCreation: 0, cacheRead: 0, model: '', contextWindow: 200000, lastActivity: Date.now() - 120 * 60 * 1000 });
    ds.contextMap.set('old2:', { inputTokens: 2, outputTokens: 0, cacheCreation: 0, cacheRead: 0, model: '', contextWindow: 200000, lastActivity: Date.now() - 90 * 60 * 1000 });

    ds.cleanupContextMap();

    assert.strictEqual(ds.contextMap.size, 0);
  });
});

// ============================================================================
// WS handleCommand (Priority 6)
// ============================================================================

describe('WS handleCommand', () => {
  let ds;

  before(async () => {
    ds = createServer();
    ds.setupWatcher({});
    await startBareServer(ds);
  });

  after(() => {
    ds.stop();
  });

  it('should toggle auto discovery via command', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${ds.port}`);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 3000);
      ws.on('open', () => { clearTimeout(timer); resolve(); });
      ws.on('error', () => { clearTimeout(timer); ws.close(); resolve(); });
    });

    await new Promise(r => setTimeout(r, 100));

    const messages = [];
    ws.on('message', (data) => { messages.push(JSON.parse(data.toString())); });

    ws.send(JSON.stringify({ action: 'toggleAutoDiscovery' }));
    await new Promise(r => setTimeout(r, 200));

    const autoDiscoMsg = messages.find(m => m.type === 'autoDiscoveryChanged');
    assert.ok(autoDiscoMsg);
    assert.strictEqual(autoDiscoMsg.payload.enabled, false);

    ws.close();
  });

  it('should remove session via command', async () => {
    const session = new Session('test-rm', '/proj', '/file.jsonl');
    ds.watcher.sessions.set('test-rm', session);

    const ws = new WebSocket(`ws://127.0.0.1:${ds.port}`);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 3000);
      ws.on('open', () => { clearTimeout(timer); resolve(); });
      ws.on('error', () => { clearTimeout(timer); ws.close(); resolve(); });
    });

    await new Promise(r => setTimeout(r, 100));

    const messages = [];
    ws.on('message', (data) => { messages.push(JSON.parse(data.toString())); });

    ws.send(JSON.stringify({ action: 'removeSession', sessionID: 'test-rm' }));
    await new Promise(r => setTimeout(r, 200));

    assert.ok(!ds.watcher.sessions.has('test-rm'));
    const rmMsg = messages.find(m => m.type === 'sessionRemoved');
    assert.ok(rmMsg);
    assert.strictEqual(rmMsg.payload.sessionID, 'test-rm');

    ws.close();
  });

  it('should set skip history via command', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${ds.port}`);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 3000);
      ws.on('open', () => { clearTimeout(timer); resolve(); });
      ws.on('error', () => { clearTimeout(timer); ws.close(); resolve(); });
    });

    ws.send(JSON.stringify({ action: 'setSkipHistory', skip: true }));
    await new Promise(r => setTimeout(r, 100));

    assert.strictEqual(ds.watcher.skipHistory, true);

    ws.close();
  });

  it('should send context via getContext command', async () => {
    ds.updateContext({ sessionID: 'ctx-s1', agentID: '', inputTokens: 99, outputTokens: 0 });

    const ws = new WebSocket(`ws://127.0.0.1:${ds.port}`);
    const messages = [];

    await new Promise((resolve, reject) => {
      const timer = setTimeout(reject, 3000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        // Wait for initial 3 msgs + 1 getContext response
        if (messages.length >= 4) { clearTimeout(timer); resolve(); }
      });
      ws.on('open', () => {
        setTimeout(() => { ws.send(JSON.stringify({ action: 'getContext' })); }, 100);
      });
      ws.on('error', () => { clearTimeout(timer); ws.close(); resolve(); });
      ws.on('close', () => { clearTimeout(timer); resolve(); });
    });

    const ctxMsgs = messages.filter(m => m.type === 'context');
    const lastCtx = ctxMsgs[ctxMsgs.length - 1];
    assert.ok(lastCtx);
    assert.strictEqual(lastCtx.payload['ctx-s1:'].inputTokens, 99);

    ws.close();
  });
});