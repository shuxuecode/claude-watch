'use strict';

// ============================================================================
// Constants
// ============================================================================

var StreamItemType = {
  THINKING: 'thinking',
  TOOL_INPUT: 'tool_input',
  TOOL_OUTPUT: 'tool_output',
  TEXT: 'text',
  USER_TEXT: 'user_text',
  TURN_MARKER: 'turn_marker',
  COMPACT_MARKER: 'compact_marker',
  HOOK_OUTPUT: 'hook_output',
  DIAGNOSTICS: 'diagnostics',
  PR_LINK: 'pr_link',
  DEBUG: 'debug',
  SESSION_TITLE: 'session_title',
};

var AgentIDDisplayLength = 7;
var debugPreviewLen = 240;

var debugAll = false;

function makeItem(overrides = {}) {
  return {
    type: '', sessionID: '', agentID: '', agentName: '', timestamp: 0,
    content: '', toolName: '', toolID: '', durationMs: 0,
    hookContent: '', hookCommand: '',
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    model: '',
    ...overrides,
  };
}

// ============================================================================
// Exports
// ============================================================================

function setDebugAll(val) {
  debugAll = val;
}

function agentDisplayName(agentID) {
  if (!agentID) return 'Main';
  var id = String(agentID);
  return 'Agent-' + id.slice(0, Math.min(AgentIDDisplayLength, id.length));
}

// ============================================================================
// ParseLine
// ============================================================================

function parseLine(line) {
  if (!line || !line.trim()) return [];

  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return []; // gracefully skip malformed lines
  }

  const timestamp = raw.timestamp ? new Date(raw.timestamp) : new Date();

  const items = [];

  switch (raw.type) {
    case 'assistant':
      items.push(...parseAssistantMessage(raw, timestamp));
      break;
    case 'user':
      items.push(...parseUserMessage(raw, timestamp));
      break;
    case 'system':
      items.push(...parseSystemMessage(raw, timestamp));
      if (debugAll && items.length === 0) {
        items.push(debugItem(raw, line, timestamp));
      }
      break;
    case 'agent-name':
      items.push(...parseSessionTitle(raw, timestamp, raw.agentName));
      break;
    case 'custom-title':
      items.push(...parseSessionTitle(raw, timestamp, raw.customTitle));
      break;
    case 'attachment':
      items.push(...parseAttachment(raw, timestamp));
      if (debugAll && items.length === 0) {
        items.push(debugItem(raw, line, timestamp));
      }
      break;
    case 'pr-link':
      items.push(...parsePRLink(raw, timestamp));
      break;
    default:
      if (debugAll) {
        items.push(debugItem(raw, line, timestamp));
      }
  }

  return items;
}

// ============================================================================
// Debug item
// ============================================================================

function debugItem(raw, line, timestamp) {
  let label = raw.type;
  if (raw.type === 'system' && raw.subtype) {
    label = `system:${raw.subtype}`;
  } else if (raw.type === 'attachment' && raw.attachment && raw.attachment.type) {
    label = `attachment.${raw.attachment.type}`;
  }
  let preview = line;
  if (preview.length > debugPreviewLen) {
    preview = preview.slice(0, debugPreviewLen) + '\u2026';
  }
  const name = agentDisplayName(raw.agentId);
  return {
    type: StreamItemType.DEBUG,
    sessionID: raw.sessionId,
    agentID: raw.agentId || '',
    agentName: name,
    timestamp,
    toolName: label,
    content: preview,
    toolID: '',
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    model: '',
  };
}

// ============================================================================
// Session Title
// ============================================================================

function parseSessionTitle(raw, timestamp, title) {
  if (!title) return [];
  return [makeItem({
    type: StreamItemType.SESSION_TITLE,
    sessionID: raw.sessionId,
    content: title,
    timestamp,
  })];
}

// ============================================================================
// System Messages
// ============================================================================

function parseSystemMessage(raw, timestamp) {
  const name = agentDisplayName(raw.agentId);
  switch (raw.subtype) {
    case 'turn_duration':
      return [makeItem({
        type: StreamItemType.TURN_MARKER,
        sessionID: raw.sessionId,
        agentID: raw.agentId || '',
        agentName: name,
        durationMs: raw.durationMs || 0,
        timestamp,
      })];
    case 'compact_boundary':
      return [makeItem({
        type: StreamItemType.COMPACT_MARKER,
        sessionID: raw.sessionId,
        agentID: raw.agentId || '',
        agentName: name,
        content: formatCompactSummary(raw.compactMetadata),
        timestamp,
      })];
    default:
      return [];
  }
}

function formatCompactSummary(metadata) {
  if (!metadata) return '';
  const parts = [];
  if (metadata.trigger) parts.push(metadata.trigger);
  if (metadata.preTokens > 0) parts.push(`${formatTokenCount(metadata.preTokens)} pre-tokens`);
  return parts.join(', ');
}

function formatTokenCount(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.floor(n / 1000)}k`;
  return String(n);
}

function contextWindowFor(model) {
  if (!model) return 200000;
  if (model.startsWith('claude-opus-4-7') || model.startsWith('claude-sonnet-4-6')) return 1000000;
  if (model.startsWith('claude-haiku-4-5') || model.startsWith('claude-opus-4-6') ||
      model.startsWith('claude-sonnet-4-5') || model.startsWith('claude-haiku-4')) return 200000;
  return 200000;
}

// ============================================================================
// Attachment Messages
// ============================================================================

function parseAttachment(raw, timestamp) {
  if (!raw.attachment) return [];
  const name = agentDisplayName(raw.agentId);
  switch (raw.attachment.type) {
    case 'hook_success': {
      const stdout = (raw.attachment.stdout || '').replace(/\n$/, '');
      const stdin = raw.attachment.content || '';
      const hookContent = stdin && stdin !== stdout ? stdin : '';
      return [makeItem({
        type: StreamItemType.HOOK_OUTPUT,
        sessionID: raw.sessionId,
        agentID: raw.agentId || '',
        agentName: name,
        toolName: raw.attachment.hookName || '',
        content: stdout,
        hookContent: hookContent,
        hookCommand: raw.attachment.command || '',
        durationMs: raw.attachment.durationMs || 0,
        timestamp,
      })];
    }
    case 'diagnostics':
      return diagnosticsItems(raw, timestamp, name);
    default:
      return [];
  }
}

function diagnosticsItems(raw, timestamp, agentName) {
  if (!raw.attachment || !raw.attachment.files) return [];
  const items = [];
  for (const f of raw.attachment.files) {
    if (!f.diagnostics || f.diagnostics.length === 0) continue;
    items.push(makeItem({
      type: StreamItemType.DIAGNOSTICS,
      sessionID: raw.sessionId,
      agentID: raw.agentId || '',
      agentName,
      toolName: diagnosticsHeader(f),
      content: diagnosticsBody(f.diagnostics),
      timestamp,
    }));
  }
  return items;
}

function diagnosticsHeader(f) {
  const counts = {};
  for (const d of f.diagnostics) {
    const sev = (d.severity || '').toLowerCase();
    counts[sev] = (counts[sev] || 0) + 1;
  }
  const parts = [];
  for (const sev of ['error', 'warning', 'info', 'hint']) {
    if (counts[sev]) {
      const label = counts[sev] === 1 ? sev : `${sev}s`;
      parts.push(`${counts[sev]} ${label}`);
    }
  }
  let name = f.uri;
  const idx = name.lastIndexOf('/');
  if (idx >= 0) name = name.slice(idx + 1);
  if (parts.length === 0) return name;
  return `${name} (${parts.join(', ')})`;
}

function diagnosticsBody(diagnostics) {
  return diagnostics.map(d => {
    const sev = d.severity || '?';
    let line = `[${sev}] ${d.message}`;
    if (d.source) line += ` (${d.source})`;
    return line;
  }).join('\n');
}

// ============================================================================
// PR Link
// ============================================================================

function parsePRLink(raw, timestamp) {
  if (raw.prNumber == null && !raw.prUrl) return [];
  let content;
  if (raw.prRepository && raw.prUrl) {
    content = `PR #${raw.prNumber} ${raw.prRepository} \u2192 ${raw.prUrl}`;
  } else if (raw.prUrl) {
    content = `PR #${raw.prNumber} \u2192 ${raw.prUrl}`;
  } else {
    content = `PR #${raw.prNumber}`;
  }
  return [makeItem({
    type: StreamItemType.PR_LINK,
    sessionID: raw.sessionId,
    content,
    timestamp,
  })];
}

// ============================================================================
// Assistant Messages
// ============================================================================

function parseAssistantMessage(raw, timestamp) {
  const msg = raw.message;
  if (!msg || !Array.isArray(msg.content)) return [];

  const items = [];
  const name = agentDisplayName(raw.agentId);

  for (const block of msg.content) {
    switch (block.type) {
      case 'thinking':
        if (block.thinking) {
          items.push(makeItem({
            type: StreamItemType.THINKING,
            agentID: raw.agentId || '',
            agentName: name,
            content: block.thinking,
            timestamp,
          }));
        }
        break;
      case 'text':
        if (block.text) {
          items.push(makeItem({
            type: StreamItemType.TEXT,
            agentID: raw.agentId || '',
            agentName: name,
            content: block.text,
            timestamp,
          }));
        }
        break;
      case 'tool_use':
        items.push(makeItem({
          type: StreamItemType.TOOL_INPUT,
          agentID: raw.agentId || '',
          agentName: name,
          content: formatToolInput(block.name, block.input),
          toolName: prettyToolName(block.name),
          toolID: block.id || '',
          timestamp,
        }));
        break;
    }
  }

  // Attach token usage + model to first item only
  if (items.length > 0 && msg.usage) {
    items[0].inputTokens = msg.usage.input_tokens || 0;
    items[0].outputTokens = msg.usage.output_tokens || 0;
    items[0].cacheCreationTokens = msg.usage.cache_creation_input_tokens || 0;
    items[0].cacheReadTokens = msg.usage.cache_read_input_tokens || 0;
  }
  if (items.length > 0 && msg.model && msg.model !== '<synthetic>') {
    items[0].model = msg.model;
  }

  return items;
}

// ============================================================================
// User Messages
// ============================================================================

function parseUserMessage(raw, timestamp) {
  const msg = raw.message;
  if (!msg) return [];

  // Parse toolUseResult for duration
  let durationMs = 0;
  if (raw.toolUseResult && typeof raw.toolUseResult.durationMs === 'number') {
    durationMs = raw.toolUseResult.durationMs;
  }

  const items = [];
  const name = agentDisplayName(raw.agentId);

  // String content — user prompt
  if (typeof msg.content === 'string' && msg.content) {
    const text = stripNonUserContent(msg.content);
    if (text) {
      items.push(makeItem({
        type: StreamItemType.USER_TEXT,
        agentID: raw.agentId || '',
        agentName: name,
        content: text,
        timestamp,
      }));
    }
  }

  // Array content — mixed text blocks and tool_result blocks
  if (Array.isArray(msg.content)) {
    const textParts = [];
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        const text = stripNonUserContent(block.text);
        if (text) textParts.push(text);
      }
    }
    if (textParts.length > 0) {
      items.push(makeItem({
        type: StreamItemType.USER_TEXT,
        agentID: raw.agentId || '',
        agentName: name,
        content: textParts.join('\n'),
        timestamp,
      }));
    }

    for (const result of msg.content) {
      if (result.type === 'tool_result') {
        items.push(makeItem({
          type: StreamItemType.TOOL_OUTPUT,
          agentID: raw.agentId || '',
          agentName: name,
          content: extractToolResultContent(result.content),
          toolID: result.tool_use_id || '',
          durationMs,
          timestamp,
        }));
      }
    }
  }

  return items;
}

function extractToolResultContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter(b => b.text)
      .map(b => b.text);
    return parts.join('\n');
  }
  // Fallback: stringify
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function stripNonUserContent(text) {
  if (!text) return '';
  return text.replace(/<(?:local-command-caveat|command-name|command-message|command-args|local-command-stdout)>[\s\S]*?<\/(?:local-command-caveat|command-name|command-message|command-args|local-command-stdout)>/g, '').trim();
}

// ============================================================================
// Tool Input Formatting
// ============================================================================

var MAX_TOOL_INPUT_LENGTH = 5000;

function truncate(s) {
  if (!s || s.length <= MAX_TOOL_INPUT_LENGTH) return s;
  return s.slice(0, MAX_TOOL_INPUT_LENGTH) + '...truncated';
}

function formatToolInput(toolName, input) {
  if (!input) return '';
  const inp = input;

  switch (toolName) {
    case 'Bash':
      if (inp.description) return truncate(`${inp.command || ''}\n  # ${inp.description}`);
      return truncate(inp.command || '');
    case 'Read':
      return inp.file_path || '';
    case 'Write':
      return `${inp.file_path || ''} (${(inp.content || '').length} bytes)`;
    case 'Edit':
      return inp.file_path || '';
    case 'Glob':
      if (inp.path) return `${inp.pattern} in ${inp.path}`;
      return inp.pattern || '';
    case 'Grep':
      if (inp.path) return `/${inp.pattern || ''}/ in ${inp.path}`;
      return `/${inp.pattern || ''}/`;
    case 'WebFetch':
      return inp.prompt || '';
    case 'WebSearch':
      return inp.query || '';
    case 'Task':
    case 'Agent':
      if (inp.description) return truncate(inp.description);
      return truncate(inp.prompt || '');
    case 'Skill':
      if (inp.args) return truncate(`${inp.skill} \u2014 ${inp.args}`);
      return inp.skill || '';
    case 'ToolSearch':
      return inp.query || '';
    case 'ScheduleWakeup':
      if (inp.reason) return inp.reason;
      if (inp.delaySeconds > 0) return `delay ${inp.delaySeconds}s`;
      return truncate(JSON.stringify(input));
    case 'TaskCreate':
      return inp.subject || '';
    case 'TaskUpdate':
      if (inp.taskId) return `task ${inp.taskId}`;
      return truncate(JSON.stringify(input));
    case 'TaskStop':
      return inp.task_id || '';
    case 'EnterPlanMode':
      return '(enter plan mode)';
    case 'ExitPlanMode':
      return '(exit plan mode)';
    case 'CronCreate':
      if (inp.cron && inp.prompt) return `${inp.cron}: ${inp.prompt}`;
      return truncate(JSON.stringify(input));
    default:
      return truncate(JSON.stringify(input));
  }
}

function prettyToolName(name) {
  if (!name.startsWith('mcp__')) return name;
  const idx = name.lastIndexOf('__');
  if (idx <= 'mcp__'.length - 2 || idx === name.length - 2) return name;
  return 'mcp:' + name.slice(idx + 2);
}

module.exports = {
  StreamItemType,
  parseLine,
  setDebugAll,
  contextWindowFor,
  formatTokenCount,
  AgentIDDisplayLength,
  formatToolInput,
  prettyToolName,
  agentDisplayName,
  stripNonUserContent,
  MAX_TOOL_INPUT_LENGTH,
};
