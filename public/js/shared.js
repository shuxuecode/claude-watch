// ══════════════════════════════════════════════════════════════════════════════
// shared.js — Common utilities and shared state
// ══════════════════════════════════════════════════════════════════════════════

// ── LRU Cache ──
class LRUCache {
  constructor(max) { this.max = max; this.map = new Map(); }
  has(key) { if (!this.map.has(key)) return false; const v = this.map.get(key); this.map.delete(key); this.map.set(key, v); return true; }
  get(key) { if (!this.map.has(key)) return undefined; const v = this.map.get(key); this.map.delete(key); this.map.set(key, v); return v; }
  set(key, val) { if (this.map.has(key)) this.map.delete(key); this.map.set(key, val); if (this.map.size > this.max) { const oldest = this.map.keys().next().value; this.map.delete(oldest); } }
  delete(key) { return this.map.delete(key); }
  keys() { return this.map.keys(); }
}

// ── Shared State ──
const sessions = [];
const sessionsMap = new Map();
const treeNodes = [];
let treeCursor = 0;
const folderCollapsed = {};
const streamItems = [];
let visibleItems = [];
let visibleDirty = true;
const filters = new Map();
let visibleFilterCount = 0;
let contextData = {};
let autoDiscovery = true;
let renderPending = false;

// LRU cache instances
const MAX_DESC_STORE = 200;
const seenToolIDs = new LRUCache(20000);
const toolNameMap = new LRUCache(2000);
const agentActivity = new LRUCache(500);
const taskDescriptions = new LRUCache(2000);

// Hidden sessions
const HIDDEN_KEY = 'claude-watch-hidden';
const hiddenSessionIDs = new Set();

function loadHiddenSessions() {
  try {
    const data = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '{}');
    const now = Date.now();
    for (const [id, ts] of Object.entries(data)) {
      if (now - ts < 24 * 60 * 60 * 1000) hiddenSessionIDs.add(id);
    }
    _saveHiddenSessions();
  } catch {}
}

function _saveHiddenSessions() {
  const data = {};
  for (const id of hiddenSessionIDs) data[id] = Date.now();
  localStorage.setItem(HIDDEN_KEY, JSON.stringify(data));
}

loadHiddenSessions();

// ── Model Colors ──
const MODEL_COLORS = {
  'claude-opus-4-7': '#e74c3c', 'claude-opus-4-6': '#c0392b', 'claude-opus-4-8': '#e67e22',
  'claude-sonnet-4-6': '#3498db', 'claude-sonnet-4-5': '#2980b9',
  'claude-haiku-4-5': '#5dade2', 'claude-haiku-4': '#1abc9c',
  'glm-5.1': '#2980b9', 'glm-5': '#3498db', 'glm-4.7': '#5dade2',
  'qwen3.7-max': '#55efc4', 'qwen3.6-plus': '#2ecc71', 'qwen3.5-plus': '#27ae60',
  'qwen3-max': '#1abc9c',
  'deepseek-v4-pro': '#9b59b6',
  'kimi-k2.5': '#f39c12', 'kimi-k2.6': '#d35400', 'kimi-k2-thinking': '#d4a017',
  'MiniMax-M2.5': '#1abc9c',
};
let _modelColorIdx = 0;

function modelColor(name) {
  if (MODEL_COLORS[name]) return MODEL_COLORS[name];
  const fallback = ['#e74c3c','#3498db','#2ecc71','#9b59b6','#f39c12','#1abc9c','#e67e22','#c0392b','#5dade2','#d35400','#55efc4','#d4a017'];
  return fallback[_modelColorIdx++ % fallback.length];
}

// ── Utility Functions ──

const _escMap = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;','\\':'&#x5C;'};
function esc(s) {
  return (s ?? '').replace(/[&<>"'\\]/g, c => _escMap[c]);
}

function fmtTok(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(2) + 'k';
  return (n / 1000000).toFixed(2) + 'm';
}

function fmtTS(n) {
  if (!n) return '0';
  return n.toLocaleString();
}

function fmtDur(ms) {
  if (!ms || ms <= 0) return '';
  if (ms < 1000) return `(${ms}ms)`;
  if (ms < 60000) return `(${(ms / 1000).toFixed(1)}s)`;
  return `(${(ms / 60000).toFixed(1)}m)`;
}

function fmtTimestamp(ts) {
  if (!ts) return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return '';
  const pad = (n, len) => String(n).padStart(len, '0');
  const ms = pad(d.getMilliseconds(), 3);
  return `${pad(d.getFullYear(),4)}-${pad(d.getMonth()+1,2)}-${pad(d.getDate(),2)} ${pad(d.getHours(),2)}:${pad(d.getMinutes(),2)}:${pad(d.getSeconds(),2)}.${ms}`;
}

function formatTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDateISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function folderName(projectPath) {
  if (!projectPath) return '';
  const parts = projectPath.split('/');
  return parts[parts.length - 1] || projectPath;
}

function sessionDisplayName(s) {
  const rawPath = s.realCwd || s.projectPath || '';
  const folder = folderName(rawPath);
  const base = s.title || folder || s.id.slice(0, 14);
  if (s.isObserver) return '[Observer] ' + base;
  return base;
}

function idColor(rank) {
  const hue = (rank * 137.508) % 360;
  return `hsl(${hue}, 75%, 60%)`;
}

function itemTime(item) {
  if (item && item.timestamp) {
    const ts = item.timestamp instanceof Date ? item.timestamp : new Date(item.timestamp);
    if (!isNaN(ts.getTime())) return ts.getTime();
  }
  return Date.now();
}

function agentDisplayName(id, type) {
  if (type) {
    const idx = type.lastIndexOf(':');
    if (idx >= 0 && idx < type.length - 1) return type.slice(idx + 1);
    return type;
  }
  if (!id) return 'Main';
  return 'Agent-' + id.slice(0, 7);
}

const agentIdDisplayLen = new Map();
function computeAgentIdDisplayLengths() {
  agentIdDisplayLen.clear();
  for (const s of sessions) {
    const agentIds = s.agents.filter(a => a.id).map(a => a.id);
    if (agentIds.length === 0) continue;
    let minLen = 7;
    while (minLen < 21) {
      const prefixes = agentIds.map(id => id.slice(0, minLen));
      const unique = new Set(prefixes);
      if (unique.size === agentIds.length) break;
      minLen++;
    }
    for (const id of agentIds) {
      agentIdDisplayLen.set(s.id + ':' + id, minLen);
    }
  }
}

// ── Token Computation ──

let totalInput = 0, totalOutput = 0, totalCacheCreate = 0, totalCacheRead = 0;

function computeTokensFromContext() {
  totalInput = 0; totalOutput = 0; totalCacheCreate = 0; totalCacheRead = 0;
  for (const ctx of Object.values(contextData)) {
    totalInput += ctx.inputTokens || 0;
    totalOutput += ctx.outputTokens || 0;
    totalCacheCreate += ctx.cacheCreation || 0;
    totalCacheRead += ctx.cacheRead || 0;
  }
}

// ── Weekly/Monthly Aggregation ──

function getWeekKey(d) {
  const dayNum = d.getDay() || 7;
  const thursday = new Date(d);
  thursday.setDate(d.getDate() + 4 - dayNum);
  const year = thursday.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const wk = Math.ceil(((thursday - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return year + '-W' + String(wk).padStart(2, '0');
}

function aggregateWeekly(dailyKeys, daily) {
  const result = {};
  for (const k of dailyKeys) {
    const d = new Date(k);
    const wk = getWeekKey(d);
    if (!result[wk]) result[wk] = { messages: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, models: {}, dateRange: k };
    else result[wk].dateRange = result[wk].dateRange.split(' ~ ')[0] + ' ~ ' + k;
    const day = daily[k];
    result[wk].messages += day.messages;
    result[wk].input += day.input;
    result[wk].output += day.output;
    result[wk].cacheCreation += day.cacheCreation;
    result[wk].cacheRead += day.cacheRead;
    for (const [mn, m] of Object.entries(day.models)) {
      if (!result[wk].models[mn]) result[wk].models[mn] = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
      result[wk].models[mn].input += m.input;
      result[wk].models[mn].output += m.output;
      result[wk].models[mn].cacheCreation += m.cacheCreation;
      result[wk].models[mn].cacheRead += m.cacheRead;
    }
  }
  return result;
}

function aggregateMonthly(dailyKeys, daily) {
  const result = {};
  for (const k of dailyKeys) {
    const mk = k.slice(0, 7);
    if (!result[mk]) result[mk] = { messages: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, models: {}, dateRange: k };
    else result[mk].dateRange += ' ~ ' + k.slice(5);
    const day = daily[k];
    result[mk].messages += day.messages;
    result[mk].input += day.input;
    result[mk].output += day.output;
    result[mk].cacheCreation += day.cacheCreation;
    result[mk].cacheRead += day.cacheRead;
    for (const [mn, m] of Object.entries(day.models)) {
      if (!result[mk].models[mn]) result[mk].models[mn] = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
      result[mk].models[mn].input += m.input;
      result[mk].models[mn].output += m.output;
      result[mk].models[mn].cacheCreation += m.cacheCreation;
      result[mk].models[mn].cacheRead += m.cacheRead;
    }
  }
  return result;
}
