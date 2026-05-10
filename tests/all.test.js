'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseLine, StreamItemType, contextWindowFor, setDebugAll } = require('../src/parser/parser');

// ============================================================================
// Parser tests
// ============================================================================

describe('Parser', () => {
  it('should parse thinking content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2025-01-01T12:00:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'test thought' }],
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, StreamItemType.THINKING);
    assert.strictEqual(items[0].content, 'test thought');
    assert.strictEqual(items[0].agentName, 'Main');
  });

  it('should parse tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2025-01-01T12:00:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }],
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, StreamItemType.TOOL_INPUT);
    assert.strictEqual(items[0].toolID, 'toolu_1');
    assert.strictEqual(items[0].toolName, 'Bash');
  });

  it('should parse tool_result', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2025-01-01T12:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'result' }],
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, StreamItemType.TOOL_OUTPUT);
    assert.strictEqual(items[0].toolID, 'toolu_abc');
  });

  it('should parse text response', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2025-01-01T12:00:00Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    });
    const items = parseLine(line);
    assert.strictEqual(items[0].type, StreamItemType.TEXT);
  });

  it('should parse session title', () => {
    const line = JSON.stringify({ type: 'agent-name', agentName: 'my-session', sessionId: 's1' });
    const items = parseLine(line);
    assert.strictEqual(items[0].type, StreamItemType.SESSION_TITLE);
    assert.strictEqual(items[0].content, 'my-session');
  });

  it('should parse turn_duration', () => {
    const line = JSON.stringify({
      type: 'system', subtype: 'turn_duration',
      timestamp: '2025-01-01T12:00:00Z', durationMs: 5000, sessionId: 's1',
    });
    const items = parseLine(line);
    assert.strictEqual(items[0].type, StreamItemType.TURN_MARKER);
    assert.strictEqual(items[0].durationMs, 5000);
  });

  it('should handle empty lines', () => {
    assert.deepStrictEqual(parseLine(''), []);
    assert.deepStrictEqual(parseLine('  '), []);
  });

  it('should skip invalid JSON', () => {
    assert.deepStrictEqual(parseLine('not json'), []);
  });

  it('should handle subagent messages', () => {
    const line = JSON.stringify({
      type: 'assistant', agentId: 'abc1234567890',
      timestamp: '2025-01-01T12:00:00Z',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] },
    });
    const items = parseLine(line);
    assert.strictEqual(items[0].agentID, 'abc1234567890');
    assert.strictEqual(items[0].agentName, 'Agent-abc1234');
  });

  it('should report context window sizes', () => {
    assert.strictEqual(contextWindowFor('claude-opus-4-7'), 1000000);
    assert.strictEqual(contextWindowFor('claude-sonnet-4-6'), 1000000);
    assert.strictEqual(contextWindowFor('claude-haiku-4-5'), 200000);
    assert.strictEqual(contextWindowFor('unknown-model'), 200000);
  });

  it('should extract token usage', () => {
    const line = JSON.stringify({
      type: 'assistant', timestamp: '2025-01-01T12:00:00Z',
      message: {
        role: 'assistant', content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 1000, cache_read_input_tokens: 200 },
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items[0].inputTokens, 100);
    assert.strictEqual(items[0].outputTokens, 50);
    assert.strictEqual(items[0].cacheCreationTokens, 1000);
    assert.strictEqual(items[0].cacheReadTokens, 200);
  });

  it('should support debugAll mode', () => {
    setDebugAll(true);
    const line = JSON.stringify({ type: 'unknown-type', sessionId: 's', timestamp: '2025-01-01T12:00:00Z' });
    const items = parseLine(line);
    assert.strictEqual(items[0].type, StreamItemType.DEBUG);
    setDebugAll(false);
  });

  it('should handle MCP tool results', () => {
    const line = JSON.stringify({
      type: 'user', timestamp: '2025-01-01T12:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_mcp', content: [{ type: 'text', text: 'mcp result' }] }],
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items[0].content, 'mcp result');
  });
});
