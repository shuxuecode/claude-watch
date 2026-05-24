'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseLine, StreamItemType, contextWindowFor, setDebugAll, formatToolInput, prettyToolName, agentDisplayName, formatTokenCount, stripNonUserContent, MAX_TOOL_INPUT_LENGTH } = require('../src/parser/parser');

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

  it('should parse user text (prompt) as USER_TEXT', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2025-01-01T12:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '请帮我修复这个bug' }],
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, StreamItemType.USER_TEXT);
    assert.strictEqual(items[0].content, '请帮我修复这个bug');
  });

  it('should parse string content user message as USER_TEXT', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2025-01-01T12:00:00Z',
      message: {
        role: 'user',
        content: '扫描这个项目，左侧树展示的数据是什么数据',
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, StreamItemType.USER_TEXT);
    assert.strictEqual(items[0].content, '扫描这个项目，左侧树展示的数据是什么数据');
  });

  it('should strip non-user tags from string content', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2025-01-01T12:00:00Z',
      message: {
        role: 'user',
        content: '<local-command-stdout>Set model to glm-5.1</local-command-stdout>',
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items.length, 0);
  });

  it('should keep user prompt after stripping tags', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2025-01-01T12:00:00Z',
      message: {
        role: 'user',
        content: '<local-command-caveat>...</local-command-caveat>扫描这个项目',
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].content, '扫描这个项目');
  });

  it('should parse mixed user message with text and tool_result', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2025-01-01T12:00:00Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '继续执行' },
          { type: 'tool_result', tool_use_id: 'toolu_xyz', content: 'done' },
        ],
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].type, StreamItemType.USER_TEXT);
    assert.strictEqual(items[0].content, '继续执行');
    assert.strictEqual(items[1].type, StreamItemType.TOOL_OUTPUT);
    assert.strictEqual(items[1].toolID, 'toolu_xyz');
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

// ============================================================================
// Parser - custom-title
// ============================================================================

describe('Parser - custom-title', () => {
  it('should parse custom-title message', () => {
    const line = JSON.stringify({ type: 'custom-title', customTitle: 'my-custom-session', sessionId: 's1' });
    const items = parseLine(line);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, StreamItemType.SESSION_TITLE);
    assert.strictEqual(items[0].content, 'my-custom-session');
  });

  it('should skip custom-title with empty title', () => {
    const line = JSON.stringify({ type: 'custom-title', customTitle: '', sessionId: 's1' });
    const items = parseLine(line);
    assert.strictEqual(items.length, 0);
  });
});

// ============================================================================
// Parser - compact_boundary
// ============================================================================

describe('Parser - compact_boundary', () => {
  it('should parse compact_boundary with metadata', () => {
    const line = JSON.stringify({
      type: 'system', subtype: 'compact_boundary',
      timestamp: '2025-01-01T12:00:00Z', sessionId: 's1',
      compactMetadata: { trigger: 'auto', preTokens: 150000 },
    });
    const items = parseLine(line);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, StreamItemType.COMPACT_MARKER);
    assert.strictEqual(items[0].content, 'auto, 150k pre-tokens');
  });

  it('should parse compact_boundary without metadata', () => {
    const line = JSON.stringify({
      type: 'system', subtype: 'compact_boundary',
      timestamp: '2025-01-01T12:00:00Z', sessionId: 's1',
    });
    const items = parseLine(line);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, StreamItemType.COMPACT_MARKER);
    assert.strictEqual(items[0].content, '');
  });
});

// ============================================================================
// Parser - hook_success
// ============================================================================

describe('Parser - hook_success', () => {
  it('should parse hook_success attachment with all fields', () => {
    const line = JSON.stringify({
      type: 'attachment', sessionId: 's1', agentId: '',
      timestamp: '2025-01-01T12:00:00Z',
      attachment: {
        type: 'hook_success',
        hookName: 'PreToolUse:Bash',
        stdout: 'hook output here',
        content: 'stdin content here',
        command: 'node perm-bridge.js',
        durationMs: 120,
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, StreamItemType.HOOK_OUTPUT);
    assert.strictEqual(items[0].toolName, 'PreToolUse:Bash');
    assert.strictEqual(items[0].content, 'hook output here');
    assert.strictEqual(items[0].hookContent, 'stdin content here');
    assert.strictEqual(items[0].hookCommand, 'node perm-bridge.js');
    assert.strictEqual(items[0].durationMs, 120);
  });

  it('should strip trailing newline from stdout', () => {
    const line = JSON.stringify({
      type: 'attachment', sessionId: 's1', agentId: '',
      timestamp: '2025-01-01T12:00:00Z',
      attachment: {
        type: 'hook_success',
        hookName: 'PreToolUse:Bash',
        stdout: '{"continue":true}\n',
        content: '',
        command: 'node perm-bridge.js',
        durationMs: 100,
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items[0].content, '{"continue":true}');
  });

  it('should deduplicate content and stdout when identical', () => {
    const line = JSON.stringify({
      type: 'attachment', sessionId: 's1', agentId: '',
      timestamp: '2025-01-01T12:00:00Z',
      attachment: {
        type: 'hook_success',
        hookName: 'PostToolUse:Bash',
        stdout: 'error detected\n',
        content: 'error detected',
        command: 'error-detector.sh',
        durationMs: 500,
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items[0].content, 'error detected');
    assert.strictEqual(items[0].hookContent, '');
  });

  it('should keep content separate when different from stdout', () => {
    const line = JSON.stringify({
      type: 'attachment', sessionId: 's1', agentId: '',
      timestamp: '2025-01-01T12:00:00Z',
      attachment: {
        type: 'hook_success',
        hookName: 'UserPromptSubmit',
        stdout: 'review complete',
        content: 'user prompt input',
        command: 'activator.sh',
        durationMs: 749,
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items[0].content, 'review complete');
    assert.strictEqual(items[0].hookContent, 'user prompt input');
  });

  it('should handle empty content and command', () => {
    const line = JSON.stringify({
      type: 'attachment', sessionId: 's1', agentId: '',
      timestamp: '2025-01-01T12:00:00Z',
      attachment: {
        type: 'hook_success',
        hookName: 'pre-commit',
        stdout: 'hook output here',
        durationMs: 120,
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items[0].hookContent, '');
    assert.strictEqual(items[0].hookCommand, '');
  });

  it('should skip non-hook_success attachment', () => {
    const line = JSON.stringify({
      type: 'attachment', sessionId: 's1',
      attachment: { type: 'unknown_type', stdout: 'data' },
    });
    const items = parseLine(line);
    assert.strictEqual(items.length, 0);
  });
});

// ============================================================================
// Parser - diagnostics
// ============================================================================

describe('Parser - diagnostics', () => {
  it('should parse diagnostics attachment', () => {
    const line = JSON.stringify({
      type: 'attachment', sessionId: 's1', agentId: '',
      timestamp: '2025-01-01T12:00:00Z',
      attachment: {
        type: 'diagnostics',
        files: [{
          uri: 'file:///src/app.ts',
          diagnostics: [
            { severity: 'error', message: 'Type mismatch', source: 'tsc' },
            { severity: 'warning', message: 'Unused var', source: 'tsc' },
          ],
        }],
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, StreamItemType.DIAGNOSTICS);
    assert.ok(items[0].toolName.includes('app.ts'));
    assert.ok(items[0].content.includes('[error] Type mismatch'));
  });

  it('should skip diagnostics with empty array', () => {
    const line = JSON.stringify({
      type: 'attachment', sessionId: 's1',
      attachment: {
        type: 'diagnostics',
        files: [{ uri: 'file:///src/app.ts', diagnostics: [] }],
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items.length, 0);
  });
});

// ============================================================================
// Parser - pr_link
// ============================================================================

describe('Parser - pr_link', () => {
  it('should parse pr_link with full info', () => {
    const line = JSON.stringify({
      type: 'pr-link', sessionId: 's1',
      prNumber: 42, prRepository: 'org/repo', prUrl: 'https://github.com/org/repo/pull/42',
    });
    const items = parseLine(line);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].type, StreamItemType.PR_LINK);
    assert.ok(items[0].content.includes('PR #42'));
    assert.ok(items[0].content.includes('org/repo'));
  });

  it('should parse pr_link with only prUrl', () => {
    const line = JSON.stringify({
      type: 'pr-link', sessionId: 's1',
      prNumber: 10, prUrl: 'https://github.com/org/repo/pull/10',
    });
    const items = parseLine(line);
    assert.strictEqual(items.length, 1);
    assert.ok(items[0].content.includes('PR #10'));
  });

  it('should parse pr_link with only prNumber', () => {
    const line = JSON.stringify({
      type: 'pr-link', sessionId: 's1',
      prNumber: 99,
    });
    const items = parseLine(line);
    assert.strictEqual(items.length, 1);
    assert.ok(items[0].content.includes('PR #99'));
  });

  it('should skip pr_link without prNumber and prUrl', () => {
    const line = JSON.stringify({ type: 'pr-link', sessionId: 's1' });
    const items = parseLine(line);
    assert.strictEqual(items.length, 0);
  });
});

// ============================================================================
// Parser - model extraction
// ============================================================================

describe('Parser - model extraction', () => {
  it('should attach model to first item only', () => {
    const line = JSON.stringify({
      type: 'assistant', timestamp: '2025-01-01T12:00:00Z',
      message: {
        role: 'assistant', content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
        model: 'claude-opus-4-7',
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items[0].model, 'claude-opus-4-7');
    assert.strictEqual(items[1].model, '');
  });

  it('should skip synthetic model', () => {
    const line = JSON.stringify({
      type: 'assistant', timestamp: '2025-01-01T12:00:00Z',
      message: {
        role: 'assistant', content: [{ type: 'text', text: 'hi' }],
        model: '<synthetic>',
      },
    });
    const items = parseLine(line);
    assert.strictEqual(items[0].model, '');
  });
});

// ============================================================================
// formatToolInput
// ============================================================================

describe('formatToolInput', () => {
  it('should format Bash with description', () => {
    const result = formatToolInput('Bash', { command: 'ls -la', description: 'list files' });
    assert.ok(result.includes('ls -la'));
    assert.ok(result.includes('list files'));
  });

  it('should format Bash without description', () => {
    assert.strictEqual(formatToolInput('Bash', { command: 'npm test' }), 'npm test');
  });

  it('should format Read', () => {
    assert.strictEqual(formatToolInput('Read', { file_path: '/src/app.js' }), '/src/app.js');
  });

  it('should format Write', () => {
    const result = formatToolInput('Write', { file_path: '/src/app.js', content: 'hello world' });
    assert.ok(result.includes('/src/app.js'));
    assert.ok(result.includes('bytes'));
  });

  it('should format Edit', () => {
    assert.strictEqual(formatToolInput('Edit', { file_path: '/src/app.js' }), '/src/app.js');
  });

  it('should format Glob with path', () => {
    assert.strictEqual(formatToolInput('Glob', { pattern: '**/*.js', path: '/src' }), '**/*.js in /src');
  });

  it('should format Glob without path', () => {
    assert.strictEqual(formatToolInput('Glob', { pattern: '**/*.js' }), '**/*.js');
  });

  it('should format Grep with path', () => {
    assert.strictEqual(formatToolInput('Grep', { pattern: 'TODO', path: '/src' }), '/TODO/ in /src');
  });

  it('should format Grep without path', () => {
    assert.strictEqual(formatToolInput('Grep', { pattern: 'TODO' }), '/TODO/');
  });

  it('should format Grep with undefined pattern', () => {
    assert.strictEqual(formatToolInput('Grep', { pattern: undefined }), '//');
  });

  it('should format WebFetch', () => {
    assert.strictEqual(formatToolInput('WebFetch', { prompt: 'fetch this page' }), 'fetch this page');
  });

  it('should format WebSearch', () => {
    assert.strictEqual(formatToolInput('WebSearch', { query: 'node.js tutorial' }), 'node.js tutorial');
  });

  it('should format Task/Agent with description', () => {
    assert.strictEqual(formatToolInput('Task', { description: 'run tests' }), 'run tests');
  });

  it('should format Task/Agent with prompt fallback', () => {
    assert.strictEqual(formatToolInput('Agent', { prompt: 'long prompt' }), 'long prompt');
  });

  it('should format Skill with args', () => {
    const result = formatToolInput('Skill', { skill: 'review', args: 'PR #42' });
    assert.ok(result.includes('review'));
    assert.ok(result.includes('PR #42'));
  });

  it('should format Skill without args', () => {
    assert.strictEqual(formatToolInput('Skill', { skill: 'review' }), 'review');
  });

  it('should format ToolSearch', () => {
    assert.strictEqual(formatToolInput('ToolSearch', { query: 'read file' }), 'read file');
  });

  it('should format ScheduleWakeup with reason', () => {
    assert.strictEqual(formatToolInput('ScheduleWakeup', { reason: 'check deploy' }), 'check deploy');
  });

  it('should format ScheduleWakeup with delaySeconds', () => {
    assert.strictEqual(formatToolInput('ScheduleWakeup', { delaySeconds: 300 }), 'delay 300s');
  });

  it('should format TaskCreate', () => {
    assert.strictEqual(formatToolInput('TaskCreate', { subject: 'fix bug' }), 'fix bug');
  });

  it('should format TaskUpdate with taskId', () => {
    assert.strictEqual(formatToolInput('TaskUpdate', { taskId: 't1' }), 'task t1');
  });

  it('should format TaskStop', () => {
    assert.strictEqual(formatToolInput('TaskStop', { task_id: 't1' }), 't1');
  });

  it('should format EnterPlanMode', () => {
    assert.strictEqual(formatToolInput('EnterPlanMode', {}), '(enter plan mode)');
  });

  it('should format ExitPlanMode', () => {
    assert.strictEqual(formatToolInput('ExitPlanMode', {}), '(exit plan mode)');
  });

  it('should format CronCreate with cron and prompt', () => {
    const result = formatToolInput('CronCreate', { cron: '*/5 * * * *', prompt: 'check status' });
    assert.ok(result.includes('*/5 * * * *'));
    assert.ok(result.includes('check status'));
  });

  it('should truncate long inputs', () => {
    const longCmd = 'a'.repeat(6000);
    const result = formatToolInput('Bash', { command: longCmd });
    assert.ok(result.endsWith('...truncated'));
    assert.ok(result.length < longCmd.length);
  });

  it('should format unknown tools as JSON', () => {
    const result = formatToolInput('CustomTool', { key: 'value' });
    assert.ok(result.includes('"key"'));
  });

  it('should return empty string for null input', () => {
    assert.strictEqual(formatToolInput('Bash', null), '');
  });
});

// ============================================================================
// MAX_TOOL_INPUT_LENGTH
// ============================================================================

describe('MAX_TOOL_INPUT_LENGTH', () => {
  it('should be 5000', () => {
    assert.strictEqual(MAX_TOOL_INPUT_LENGTH, 5000);
  });
});

// ============================================================================
// formatTokenCount
// ============================================================================

describe('formatTokenCount', () => {
  it('should format zero', () => {
    assert.strictEqual(formatTokenCount(0), '0');
  });

  it('should format small numbers', () => {
    assert.strictEqual(formatTokenCount(999), '999');
  });

  it('should format thousands', () => {
    assert.strictEqual(formatTokenCount(1000), '1k');
    assert.strictEqual(formatTokenCount(15000), '15k');
  });

  it('should format millions', () => {
    assert.strictEqual(formatTokenCount(1000000), '1.0M');
    assert.strictEqual(formatTokenCount(2500000), '2.5M');
  });
});

// ============================================================================
// prettyToolName
// ============================================================================

describe('prettyToolName', () => {
  it('should return non-MCP names unchanged', () => {
    assert.strictEqual(prettyToolName('Bash'), 'Bash');
    assert.strictEqual(prettyToolName('Read'), 'Read');
  });

  it('should simplify MCP tool names', () => {
    assert.strictEqual(prettyToolName('mcp__myserver__mytool'), 'mcp:mytool');
  });

  it('should handle MCP names with long server prefix', () => {
    assert.strictEqual(prettyToolName('mcp__github_api__create_pr'), 'mcp:create_pr');
  });

  it('should return original name for MCP prefix without tool name', () => {
    assert.strictEqual(prettyToolName('mcp__'), 'mcp__');
    assert.strictEqual(prettyToolName('mcp__x'), 'mcp__x');
  });
});

// ============================================================================
// agentDisplayName
// ============================================================================

describe('agentDisplayName', () => {
  it('should return Main for empty agentID', () => {
    assert.strictEqual(agentDisplayName(''), 'Main');
  });

  it('should return Main for undefined agentID', () => {
    assert.strictEqual(agentDisplayName(undefined), 'Main');
  });

  it('should return Main for null agentID', () => {
    assert.strictEqual(agentDisplayName(null), 'Main');
  });

  it('should truncate long agent IDs', () => {
    assert.strictEqual(agentDisplayName('abc1234567890'), 'Agent-abc1234');
  });

  it('should handle short agent IDs', () => {
    assert.strictEqual(agentDisplayName('abc'), 'Agent-abc');
  });
});

describe('stripNonUserContent', () => {
  it('should strip local-command-caveat', () => {
    assert.strictEqual(stripNonUserContent('<local-command-caveat>ignore this</local-command-caveat>real prompt'), 'real prompt');
  });

  it('should strip command-name and command-stdout', () => {
    assert.strictEqual(stripNonUserContent('<command-name>/model</command-name><local-command-stdout>Set model</local-command-stdout>'), '');
  });

  it('should return empty for pure non-user content', () => {
    assert.strictEqual(stripNonUserContent('<local-command-stdout>output</local-command-stdout>'), '');
  });

  it('should return original text when no tags present', () => {
    assert.strictEqual(stripNonUserContent('扫描这个项目'), '扫描这个项目');
  });

  it('should return empty for null/undefined', () => {
    assert.strictEqual(stripNonUserContent(null), '');
    assert.strictEqual(stripNonUserContent(undefined), '');
  });
});
