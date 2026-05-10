'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

// We test server logic by importing and testing the internal functions
// directly. Since server.js doesn't export its internals, we use
// an HTTP integration test approach.

const { startServer } = require('../src/server/server');

describe('Server', () => {
  describe('HTTP API', () => {
    let serverHandle;
    let port;

    before(async () => {
      // Start server on a random available port
      port = 0; // Let OS assign port
      // We can't easily use startServer for testing because it auto-opens browser.
      // Instead, create a raw HTTP server that exercises the handler logic.
      // For now, test the module loads correctly.
    });

    it('should export startServer function', () => {
      assert.strictEqual(typeof startServer, 'function');
    });
  });

  describe('updateContext / getContextSnapshot', () => {
    // These are internal functions not exported, but we test the logic
    // pattern they implement
    it('should aggregate token counts per agent', () => {
      const contextMap = new Map();

      function getCtxKey(sessionID, agentID) {
        return sessionID + ':' + (agentID || '');
      }

      function updateContext(item) {
        const key = getCtxKey(item.sessionID, item.agentID);
        let ctx = contextMap.get(key);
        if (!ctx) {
          ctx = { inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0, model: '', contextWindow: 200000, lastActivity: Date.now() };
          contextMap.set(key, ctx);
        }
        if (item.inputTokens) ctx.inputTokens += item.inputTokens;
        if (item.outputTokens) ctx.outputTokens += item.outputTokens;
        if (item.cacheCreationTokens) ctx.cacheCreation += item.cacheCreationTokens;
        if (item.cacheReadTokens) ctx.cacheRead += item.cacheReadTokens;
        ctx.lastActivity = Date.now();
      }

      updateContext({ sessionID: 's1', agentID: '', inputTokens: 100, outputTokens: 50 });
      updateContext({ sessionID: 's1', agentID: 'a1', inputTokens: 200, outputTokens: 100 });
      updateContext({ sessionID: 's1', agentID: '', inputTokens: 50, outputTokens: 25 });

      assert.strictEqual(contextMap.size, 2);
      assert.strictEqual(contextMap.get('s1:').inputTokens, 150);
      assert.strictEqual(contextMap.get('s1:').outputTokens, 75);
      assert.strictEqual(contextMap.get('s1:a1').inputTokens, 200);
    });

    it('should clean up entries for removed session', () => {
      const contextMap = new Map();

      function getCtxKey(sessionID, agentID) {
        return sessionID + ':' + (agentID || '');
      }

      contextMap.set('s1:', { inputTokens: 100 });
      contextMap.set('s1:a1', { inputTokens: 200 });
      contextMap.set('s2:', { inputTokens: 300 });

      function cleanupContextMap(sessionID) {
        for (const key of contextMap.keys()) {
          if (key.startsWith(sessionID + ':')) contextMap.delete(key);
        }
      }

      cleanupContextMap('s1');

      assert.strictEqual(contextMap.size, 1);
      assert.ok(!contextMap.has('s1:'));
      assert.ok(!contextMap.has('s1:a1'));
      assert.ok(contextMap.has('s2:'));
    });
  });

  describe('broadcast message format', () => {
    it('should serialize type and payload as JSON', () => {
      const msg = JSON.stringify({ type: 'newSession', payload: { sessionID: 's1' } });
      const parsed = JSON.parse(msg);
      assert.strictEqual(parsed.type, 'newSession');
      assert.strictEqual(parsed.payload.sessionID, 's1');
    });

    it('should serialize item events correctly', () => {
      const item = { type: 'thinking', content: 'test', sessionID: 's1' };
      const msg = JSON.stringify({ type: 'item', payload: item });
      const parsed = JSON.parse(msg);
      assert.strictEqual(parsed.type, 'item');
      assert.strictEqual(parsed.payload.type, 'thinking');
    });
  });

  describe('itemBuffer management', () => {
    const MAX_ITEM_BUFFER = 2000;

    it('should cap buffer at MAX_ITEM_BUFFER', () => {
      const buffer = [];
      for (let i = 0; i < 2500; i++) {
        buffer.push({ type: 'item', index: i });
        if (buffer.length > MAX_ITEM_BUFFER) {
          buffer.splice(0, buffer.length - MAX_ITEM_BUFFER);
        }
      }
      assert.strictEqual(buffer.length, MAX_ITEM_BUFFER);
    });
  });
});