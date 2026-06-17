// ══════════════════════════════════════════════════════════════════════════════
// stream.js — Stream & Tree panel page
// ══════════════════════════════════════════════════════════════════════════════

// ── DOM refs ──
const streamEl = document.getElementById('stream-panel');
const treeEl = document.getElementById('tree-content');
const treeCursorInfo = document.getElementById('tree-cursor-info');

// ── Stream State ──
let showThinking = true;
let showToolInput = true;
let showToolOutput = true;
let showText = true;
let showHook = true;
let showUserPrompt = true;
let showActivity = true;
let showTokenCount = true;
let autoScroll = true;

// ── Render State ──
let treeDirty = true;
let treeNeedsRebuild = false;
let needsFullRender = true;
let renderedItemCount = 0;
let lastTreeCursor = -1;

const MAX_ITEMS = 9999;
const MAX_LINES = 50;

// ── Tree State ──
let collapseAfter = 0;
let collapseTimer = null;
let activeRefreshTimer = null;
const ACTIVE_THRESHOLD = 600000;

// ══════════════════════════════════════════════════════════════════════════════
// Markdown renderer (marked + highlight.js)
// ══════════════════════════════════════════════════════════════════════════════

const mdRenderer = new marked.Renderer();
mdRenderer.code = function (codeOrObj, langOrEsc) {
  const text = typeof codeOrObj === 'object' ? codeOrObj.text : codeOrObj;
  const lang = typeof codeOrObj === 'object' ? codeOrObj.lang : langOrEsc;
  let highlighted;
  if (lang && hljs.getLanguage(lang)) {
    try {
      highlighted = hljs.highlight(text, { language: lang }).value;
    } catch {
      highlighted = hljs.highlightAuto(text).value;
    }
  } else {
    highlighted = hljs.highlightAuto(text).value;
  }
  const langTag = lang ? `<span class="lang-tag">${esc(lang)}</span>` : '';
  return `<div class="code-block-wrapper">
    <div class="code-block-header">${langTag}<span class="copy-btn" onclick="copyCode(this)">&#x2398;</span></div>
    <pre><code>${highlighted}</code></pre>
  </div>`;
};
marked.setOptions({ renderer: mdRenderer, breaks: true, gfm: true });

function copyCode(btn) {
  const wrapper = btn.closest('.code-block-wrapper');
  const code = wrapper ? wrapper.querySelector('code') : null;
  if (!code) return;
  navigator.clipboard.writeText(code.textContent).then(() => {
    btn.innerHTML = '&#x2713;';
    setTimeout(() => { btn.innerHTML = '&#x2398;'; }, 1500);
  });
}

function mdRender(text) {
  try {
    return DOMPurify.sanitize(marked.parse(text));
  } catch {
    return esc(text);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Snapshot / Session management
// ══════════════════════════════════════════════════════════════════════════════

function handleSnapshot(payload) {
  autoDiscovery = payload.autoDiscovery;
  const incomingIDs = new Set((payload.sessions || []).map(s => s.id));
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];
    if (!incomingIDs.has(s.id) && !s.pinned) {
      sessions.splice(i, 1);
      sessionsMap.delete(s.id);
    }
  }
  for (const s of (payload.sessions || [])) {
    if (hiddenSessionIDs.has(s.id)) continue;
    let session = sessionsMap.get(s.id);
    if (!session) {
      session = {
        id: s.id, projectPath: s.projectPath, realCwd: s.realCwd || '',
        isObserver: s.isObserver || false, observedRequest: s.observedRequest || '',
        title: '', folder: folderName(s.projectPath), model: '',
        agents: [], tasks: [], collapsed: false, pinned: false,
        lastActivity: s.birthtimeMs || 0,
        birthtimeMs: s.birthtimeMs || 0,
      };
      sessions.push(session);
      sessionsMap.set(session.id, session);
      session.agents.push({ id: '', name: 'Main', type: 'main' });
    }
    for (const [aid, adata] of Object.entries(s.subagents || {})) {
      if (!session.agents.find(a => a.id === aid)) {
        const atype = typeof adata === 'string' ? adata : adata.type;
        const abirth = typeof adata === 'object' ? (adata.birthtimeMs || 0) : 0;
        session.agents.push({ id: aid, name: agentDisplayName(aid, atype), type: 'agent', birthtimeMs: abirth });
      }
    }
    for (const t of (s.backgroundTasks || [])) {
      if (!session.tasks.find(ta => ta.id === t.id)) {
        session.tasks.push({
          id: t.id, parentAgentID: t.parentAgentID,
          toolName: t.toolName, outputPath: t.outputPath,
          isComplete: t.isComplete,
        });
      }
    }
  }
  for (const [key, val] of Object.entries(payload.lastActivities || {})) {
    agentActivity.set(key, val);
  }
  updateFilters();
  scheduleRebuildNodes();
  needsFullRender = true;
  visibleDirty = true;
}

function handleNewSession(payload) {
  if (hiddenSessionIDs.has(payload.sessionID)) return;
  if (sessionsMap.has(payload.sessionID)) return;
  const session = {
    id: payload.sessionID, projectPath: payload.projectPath,
    realCwd: payload.realCwd || '', isObserver: payload.isObserver || false,
    observedRequest: payload.observedRequest || '',
    title: '', folder: folderName(payload.projectPath), model: '',
    agents: [{ id: '', name: 'Main', type: 'main' }],
    tasks: [], collapsed: false, pinned: false,
    lastActivity: payload.birthtimeMs || Date.now(),
    birthtimeMs: payload.birthtimeMs || 0,
  };
  sessions.push(session);
  sessionsMap.set(session.id, session);
  updateFilters();
  scheduleRebuildNodes();
  needsFullRender = true;
  visibleDirty = true;
  scheduleRender();
}

function handleNewAgent(payload) {
  const s = sessionsMap.get(payload.sessionID);
  if (!s || s.agents.find(a => a.id === payload.agentID)) return;
  s.agents.push({
    id: payload.agentID,
    name: agentDisplayName(payload.agentID, payload.agentType),
    type: 'agent',
    birthtimeMs: payload.birthtimeMs || 0,
  });
  updateFilters();
  scheduleRebuildNodes();
  needsFullRender = true;
  visibleDirty = true;
  scheduleRender();
}

function handleNewBgTask(payload) {
  const s = sessionsMap.get(payload.sessionID);
  if (!s || s.tasks.find(t => t.id === payload.toolID)) return;
  s.tasks.push({
    id: payload.toolID, parentAgentID: payload.parentAgentID,
    toolName: payload.toolName, outputPath: payload.outputPath,
    isComplete: payload.isComplete,
  });
  scheduleRebuildNodes();
  scheduleRender();
}

function handleSessionRemoved(payload) {
  const sid = payload.sessionID;
  const s = sessionsMap.get(sid);
  if (s) {
    for (const a of s.agents) agentActivity.delete(sid + ':' + a.id);
    for (const t of s.tasks) taskDescriptions.delete(t.id);
  }
  const idx = sessions.findIndex(s => s.id === sid);
  if (idx >= 0) {
    sessions.splice(idx, 1);
    sessionsMap.delete(sid);
  }
  updateFilters();
  scheduleRebuildNodes();
  needsFullRender = true;
  visibleDirty = true;
  scheduleRender();
}

// ══════════════════════════════════════════════════════════════════════════════
// Stream items
// ══════════════════════════════════════════════════════════════════════════════

function handleItem(item) {
  if (item.type === 'session_title') {
    const s = sessionsMap.get(item.sessionID);
    if (s) { s.title = item.content.slice(0, 30); }
    scheduleRender();
    return;
  }
  if (item.type === 'observer_meta') {
    const s = sessionsMap.get(item.sessionID);
    if (s) {
      if (item.realCwd) s.realCwd = item.realCwd;
      if (item.observedRequest) s.observedRequest = item.observedRequest;
      s.isObserver = true;
      scheduleRebuildNodes();
    }
    return;
  }
  const s = sessionsMap.get(item.sessionID);
  if (s) s.lastActivity = itemTime(item);
  pushItem(item);
  scheduleRender();
}

function handleItemBatch(items) {
  for (const item of items) {
    if (item.type === 'session_title') {
      const s = sessionsMap.get(item.sessionID);
      if (s) { s.title = item.content.slice(0, 30); }
      continue;
    }
    if (item.type === 'observer_meta') {
      const s = sessionsMap.get(item.sessionID);
      if (s) {
        if (item.realCwd) s.realCwd = item.realCwd;
        if (item.observedRequest) s.observedRequest = item.observedRequest;
        s.isObserver = true;
      }
      continue;
    }
    const s = sessionsMap.get(item.sessionID);
    if (s) s.lastActivity = itemTime(item);
    pushItem(item);
  }
  scheduleRebuildNodes();
  scheduleRender();
}

function pushItem(item) {
  if (hiddenSessionIDs.has(item.sessionID)) return;

  if (item.model) {
    const s = sessionsMap.get(item.sessionID);
    if (s) s.model = item.model;
  }

  if (item.type === 'tool_input' && item.toolID && item.toolName) {
    toolNameMap.set(item.toolID, item.toolName);
  }

  if (item.type === 'tool_input') {
    if (item.agentID) {
      agentActivity.set(item.sessionID + ':' + item.agentID, { toolName: item.toolName || '', content: (item.content || '').slice(0, MAX_DESC_STORE) });
    }
    if (item.toolID) {
      taskDescriptions.set(item.toolID, (item.content || '').slice(0, MAX_DESC_STORE));
    }
  }

  if (item.type === 'user_text') {
    agentActivity.set(item.sessionID + ':' + (item.agentID || ''), { toolName: '', content: (item.content || '').slice(0, MAX_DESC_STORE) });
  }

  if (item.toolID) {
    const key = `${item.toolID}:${item.type}`;
    if (seenToolIDs.has(key)) return;
    seenToolIDs.set(key, true);
  }

  streamItems.push(item);
  if (streamItems.length > MAX_ITEMS) {
    streamItems.splice(0, streamItems.length - MAX_ITEMS);
    visibleDirty = true;
  }
  if (!visibleDirty && isItemVisible(item)) {
    visibleItems.push(item);
  }
}

function isItemVisible(item) {
  if (!filters.has(item.sessionID + ':' + (item.agentID || ''))) return false;
  switch (item.type) {
    case 'thinking': return showThinking;
    case 'tool_input': return showToolInput;
    case 'tool_output': return showToolOutput;
    case 'text': return showText;
    case 'hook_output': return showHook;
    case 'user_text': return showUserPrompt;
    default: return true;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Tree
// ══════════════════════════════════════════════════════════════════════════════

function rebuildNodes() {
  sessions.sort((a, b) => (b.birthtimeMs || 0) - (a.birthtimeMs || 0));
  for (let i = 0; i < sessions.length; i++) sessions[i].colorRank = i;

  computeAgentIdDisplayLengths();

  const today = new Date();
  const todayStr = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const flatSessions = [];
  const olderByDate = new Map();
  const observerSessions = [];

  for (const s of sessions) {
    if (s.isObserver) {
      observerSessions.push(s);
      continue;
    }
    const dateStr = s.birthtimeMs ? formatTime(s.birthtimeMs).split(' ')[0] : null;
    if (!dateStr || dateStr === todayStr || isSessionActive(s)) {
      flatSessions.push(s);
    } else {
      if (!olderByDate.has(dateStr)) olderByDate.set(dateStr, []);
      olderByDate.get(dateStr).push(s);
    }
  }

  treeNodes.length = 0;

  function addSessionWithChildren(s, inFolder) {
    treeNodes.push({ type: 'session', level: 0, isLast: false, inFolder: !!inFolder, ...s });
    if (s.collapsed) return;
    const agents = (s.agents || []).slice().sort((a, b) => {
      if (a.type === 'main') return -1;
      if (b.type === 'main') return 1;
      return (a.birthtimeMs || 0) - (b.birthtimeMs || 0);
    });
    const lastAgentIdx = agents.length - 1;
    for (let ai = 0; ai < agents.length; ai++) {
      const a = agents[ai];
      const isLastAgent = ai === lastAgentIdx;
      const tasks = s.tasks.filter(t =>
        (a.id === '' && !t.parentAgentID) || t.parentAgentID === a.id
      );
      const lastTaskIdx = tasks.length - 1;
      const actKey = s.id + ':' + a.id;
      const act = agentActivity.get(actKey);
      treeNodes.push({
        type: a.type, id: a.id, name: a.name, sessionID: s.id,
        level: 1, isLast: isLastAgent,
        activityTool: act ? act.toolName : '',
        activityDesc: act ? act.content : '',
      });
      for (let ti = 0; ti < tasks.length; ti++) {
        const t = tasks[ti];
        const tDesc = taskDescriptions.get(t.id);
        treeNodes.push({
          type: 'task', id: t.id, name: t.toolName,
          sessionID: s.id, parentAgentID: t.parentAgentID,
          outputPath: t.outputPath, isComplete: t.isComplete,
          level: 2, isLast: ti === lastTaskIdx,
          parentIsLast: isLastAgent,
          description: tDesc || '',
        });
      }
    }
  }

  for (const s of flatSessions) {
    addSessionWithChildren(s, false);
  }

  const sortedDates = [...olderByDate.keys()].sort((a, b) => b.localeCompare(a));

  // Observer folder: aggregate all isObserver sessions
  const observerCollapsed = folderCollapsed['__observer__'] !== false;
  if (observerSessions.length > 0) {
    treeNodes.push({
      type: 'observer-folder', date: '__observer__', level: 0, isLast: false,
      collapsed: observerCollapsed, sessionCount: observerSessions.length,
    });
    if (!observerCollapsed) {
      for (const s of observerSessions) {
        addSessionWithChildren(s, true);
      }
    }
  }

  for (let di = 0; di < sortedDates.length; di++) {
    const dateStr = sortedDates[di];
    const folderSessions = olderByDate.get(dateStr);
    const collapsed = folderCollapsed[dateStr] !== false;
    treeNodes.push({
      type: 'date-folder', date: dateStr, level: 0, isLast: false,
      collapsed, sessionCount: folderSessions.length,
    });
    if (!collapsed) {
      for (const s of folderSessions) {
        addSessionWithChildren(s, true);
      }
    }
  }

  const flatSessionNodes = treeNodes.filter(n => n.type === 'session' && !n.inFolder);
  if (flatSessionNodes.length > 0) flatSessionNodes[flatSessionNodes.length - 1].isLast = true;

  // Mark last session inside Observer folder
  if (observerSessions.length > 0 && folderCollapsed['__observer__'] !== false) {
    const thisFolder = [];
    let inThisFolder = false;
    for (const n of treeNodes) {
      if (n.type === 'observer-folder') { inThisFolder = true; continue; }
      if (n.type === 'observer-folder' || n.type === 'date-folder') { inThisFolder = false; continue; }
      if (inThisFolder && n.type === 'session') thisFolder.push(n);
    }
    if (thisFolder.length > 0) thisFolder[thisFolder.length - 1].isLast = true;
  }

  for (const dateStr of sortedDates) {
    if (folderCollapsed[dateStr] !== false) continue;
    const thisFolder = [];
    let inThisFolder = false;
    for (const n of treeNodes) {
      if (n.type === 'date-folder' && n.date === dateStr) { inThisFolder = true; continue; }
      if (n.type === 'date-folder' && n.date !== dateStr) { inThisFolder = false; continue; }
      if (inThisFolder && n.type === 'session') thisFolder.push(n);
    }
    if (thisFolder.length > 0) thisFolder[thisFolder.length - 1].isLast = true;
  }

  if (treeCursor >= treeNodes.length) treeCursor = Math.max(0, treeNodes.length - 1);
  treeDirty = true;
}

function treePrefix(node) {
  if (node.level === 0) {
    return node.inFolder ? '    ' : '';
  }
  const branch = node.isLast ? '└──' : '├──';
  if (node.level === 1) return '  ' + branch;
  const parentIsLast = node.parentIsLast !== undefined ? node.parentIsLast : true;
  const stem = parentIsLast ? '    ' : '│  ';
  return '  ' + stem + branch;
}

function getNodeHTML(node, idx) {
  const isSelected = idx === treeCursor;
  const selClass = isSelected ? ' selected' : '';

  if (node.type === 'date-folder' || node.type === 'observer-folder') {
    const label = node.type === 'observer-folder' ? 'Observer' : node.date;
    const icon = node.collapsed ? '▸' : '▾';
    return `<div class="tree-row tree-row-folder${selClass ? ' selected' : ''}">
      <div class="tree-content" onclick="treeClick(${idx})" data-idx="${idx}">
        <div class="tree-node folder-node">
          ${icon} 📁 ${esc(label)} <span style="font-size:10px;color:var(--dim);margin-left:4px">(${node.sessionCount})</span>
        </div>
      </div>
    </div>`;
  }

  if (node.type === 'session') {
    const displayName = sessionDisplayName(node);
    const parts = [];
    if (node.model) parts.push(`🧠 ${esc(node.model)}`);
    const activeDot = isSessionActive(node) ? '<span class="active-dot on">🟢</span>' : '<span class="active-dot off">⚪</span>';
    const subInfo = parts.length > 0 ? ` <span style="color:#6b7280;font-size:10px">${parts.join(' · ')}</span>` : '';
    const agentCount = node.agents ? node.agents.filter(a => a.type === 'agent').length : 0;
    const timeStr = formatTime(node.birthtimeMs);
    const timeHtml = timeStr ? `<span style="margin-left:auto;font-size:10px;color:var(--dim);flex-shrink:0">${timeStr}</span>` : '';
    const tipLines = [node.realCwd || node.projectPath || ''];
    if (node.isObserver && node.observedRequest) tipLines.push('Observing: ' + node.observedRequest);
    const titleAttr = tipLines.length ? ` title="${esc(tipLines.join('\n'))}"` : '';
    return `<div class="tree-row tree-row-session${selClass ? ' selected' : ''}">
      <div class="tree-content" onclick="treeClick(${idx})" data-idx="${idx}"${titleAttr}>
        <div class="tree-node">
          <span class="tree-prefix">${treePrefix(node)}</span>${activeDot} ${node.collapsed ? '▸' : '▾'} <span class="session-prefix" style="color:${idColor(node.colorRank)}" data-sid="${esc(node.id)}" onmouseenter="showSessionIdTip(this)" onmouseleave="hideSessionIdTip(this)">${esc(node.id.split('-')[0].toUpperCase())}</span> ${esc(displayName)}
          ${node.collapsed && agentCount > 0 ? `(${esc(String(agentCount))})` : ''}
          ${subInfo}
          ${timeHtml}
        </div>
      </div>
      <span class="tree-actions">
        <button class="btn btn-icon accent" onclick="event.stopPropagation();selectIndex(${idx});soloSelected()" data-tooltip="Solo">⊙</button>
        <button class="btn btn-icon danger" onclick="event.stopPropagation();selectIndex(${idx});removeSelectedSession()" data-tooltip="Remove">✕</button>
      </span>
    </div>`;
  }

  if (node.type === 'main' || node.type === 'agent') {
    const icon = node.type === 'main' ? '💬' : '🤖';
    const enabled = filters.get(node.sessionID + ':' + node.id);
    const ctxKey = node.sessionID + ':' + node.id;
    const ctx = contextData[ctxKey];
    let ctxPct = '';
    if (ctx && ctx.contextWindow > 0) {
      const ctxTotal = (ctx.inputTokens || 0) + (ctx.cacheCreation || 0) + (ctx.cacheRead || 0);
      if (ctxTotal > 0) {
        const pct = Math.round(ctxTotal / ctx.contextWindow * 100);
        const cls = pct > 80 ? 'danger' : pct > 50 ? 'warn' : '';
        if (showTokenCount) {
          ctxPct = `<span class="ctx-pct ${cls}">${fmtTok(ctxTotal)}</span>`;
        } else {
          ctxPct = `<span class="ctx-pct ${cls}">${pct}%</span>`;
        }
      }
    }
    const activeDot = ctx && (Date.now() - ctx.lastActivity < 120000) ? '<span class="active-dot on">🟢</span>' : '<span class="active-dot off">⚪</span>';
    const actIcon = node.type === 'main' ? '🗣' : '⚡';
    const actText = showActivity && (node.activityTool || node.activityDesc)
      ? (node.activityTool && node.activityDesc ? `${node.activityTool}: ${node.activityDesc}` : (node.activityTool || node.activityDesc))
      : '';
    const indent = treePrefix(node).replace(/[├└]──/, '   ');
    const actPrefix = `<span class="tree-prefix">${indent}</span>`;
    const activityHTML = actText
      ? `<div class="tree-activity">${actPrefix}<span class="act-text">${actIcon} ${esc(actText)}</span></div>`
      : '';
    return `<div class="tree-row${selClass ? ' selected' : ''}">
      <div class="tree-content${enabled ? '' : ' dim'}" onclick="treeClick(${idx})" data-idx="${idx}">
        <div class="tree-node">
          <span class="tree-prefix">${treePrefix(node)}</span>${activeDot} ${icon} ${esc(node.name || '')}${node.type === 'agent' && node.id ? '<span class="tree-agent-id">(' + esc(node.id.slice(0, agentIdDisplayLen.get(node.sessionID + ':' + node.id) || 7)) + ')</span>' : ''}${ctxPct}
        </div>
        ${activityHTML}
      </div>
      <span class="tree-actions">
        <button class="btn btn-icon accent" onclick="event.stopPropagation();selectIndex(${idx});soloSelected()" data-tooltip="Solo">⊙</button>
        <button class="btn btn-icon" onclick="event.stopPropagation();selectIndex(${idx});toggleNodeVisibility(${idx})" data-tooltip="${enabled ? 'Hide' : 'Show'}">${enabled ? '👁' : '─'}</button>
      </span>
    </div>`;
  }

  if (node.type === 'task') {
    const icon = node.isComplete ? '✓' : '⏳';
    const taskIndent = treePrefix(node).replace(/[├└]──/, '   ');
    const taskPrefix = `<span class="tree-prefix">${taskIndent}</span>`;
    const descHTML = showActivity && node.description
      ? `<div class="tree-activity">${taskPrefix}<span class="act-text">📋 ${esc(node.description)}</span></div>`
      : '';
    return `<div class="tree-row${selClass ? ' selected' : ''}">
      <div class="tree-content dim" onclick="treeClick(${idx})" data-idx="${idx}">
        <div class="tree-node">
          <span class="tree-prefix">${treePrefix(node)}</span>${icon} ${esc(node.name || 'bg-task')}
        </div>
        ${descHTML}
      </div>
      <span class="tree-actions">
        <button class="btn btn-icon" onclick="event.stopPropagation();selectIndex(${idx});loadBgTask(${idx})" data-tooltip="Load output">▶</button>
      </span>
    </div>`;
  }

  return '';
}

function renderTree() {
  if (treeNodes.length === 0) {
    treeEl.innerHTML = '<div class="tree-node" style="padding:8px;color:var(--dim)">Waiting for sessions...</div>';
    treeCursorInfo.textContent = '';
    return;
  }

  const cursorChanged = treeCursor !== lastTreeCursor;
  if (treeDirty) {
    const parts = new Array(treeNodes.length);
    for (let i = 0; i < treeNodes.length; i++) {
      parts[i] = getNodeHTML(treeNodes[i], i);
    }
    treeEl.innerHTML = parts.join('');
    treeDirty = false;
  } else if (cursorChanged) {
    const prevSel = treeEl.querySelector('.tree-row.selected');
    if (prevSel) prevSel.classList.remove('selected');
    const newContent = treeEl.querySelector('[data-idx="' + treeCursor + '"]');
    if (newContent) {
      const row = newContent.closest('.tree-row');
      if (row) row.classList.add('selected');
    }
  }
  lastTreeCursor = treeCursor;

  const sel = treeEl.querySelector('.tree-row.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });

  treeCursorInfo.textContent = `${treeCursor + 1}/${treeNodes.length}`;
}

function updateTreeDots() {
  const dots = treeEl.querySelectorAll('.active-dot');
  const now = Date.now();
  for (const dot of dots) {
    const content = dot.closest('.tree-content');
    if (!content) continue;
    const idx = parseInt(content.getAttribute('data-idx'));
    if (isNaN(idx)) continue;
    const node = treeNodes[idx];
    if (!node) continue;
    let active = false;
    if (node.type === 'session') {
      active = isSessionActive(node);
    } else if (node.type === 'main' || node.type === 'agent') {
      const ctxKey = node.sessionID + ':' + node.id;
      const ctx = contextData[ctxKey];
      const threshold = node.type === 'main' ? 600000 : 180000;
      active = ctx && (now - ctx.lastActivity < threshold);
    }
    const newCls = active ? 'active-dot on' : 'active-dot off';
    const newHTML = active ? '🟢' : '⚪';
    if (dot.className !== newCls) {
      dot.className = newCls;
      dot.innerHTML = newHTML;
    }
  }
}

function isSessionActive(session) {
  if (!session) return false;
  const now = Date.now();
  const mainCtx = contextData[session.id + ':'];
  if (mainCtx && (now - mainCtx.lastActivity) < 600000) return true;
  for (const a of session.agents) {
    if (a.id === '') continue;
    const ctx = contextData[session.id + ':' + a.id];
    if (ctx && (now - ctx.lastActivity) < 180000) return true;
  }
  return (now - session.lastActivity) < 600000;
}

// ══════════════════════════════════════════════════════════════════════════════
// Stream rendering
// ══════════════════════════════════════════════════════════════════════════════

function renderStream() {
  if (visibleDirty) {
    visibleItems = streamItems.filter(isItemVisible);
    visibleDirty = false;
  }

  const visible = visibleItems;
  const wasAutoScroll = autoScroll;

  if (needsFullRender || renderedItemCount > visible.length) {
    const lines = [];
    for (const item of visible) {
      for (const l of renderItem(item)) lines.push(l);
    }

    let html;
    if (lines.length > 0) {
      html = lines.map(l => {
        const sidAttr = l.sessionID ? ` data-session-id="${esc(l.sessionID)}"` : '';
        if (l.html) return `<div class="${esc(l.cls)}"${sidAttr}>${l.text}</div>`;
        return `<div class="${esc(l.cls)}"${sidAttr}>${esc(l.text)}</div>`;
      }).join('\n');
    } else if (streamItems.length > 0) {
      html = `<div style="color:#fbbf24;padding:20px;text-align:center">${streamItems.length} items buffered, 0 visible — check toggles or tree selection</div>`;
    } else {
      html = '<div style="color:#6b7280;padding:20px;text-align:center">Waiting for output...</div>';
    }

    streamEl.innerHTML = html;
    renderedItemCount = visible.length;
    needsFullRender = false;
    if (wasAutoScroll) requestAnimationFrame(() => { streamEl.scrollTop = streamEl.scrollHeight; });
  } else {
    for (let i = renderedItemCount; i < visible.length; i++) {
      for (const l of renderItem(visible[i])) {
        const div = document.createElement('div');
        div.className = l.cls;
        if (l.sessionID) div.dataset.sessionId = l.sessionID;
        div.innerHTML = l.html ? l.text : esc(l.text);
        streamEl.appendChild(div);
      }
    }
    renderedItemCount = visible.length;
    if (autoScroll) requestAnimationFrame(() => { streamEl.scrollTop = streamEl.scrollHeight; });
  }

  const maxScroll = streamEl.scrollHeight - streamEl.clientHeight;
  const pct = maxScroll > 0 ? Math.round(streamEl.scrollTop / maxScroll * 100) : 0;
  document.getElementById('scroll-pos').textContent = Math.min(100, pct) + '%';
  document.getElementById('item-count').textContent = streamItems.length + ' items';
}

function renderItem(item) {
  const lines = [];
  const isSub = !!item.agentID;
  const agentTagCls = 'stream-line ' + (isSub ? 'agent-sub agent-tag' : 'agent-main agent-tag');
  const sep = ' » ';
  const sid = item.sessionID || '';

  if (item.type === 'turn_marker') {
    return [{ cls: 'stream-line marker', text: `── turn ended ${fmtDur(item.durationMs)} ──`, sessionID: sid }];
  }
  if (item.type === 'compact_marker') {
    const label = item.content ? `compacted (${item.content})` : 'compacted';
    return [{ cls: 'stream-line marker', text: `── ${label} ──`, sessionID: sid }];
  }
  if (item.type === 'pr_link') {
    return [{ cls: 'stream-line marker', text: `── ${item.content} ──`, sessionID: sid }];
  }

  const agentName = item.agentName || 'Main';
  const sForColor = sessionsMap.get(item.sessionID);
  const prefixTag = `<span class="session-prefix" style="color:${idColor(sForColor ? sForColor.colorRank : 0)}">[${esc(item.sessionID.split('-')[0].toUpperCase())}]</span>`;
  const agentIdTag = item.agentID ? `<span class="session-prefix" style="color:var(--dim)">(</span><span class="session-prefix" style="color:var(--magenta)">${esc(item.agentID.slice(0, agentIdDisplayLen.get(item.sessionID + ':' + item.agentID) || 7))}</span><span class="session-prefix" style="color:var(--dim)">)</span>` : '';
  const agentLabel = prefixTag + agentIdTag + ' ' + esc(agentName);
  const tsHtml = item.timestamp ? `<span class="timestamp">${fmtTimestamp(item.timestamp)}</span>` : '';

  switch (item.type) {
    case 'thinking':
      lines.push({ cls: agentTagCls, text: `<span class="tag-label">${agentLabel}${sep}🧠 Thinking</span>${tsHtml}`, html: true, sessionID: sid });
      for (const l of truncContent(item.content)) lines.push({ cls: 'stream-line thinking', text: l, sessionID: sid });
      break;
    case 'tool_input':
      lines.push({ cls: agentTagCls, text: `<span class="tag-label">${agentLabel}${sep}🔧 ${esc(item.toolName || '')}</span>${tsHtml}`, html: true, sessionID: sid });
      for (const l of truncContent(item.content)) lines.push({ cls: 'stream-line tool-input', text: l, sessionID: sid });
      break;
    case 'tool_output': {
      let tn = '';
      if (item.toolID) {
        tn = toolNameMap.get(item.toolID) || '';
      }
      let label = tn ? `📤 ${tn} result` : '📤 Output';
      if (item.durationMs > 0) label += ' ' + fmtDur(item.durationMs);
      lines.push({ cls: agentTagCls, text: `<span class="tag-label">${agentLabel}${sep}${esc(label)}</span>${tsHtml}`, html: true, sessionID: sid });
      for (const l of truncContent(item.content)) lines.push({ cls: 'stream-line tool-output', text: l, sessionID: sid });
      break;
    }
    case 'text':
      lines.push({ cls: agentTagCls, text: `<span class="tag-label">${agentLabel}${sep}💬 Response</span>${tsHtml}`, html: true, sessionID: sid });
      lines.push({ cls: 'stream-line text md-content', text: mdRender(item.content), html: true, sessionID: sid });
      break;
    case 'hook_output': {
      let label = '🪝 Hook';
      if (item.toolName) label += ' ' + item.toolName;
      if (item.durationMs > 0) label += ' ' + fmtDur(item.durationMs);
      lines.push({ cls: agentTagCls, text: `<span class="tag-label">${agentLabel}${sep}${esc(label)}</span>${tsHtml}`, html: true, sessionID: sid });
      if (item.hookCommand) lines.push({ cls: 'stream-line hook', text: `<span class="hook-label">command:</span> ${esc(item.hookCommand)}`, html: true, sessionID: sid });
      if (item.hookContent) {
        for (const l of truncContent(item.hookContent)) lines.push({ cls: 'stream-line hook', text: `<span class="hook-label">content:</span> ${esc(l)}`, html: true, sessionID: sid });
      }
      for (const l of truncContent(item.content)) lines.push({ cls: 'stream-line hook', text: `<span class="hook-label">stdout:</span> ${esc(l)}`, html: true, sessionID: sid });
      break;
    }
    case 'diagnostics': {
      let label = '⚠ Diagnostics';
      if (item.toolName) label += ' ' + item.toolName;
      lines.push({ cls: agentTagCls, text: `<span class="tag-label">${agentLabel}${sep}${esc(label)}</span>${tsHtml}`, html: true, sessionID: sid });
      for (const l of truncContent(item.content)) lines.push({ cls: 'stream-line diag', text: l, sessionID: sid });
      break;
    }
    case 'debug': {
      let label = '🔍 Debug';
      if (item.toolName) label += ' ' + item.toolName;
      lines.push({ cls: agentTagCls, text: `<span class="tag-label">${agentLabel}${sep}${esc(label)}</span>${tsHtml}`, html: true, sessionID: sid });
      for (const l of truncContent(item.content)) lines.push({ cls: 'stream-line debug', text: l, sessionID: sid });
      break;
    }
    case 'user_text':
      lines.push({ cls: agentTagCls, text: `<span class="tag-label">${agentLabel}${sep}👤 User Prompt</span>${tsHtml}`, html: true, sessionID: sid });
      lines.push({ cls: 'stream-line user-prompt-block md-content', text: mdRender(item.content), html: true, sessionID: sid });
      break;
  }

  lines.push({ cls: 'stream-line separator', text: '─'.repeat(60), sessionID: sid });
  return lines;
}

function truncContent(content) {
  const raw = content.split('\n');
  return raw.length > MAX_LINES ? raw.slice(0, MAX_LINES).concat([`... (${raw.length - MAX_LINES} more lines)`]) : raw;
}

// ══════════════════════════════════════════════════════════════════════════════
// Stream button updates
// ══════════════════════════════════════════════════════════════════════════════

function updateStreamButtons() {
  document.getElementById('btn-thinking').classList.toggle('on', showThinking);
  document.getElementById('btn-tool-input').classList.toggle('on', showToolInput);
  document.getElementById('btn-tool-output').classList.toggle('on', showToolOutput);
  document.getElementById('btn-text').classList.toggle('on', showText);
  document.getElementById('btn-hook').classList.toggle('on', showHook);
  document.getElementById('btn-user-prompt').classList.toggle('on', showUserPrompt);
  document.getElementById('btn-activity').classList.toggle('on', showActivity);
  const btnTokenDisplay = document.getElementById('btn-token-display');
  btnTokenDisplay.classList.toggle('on', true);
  btnTokenDisplay.textContent = showTokenCount ? 'T' : '%';
  btnTokenDisplay.setAttribute('data-tooltip', showTokenCount ? '上下文：Token数 ↔ 百分比切换' : '上下文：百分比 ↔ Token数切换');
}

// ══════════════════════════════════════════════════════════════════════════════
// Session ID tooltip
// ══════════════════════════════════════════════════════════════════════════════

let sessionIdTipTimer = null;
let sessionIdTipEl = null;

function showSessionIdTip(el) {
  hideAllSessionIdTips();
  const sid = el.getAttribute('data-sid');
  if (!sid) return;
  sessionIdTipTimer = setTimeout(() => {
    const rect = el.getBoundingClientRect();
    const tip = document.createElement('div');
    tip.className = 'session-id-tip';
    tip.style.top = (rect.bottom + 4) + 'px';
    tip.style.left = rect.left + 'px';
    tip.innerHTML = `<button class="tip-copy-btn" onclick="event.stopPropagation();copySessionId(this)">Copy</button><code>${esc(sid)}</code>`;
    tip.onmouseenter = () => clearTimeout(sessionIdTipTimer);
    tip.onmouseleave = () => { hideAllSessionIdTips(); };
    document.body.appendChild(tip);
    sessionIdTipEl = tip;
    el._tip = tip;
  }, 300);
}

function hideSessionIdTip(el) {
  sessionIdTipTimer = setTimeout(() => {
    if (el._tip) { el._tip.remove(); el._tip = null; }
    sessionIdTipEl = null;
  }, 200);
}

function hideAllSessionIdTips() {
  clearTimeout(sessionIdTipTimer);
  document.querySelectorAll('.session-id-tip').forEach(t => t.remove());
  sessionIdTipEl = null;
}

function copySessionId(btn) {
  const code = btn.parentElement.querySelector('code');
  if (!code) return;
  navigator.clipboard.writeText(code.textContent).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.closest('.session-id-tip')?.remove(); }, 800);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Actions
// ══════════════════════════════════════════════════════════════════════════════

function selectIndex(idx) {
  if (idx >= 0 && idx < treeNodes.length) treeCursor = idx;
}

function treeClick(idx) {
  selectIndex(idx);
  const node = treeNodes[idx];
  if (!node) return;
  if (node.type === 'date-folder' || node.type === 'observer-folder') {
    node.collapsed = !node.collapsed;
    const key = node.type === 'observer-folder' ? '__observer__' : node.date;
    folderCollapsed[key] = node.collapsed;
    rebuildNodes();
  } else if (node.type === 'session') {
    const session = sessions.find(s => s.id === node.id);
    if (session) {
      session.collapsed = !session.collapsed;
      if (!session.collapsed) session.pinned = true;
    }
    rebuildNodes();
  } else if (node.type === 'main' || node.type === 'agent') {
    toggleNodeVisibility(idx);
    return;
  } else if (node.type === 'task') {
    loadBgTask(idx);
    return;
  }
  renderAll();
}

function toggleNodeVisibility(idx) {
  const node = treeNodes[idx];
  if (!node) return;
  const key = node.sessionID + ':' + node.id;
  const wasEnabled = filters.get(key);
  filters.set(key, !wasEnabled);
  if (wasEnabled) visibleFilterCount--;
  else visibleFilterCount++;
  renderAll();
}

function loadBgTask(idx) {
  const node = treeNodes[idx];
  if (!node || node.type !== 'task') return;
  if (!node.outputPath) return;

  fetch(`/api/task-output?path=${encodeURIComponent(node.outputPath)}`)
    .then(r => r.json())
    .then(data => {
      const content = data.content || `[Error: ${data.error || 'unknown'}]`;
      const statusIcon = node.isComplete ? '✓' : '⏳';
      streamItems.push({
        type: 'tool_output', sessionID: node.sessionID, agentID: node.parentAgentID || '',
        agentName: '', toolName: `${statusIcon} ${node.name || 'bg-task'}`,
        content: content,
        timestamp: new Date(), toolID: '', durationMs: 0,
        inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, model: '',
      });
      renderAll();
    })
    .catch(err => {
      streamItems.push({
        type: 'tool_output', sessionID: node.sessionID, agentID: node.parentAgentID || '',
        agentName: '', toolName: `⏳ ${node.name || 'bg-task'}`,
        content: `[Failed to load: ${err.message}]`,
        timestamp: new Date(), toolID: '', durationMs: 0,
        inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, model: '',
      });
      renderAll();
    });
}

function soloSelected() {
  const node = treeNodes[treeCursor];
  if (!node || node.type === 'task') return;

  if (isSoloed(node)) {
    updateFilters();
  } else {
    filters.clear();
    visibleFilterCount = 0;
    if (node.type === 'session') {
      const session = sessions.find(s => s.id === node.id);
      if (session && session.collapsed) {
        session.collapsed = false;
        session.pinned = true;
        rebuildNodes();
      }
      for (const a of node.agents) {
        filters.set(node.id + ':' + a.id, true);
        visibleFilterCount++;
      }
    } else if (node.type === 'main' || node.type === 'agent') {
      filters.set(node.sessionID + ':' + node.id, true);
      visibleFilterCount = 1;
    }
  }
  renderAll();
}

function isSoloed(node) {
  if (node.type === 'session') {
    if (visibleFilterCount !== node.agents.length) return false;
    for (const a of node.agents) {
      if (!filters.get(node.id + ':' + a.id)) return false;
    }
    return true;
  }
  if (node.type === 'main' || node.type === 'agent') {
    const key = node.sessionID + ':' + node.id;
    return visibleFilterCount === 1 && filters.get(key);
  }
  return false;
}

function removeSelectedSession() {
  const node = treeNodes[treeCursor];
  if (!node) return;
  let sid;
  if (node.type === 'session') sid = node.id;
  else sid = node.sessionID;
  if (!sid) return;
  if (!confirm(`Remove session ${sid.slice(0, 12)}...?`)) return;
  hiddenSessionIDs.add(sid);
  _saveHiddenSessions();
  const idx = sessions.findIndex(s => s.id === sid);
  if (idx >= 0) {
    sessions.splice(idx, 1);
    sessionsMap.delete(sid);
  }
  sendCmd('removeSession', { sessionID: sid });
  updateFilters();
  rebuildNodes();
  renderAll();
}

// ══════════════════════════════════════════════════════════════════════════════
// Toggles
// ══════════════════════════════════════════════════════════════════════════════

function toggleThinking() { showThinking = !showThinking; needsFullRender = true; visibleDirty = true; renderStream(); refreshButtons(); }
function toggleToolInput() { showToolInput = !showToolInput; needsFullRender = true; visibleDirty = true; renderStream(); refreshButtons(); }
function toggleToolOutput() { showToolOutput = !showToolOutput; needsFullRender = true; visibleDirty = true; renderStream(); refreshButtons(); }
function toggleText() { showText = !showText; needsFullRender = true; visibleDirty = true; renderStream(); refreshButtons(); }
function toggleHook() { showHook = !showHook; needsFullRender = true; visibleDirty = true; renderStream(); refreshButtons(); }
function toggleUserPrompt() { showUserPrompt = !showUserPrompt; needsFullRender = true; visibleDirty = true; renderStream(); refreshButtons(); }
function toggleActivity() { showActivity = !showActivity; rebuildNodes(); scheduleRender(); refreshButtons(); }
function toggleTokenDisplay() { showTokenCount = !showTokenCount; treeDirty = true; scheduleRender(); refreshButtons(); }

// ══════════════════════════════════════════════════════════════════════════════
// Scroll & Tree panel resize
// ══════════════════════════════════════════════════════════════════════════════

function scrollToTop() { streamEl.scrollTop = 0; autoScroll = false; renderAll(); }
function scrollUp() { streamEl.scrollTop -= 80; autoScroll = false; renderAll(); }
function scrollDown() { streamEl.scrollTop += 80; if (autoScroll) autoScroll = false; renderAll(); }
function scrollToBottom() { streamEl.scrollTop = streamEl.scrollHeight; autoScroll = true; renderAll(); }

function toggleAutoScroll() { autoScroll = !autoScroll; if (autoScroll) streamEl.scrollTop = streamEl.scrollHeight; renderAll(); }
function toggleTree() {
  const showTree = !document.getElementById('tree-panel').classList.contains('hidden');
  document.getElementById('tree-panel').classList.toggle('hidden', showTree);
}

function setupTreeResize() {
  const panel = document.getElementById('tree-panel');
  const handle = document.getElementById('tree-resize-handle');
  let startX, startWidth;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!handle.classList.contains('active')) return;
    const dx = e.clientX - startX;
    const newWidth = startWidth + dx;
    if (newWidth >= 180 && newWidth <= window.innerWidth * 0.6) {
      panel.style.width = newWidth + 'px';
    }
  });

  document.addEventListener('mouseup', () => {
    handle.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

function setupScrollDetection() {
  streamEl.addEventListener('scroll', () => {
    const atBottom = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 50;
    if (atBottom && !autoScroll) autoScroll = true;
    if (!atBottom && autoScroll) autoScroll = false;
    refreshButtons();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Auto-collapse
// ══════════════════════════════════════════════════════════════════════════════

function applyCollapsePolicy(duration) {
  collapseAfter = duration;
  if (collapseTimer) clearInterval(collapseTimer);
  if (duration <= 0) return;

  collapseTimer = setInterval(() => {
    if (!collapseAfter) return;
    const now = Date.now();
    let changed = false;
    for (const s of sessions) {
      if (s.pinned || s.collapsed) continue;
      if ((now - s.lastActivity) > collapseAfter) {
        s.collapsed = true;
        changed = true;
      }
    }
    if (changed) {
      scheduleRebuildNodes();
      renderAll();
    }
  }, 5000);
}

function startActiveRefresh() {
  if (activeRefreshTimer) clearInterval(activeRefreshTimer);
  activeRefreshTimer = setInterval(() => {
    updateTreeDots();
    refreshButtons();
  }, 15000);
}

// ══════════════════════════════════════════════════════════════════════════════
// Filters & Render coordination
// ══════════════════════════════════════════════════════════════════════════════

function updateFilters() {
  filters.clear();
  visibleFilterCount = 0;
  for (const s of sessions) {
    for (const a of s.agents) {
      filters.set(s.id + ':' + a.id, true);
      visibleFilterCount++;
    }
  }
}

function renderAll() {
  needsFullRender = true;
  visibleDirty = true;
  renderTree();
  renderStream();
  refreshButtons();
}

function scheduleRebuildNodes() {
  treeNeedsRebuild = true;
  scheduleRender();
}

function scheduleRender() {
  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      if (treeNeedsRebuild) {
        treeNeedsRebuild = false;
        rebuildNodes();
      }
      renderTree();
      renderStream();
      refreshButtons();
    });
  }
}
