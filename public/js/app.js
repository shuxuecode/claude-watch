// ══════════════════════════════════════════════════════════════════════════════
// app.js — Coordinator: WebSocket, theme, export, tab switching
// ══════════════════════════════════════════════════════════════════════════════

// ── DOM refs ──
const sessionInfo = document.getElementById('session-info');
const tokenInfo = document.getElementById('token-info');

// ── App State ──
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MaxReconnectDelay = 30000;
const MaxReconnectAttempts = 20;
let reconnectAttempts = 0;
let lastMsgTime = 0;
let staleCheckTimer = null;
let currentTab = 'stream';
let appVersion = '';
let latestVersion = '';

// Cache highlight.js CSS for HTML export
let hljsDarkCSS = '', hljsLightCSS = '';
fetch('vendor/github-dark.min.css').then(r => r.text()).then(t => { hljsDarkCSS = t; }).catch(() => {});
fetch('vendor/github-light.min.css').then(r => r.text()).then(t => { hljsLightCSS = t; }).catch(() => {});

// Cache app CSS for HTML export
let appCSS = '';
fetch('css/app.css').then(r => r.text()).then(t => { appCSS = t; }).catch(() => {});

// ══════════════════════════════════════════════════════════════════════════════
// WebSocket
// ══════════════════════════════════════════════════════════════════════════════

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    sessionInfo.textContent = 'Connected';
    lastMsgTime = Date.now();
    reconnectDelay = 1000;
    reconnectAttempts = 0;
    startStaleCheck();
    startActiveRefresh();
  };
  ws.onclose = () => {
    reconnectAttempts++;
    if (reconnectAttempts >= MaxReconnectAttempts) {
      sessionInfo.textContent = 'Disconnected. Please refresh to reconnect.';
      return;
    }
    sessionInfo.textContent = 'Disconnected, reconnecting...';
    stopStaleCheck();
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MaxReconnectDelay);
  };
  ws.onerror = (e) => { console.warn('[ws] connection error', e); };

  ws.onmessage = (e) => {
    lastMsgTime = Date.now();
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleMessage(msg);
  };
}

function startStaleCheck() {
  if (staleCheckTimer) clearInterval(staleCheckTimer);
  staleCheckTimer = setInterval(() => {
    if (Date.now() - lastMsgTime > 45000) {
      sessionInfo.textContent = 'Stale connection, reconnecting...';
      stopStaleCheck();
      try { ws.close(); } catch {}
    }
  }, 10000);
}

function stopStaleCheck() {
  if (staleCheckTimer) { clearInterval(staleCheckTimer); staleCheckTimer = null; }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'snapshot': handleSnapshot(msg.payload); break;
    case 'itemBatch': handleItemBatch(msg.payload); break;
    case 'item': handleItem(msg.payload); break;
    case 'newSession': handleNewSession(msg.payload); break;
    case 'newAgent': handleNewAgent(msg.payload); break;
    case 'newBackgroundTask': handleNewBgTask(msg.payload); break;
    case 'sessionRemoved': handleSessionRemoved(msg.payload); break;
    case 'autoDiscoveryChanged': autoDiscovery = msg.payload.enabled; scheduleRender(); break;
    case 'context': contextData = msg.payload; updateTreeDots(); refreshButtons(); scheduleRender(); break;
    case 'tokenStats': handleTokenStats(msg.payload); break;
    case 'config':
      if (msg.payload.version) appVersion = msg.payload.version;
      if (msg.payload.latestVersion) { latestVersion = msg.payload.latestVersion; renderFooterVersion(); }
      if (msg.payload.collapseAfter > 0) {
        applyCollapsePolicy(msg.payload.collapseAfter);
      }
      break;
    case 'heartbeat': break;
  }
}

function sendCmd(action, extra = {}) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ action, ...extra }));
}

// ══════════════════════════════════════════════════════════════════════════════
// Button / header refresh
// ══════════════════════════════════════════════════════════════════════════════

function refreshButtons() {
  updateStreamButtons();

  document.getElementById('btn-autodisco').classList.toggle('on', autoDiscovery);

  // Session info
  let info = '';
  if (sessions.length === 0) info = 'Waiting...';
  else if (sessions.length === 1) {
    const s = sessions[0];
    info = sessionDisplayName(s);
  } else info = sessions.length + ' sessions';
  if (!autoDiscovery) info += ' [paused]';
  sessionInfo.textContent = info;

  // Token info
  computeTokensFromContext();
  let tokStr = '';
  if (totalInput > 0 || totalOutput > 0) {
    tokStr = `${fmtTok(totalInput)} in / ${fmtTok(totalOutput)} out`;
    if (totalCacheCreate > 0 || totalCacheRead > 0) {
      tokStr += ` · cache ${fmtTok(totalCacheCreate)}+${fmtTok(totalCacheRead)}`;
    }
  }
  tokenInfo.textContent = tokStr;

  // Footer version
  renderFooterVersion();
}

function renderFooterVersion() {
  const vEl = document.getElementById('footer-version');
  if (vEl) {
    const v = appVersion ? `v${appVersion}` : '';
    const hasUpdate = latestVersion && appVersion && latestVersion !== appVersion;
    const updateBadge = hasUpdate
      ? `<a href="https://www.npmjs.com/package/claude-code-watch" target="_blank" rel="noopener" class="version-update-badge" data-tooltip="New version available! Click to view on npm"><span class="version-update-dot"></span>v${latestVersion} ↑</a>`
      : '';
    vEl.innerHTML = `${v ? v + ' ' : ''}${updateBadge}${updateBadge ? ' · ' : ''}<a href="https://github.com/shuxuecode/claude-watch" target="_blank" rel="noopener" style="color:var(--dim);display:inline-flex;align-items:center;gap:3px"><svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" style="vertical-align:middle"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>claude-watch</a>`;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab switching
// ══════════════════════════════════════════════════════════════════════════════

function switchTab(tab) {
  currentTab = tab;
  // Sync URL hash without triggering hashchange loop
  if (location.hash !== '#' + tab) {
    history.replaceState(null, '', '#' + tab);
  }
  document.getElementById('main').style.display = tab === 'stream' ? 'flex' : 'none';
  document.getElementById('tokens-page').style.display = tab === 'tokens' ? 'flex' : 'none';
  document.getElementById('tab-stream').classList.toggle('on', tab === 'stream');
  document.getElementById('tab-tokens').classList.toggle('on', tab === 'tokens');
  document.getElementById('footer').style.display = tab === 'stream' ? 'flex' : 'none';
  // Toggle stream-only header controls
  document.querySelectorAll('.stream-only').forEach(el => {
    el.style.display = tab === 'stream' ? '' : 'none';
  });
  if (tab === 'tokens' && !tokenStatsRendered && tokenStatsData.totals.messages > 0) {
    tokenStatsRendered = true;
    renderTokenPage();
  }
}

// Hash routing: browser back/forward and manual URL editing
window.addEventListener('hashchange', () => {
  const tab = (location.hash.slice(1) || 'stream');
  if (tab === 'stream' || tab === 'tokens') {
    switchTab(tab);
  }
});

function toggleAutoDiscovery() { sendCmd('toggleAutoDiscovery'); }

// ══════════════════════════════════════════════════════════════════════════════
// Theme toggle
// ══════════════════════════════════════════════════════════════════════════════

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('btn-theme');
  if (btn) {
    btn.textContent = theme === 'dark' ? '🌙' : '☀️';
    btn.setAttribute('data-tooltip', theme === 'dark' ? 'Switch to light' : 'Switch to dark');
  }
  const hlLink = document.querySelector('link[rel="stylesheet"][href*="github"]');
  if (hlLink) {
    hlLink.href = theme === 'dark' ? 'vendor/github-dark.min.css' : 'vendor/github-light.min.css';
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
}

// ══════════════════════════════════════════════════════════════════════════════
// Export modal — session selection
// ══════════════════════════════════════════════════════════════════════════════

let exportModalSelected = new Set();

function openExportModal() {
  if (sessions.length === 0) {
    const btn = document.getElementById('btn-export');
    const orig = btn.textContent;
    btn.textContent = '✕ 无会话';
    setTimeout(() => { btn.textContent = orig; }, 2000);
    return;
  }
  exportModalSelected = new Set(sessions.map(s => s.id));
  renderModalSessionList();
  updateModalCount();
  document.getElementById('export-modal').style.display = 'flex';
}

function renderModalSessionList() {
  const listEl = document.getElementById('modal-session-list');
  const sorted = [...sessions].sort((a, b) => (a.colorRank || 0) - (b.colorRank || 0));
  listEl.innerHTML = sorted.map(s => {
    const color = idColor(s.colorRank || 0);
    const project = folderName(s.realCwd || s.projectPath) || s.realCwd || s.projectPath || '';
    const prefix = s.id.split('-')[0].toUpperCase();
    const model = s.model || '';
    const time = formatTime(s.birthtimeMs);
    const checked = exportModalSelected.has(s.id) ? 'checked' : '';
    const selectedClass = exportModalSelected.has(s.id) ? ' selected' : '';
    return `<div class="modal-session-row${selectedClass}" data-sid="${esc(s.id)}" onclick="toggleModalSession('${esc(s.id)}', this)">
      <input type="checkbox" class="modal-checkbox" data-sid="${esc(s.id)}" ${checked} onclick="event.stopPropagation(); toggleModalSession('${esc(s.id)}', this.parentElement)">
      <span class="modal-session-prefix" style="color:${color}">${esc(prefix)}</span>
      <div class="modal-session-info">
        <span class="modal-session-project">${esc(project)}</span>
        ${model ? `<span class="modal-session-model">${esc(model)}</span>` : ''}
      </div>
      ${time ? `<span class="modal-session-time">${esc(time)}</span>` : ''}
    </div>`;
  }).join('\n');
}

function toggleModalSession(sid, rowEl) {
  if (exportModalSelected.has(sid)) {
    exportModalSelected.delete(sid);
  } else {
    exportModalSelected.add(sid);
  }
  const checkbox = rowEl.querySelector('.modal-checkbox');
  checkbox.checked = exportModalSelected.has(sid);
  rowEl.classList.toggle('selected', exportModalSelected.has(sid));
  updateModalCount();
}

function exportModalToggleAll(selectAll) {
  if (selectAll) {
    exportModalSelected = new Set(sessions.map(s => s.id));
  } else {
    exportModalSelected.clear();
  }
  document.querySelectorAll('#modal-session-list .modal-session-row').forEach(row => {
    const sid = row.dataset.sid;
    const checkbox = row.querySelector('.modal-checkbox');
    checkbox.checked = exportModalSelected.has(sid);
    row.classList.toggle('selected', exportModalSelected.has(sid));
  });
  updateModalCount();
}

function updateModalCount() {
  const total = sessions.length;
  const selected = exportModalSelected.size;
  document.getElementById('modal-selected-count').textContent = `已选 ${selected} / ${total}`;
  document.getElementById('modal-export-btn').disabled = selected === 0;
}

function closeExportModal() {
  document.getElementById('export-modal').style.display = 'none';
  exportModalSelected.clear();
}

// Esc key closes modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('export-modal');
    if (modal.style.display !== 'none') {
      closeExportModal();
      e.stopPropagation();
    }
  }
});

function confirmExport() {
  if (exportModalSelected.size === 0) return;
  const selectedIds = new Set(exportModalSelected);
  closeExportModal();
  exportHTML(selectedIds);
}

// ══════════════════════════════════════════════════════════════════════════════
// Export HTML
// ══════════════════════════════════════════════════════════════════════════════

function exportHTML(selectedIds = null) {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';

  let sidsInExport;
  if (selectedIds) {
    sidsInExport = selectedIds;
  } else {
    sidsInExport = new Set();
    for (const item of visibleItems) {
      if (item.sessionID) sidsInExport.add(item.sessionID);
    }
  }
  const exportSessions = [];
  for (const sid of sidsInExport) {
    const s = sessionsMap.get(sid);
    if (s) exportSessions.push(s);
  }
  exportSessions.sort((a, b) => (a.colorRank || 0) - (b.colorRank || 0));

  let sessionListHTML = '';
  if (exportSessions.length > 0) {
    const items = exportSessions.map(s => {
      const color = idColor(s.colorRank || 0);
      const project = folderName(s.realCwd || s.projectPath) || s.realCwd || s.projectPath || '';
      const model = s.model || '';
      return `<div class="export-session-item" data-sid="${esc(s.id)}" onclick="filterBySession('${esc(s.id)}')"><div class="export-item-top"><span class="export-project">${esc(project)}</span>${model ? ` <span class="export-model" style="color:var(--dim)">${esc(model)}</span>` : ''}</div><div class="export-item-sid" style="color:${color}">${esc(s.id)}</div></div>`;
    }).join('\n');
    sessionListHTML = `<div class="export-session-list">
<div class="export-session-item export-all-btn active" onclick="filterBySession(null)">全部</div>
${items}
</div>`;
  }

  computeTokensFromContext();
  let tokenHTML = '';
  if (totalInput > 0 || totalOutput > 0) {
    let tokStr = `Input: ${fmtTok(totalInput)} · Output: ${fmtTok(totalOutput)}`;
    if (totalCacheCreate > 0 || totalCacheRead > 0) tokStr += ` · Cache: ${fmtTok(totalCacheCreate)}+${fmtTok(totalCacheRead)}`;
    tokenHTML = `<div class="export-meta-line" style="color:var(--dim)">Tokens: ${tokStr}</div>`;
  }

  const filterState = [];
  if (!showThinking) filterState.push('thinking hidden');
  if (!showToolInput) filterState.push('tools hidden');
  if (!showToolOutput) filterState.push('output hidden');
  if (!showText) filterState.push('text hidden');
  if (!showHook) filterState.push('hook hidden');
  let filterHTML = '';
  if (filterState.length > 0) filterHTML = `<div class="export-meta-line" style="color:var(--dim)">Filters: ${filterState.join(', ')}</div>`;

  const now = new Date();
  const exportTime = fmtTimestamp(now);
  const timeHTML = `<div class="export-meta-line" style="color:var(--dim)">Exported: ${exportTime}</div>`;

  const clone = streamEl.cloneNode(true);
  clone.querySelectorAll('.copy-btn').forEach(el => el.remove());
  clone.querySelectorAll('[onclick]').forEach(el => el.removeAttribute('onclick'));

  if (selectedIds) {
    clone.querySelectorAll('[data-session-id]').forEach(el => {
      if (!selectedIds.has(el.dataset.sessionId)) el.remove();
    });
  }

  const streamHTML = clone.innerHTML;
  const hlCSS = theme === 'dark' ? hljsDarkCSS : hljsLightCSS;

  const exportCSS = `
.export-session-list { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 0; }
.export-session-item { cursor: pointer; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); opacity: 0.7; transition: all 0.15s; font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
.export-session-item:hover { opacity: 1; border-color: var(--dim); }
.export-session-item.active { opacity: 1; border-color: var(--purple); background: var(--purple); color: var(--white); }
.export-all-btn { font-weight: 600; align-items: center; }
.export-item-top { display: flex; align-items: baseline; gap: 4px; }
.export-item-sid { font-family: monospace; font-size: 10px; opacity: 0.8; }
.export-session-item.active .export-item-sid { opacity: 1; color: var(--white); }
.export-project { font-weight: 500; }
.export-model { font-size: 11px; }
.export-meta-line { padding: 2px 0; font-size: 11px; }
.export-header { padding: 12px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 100; }
.export-header h1 { margin: 0 0 4px 0; font-size: 16px; color: var(--white); }
`;

  const exportJS = `
let _activeSid = null;
function filterBySession(sid) {
  _activeSid = sid;
  const lines = document.querySelectorAll('#export-stream [data-session-id]');
  lines.forEach(el => {
    el.style.display = (sid === null || el.dataset.sessionId === sid) ? '' : 'none';
  });
  document.querySelectorAll('.export-session-item[data-sid]').forEach(el => {
    el.classList.toggle('active', sid !== null && el.dataset.sid === sid);
  });
  document.querySelector('.export-all-btn').classList.toggle('active', sid === null);
}
`;

  const htmlAttrs = theme === 'light' ? ' lang="en" data-theme="light"' : ' lang="en"';
  const fullDoc = `<!DOCTYPE html>
<html${htmlAttrs}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>claude-watch Export</title>
<style>
${appCSS}
${hlCSS}
${exportCSS}
</style>
</head>
<body style="overflow-y:auto;height:auto">
<div class="export-header">
<h1>claude-watch Export</h1>
${sessionListHTML}
${tokenHTML}
${filterHTML}
${timeHTML}
</div>
<div id="export-stream" style="padding:8px 12px;font-size:12px">
${streamHTML}
</div>
<script>${exportJS}<\/script>
</body>
</html>`;

  const blob = new Blob([fullDoc], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');

  let filePrefix;
  if (sidsInExport.size === 1) {
    filePrefix = [...sidsInExport][0].split('-')[0].toUpperCase();
  } else {
    filePrefix = 'multi';
  }
  const pad = (n, len) => String(n).padStart(len, '0');
  const ts = `${pad(now.getFullYear(),4)}${pad(now.getMonth()+1,2)}${pad(now.getDate(),2)}-${pad(now.getHours(),2)}${pad(now.getMinutes(),2)}${pad(now.getSeconds(),2)}`;
  a.download = `claude-watch-${filePrefix}-${ts}.html`;
  a.href = url;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const btn = document.getElementById('btn-export');
  const orig = btn.textContent;
  btn.textContent = '✓';
  setTimeout(() => { btn.textContent = orig; }, 2000);
}

// ══════════════════════════════════════════════════════════════════════════════
// Init
// ══════════════════════════════════════════════════════════════════════════════

// Apply saved theme on load (default dark)
(function() {
  const saved = localStorage.getItem('theme');
  applyTheme(saved || 'dark');
})();

// Setup tree panel resize & scroll detection
setupTreeResize();
setupScrollDetection();

// Apply collapse-after from URL param
const urlParams = new URLSearchParams(location.search);
const ca = urlParams.get('collapseAfter');
if (ca) {
  applyCollapsePolicy(parseInt(ca) || 0);
}

// Apply initial tab from URL hash (default: stream)
(function() {
  const hash = location.hash.slice(1);
  if (hash === 'tokens' || hash === 'stream') {
    switchTab(hash);
  }
})();

// Connect WebSocket
connect();
