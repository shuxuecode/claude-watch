// ══════════════════════════════════════════════════════════════════════════════
// token.js — Token Statistics page
// ══════════════════════════════════════════════════════════════════════════════

// ── Token State ──
let tokenStatsData = { totals: { messages: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, days: 0 }, modelTotals: {}, daily: {}, hourly: [] };
let tokenStatsRendered = false;
let tsDetailTab = 'daily';

// ══════════════════════════════════════════════════════════════════════════════
// WebSocket handler
// ══════════════════════════════════════════════════════════════════════════════

function handleTokenStats(payload) {
  tokenStatsData = payload;
  // Only render on first load; subsequent updates require manual refresh
  if (!tokenStatsRendered && currentTab === 'tokens' && payload.totals.messages > 0) {
    tokenStatsRendered = true;
    renderTokenPage();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab switching & refresh
// ══════════════════════════════════════════════════════════════════════════════

function tsSwitchDetail(n) {
  tsDetailTab = n;
  document.querySelectorAll('.tp-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tp-tc').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tp-tab[data-tab="${n}"]`)?.classList.add('active');
  document.getElementById('tp-tc-' + n)?.classList.add('active');
}

function refreshTokenStats() {
  const btn = document.getElementById('btn-refresh-tokens');
  const info = document.getElementById('tp-refresh-info');
  if (btn) btn.disabled = true;
  if (info) info.textContent = '正在刷新...';
  fetch('/api/token-stats')
    .then(r => r.json())
    .then(data => {
      tokenStatsData = data;
      tokenStatsRendered = true;
      renderTokenPage();
      if (info) {
        const now = new Date();
        info.textContent = '上次刷新: ' + now.toLocaleTimeString();
      }
    })
    .catch(err => {
      if (info) info.textContent = '刷新失败: ' + err.message;
    })
    .finally(() => {
      if (btn) btn.disabled = false;
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// Chart builders
// ══════════════════════════════════════════════════════════════════════════════

// ── Heatmap: 52-week × 7-day GitHub-style grid ──
function buildHeatmap(daily) {
  const today = new Date();
  const dailyTotalsMap = {};
  for (const [k, d] of Object.entries(daily)) {
    dailyTotalsMap[k] = d.input + d.output + d.cacheCreation + d.cacheRead;
  }

  const startSunday = new Date(today);
  startSunday.setDate(startSunday.getDate() - startSunday.getDay() - 52 * 7);
  const startStr = fmtDateISO(startSunday);

  let maxVal = 0;
  for (const [k, v] of Object.entries(dailyTotalsMap)) {
    if (k >= startStr && v > maxVal) maxVal = v;
  }

  const weeks = [];
  const monthLabels = [];
  let lastMonth = -1;
  let currentSunday = new Date(startSunday);

  for (let w = 0; w < 53; w++) {
    const weekData = [];
    for (let dow = 0; dow < 7; dow++) {
      const d = new Date(currentSunday);
      d.setDate(d.getDate() + dow);
      const ds = fmtDateISO(d);
      const val = dailyTotalsMap[ds] || 0;
      weekData.push({ date: ds, val, future: d > today });
      if (dow === 0) {
        const m = d.getMonth();
        if (m !== lastMonth) { monthLabels.push({ month: m, week: w }); lastMonth = m; }
      }
    }
    weeks.push(weekData);
    currentSunday.setDate(currentSunday.getDate() + 7);
  }

  function cellColor(val, future) {
    if (future) return 'var(--bg3)';
    if (val === 0) return '#0d423d';
    const pct = maxVal > 0 ? val / maxVal : 0;
    if (pct < 0.25) return '#0e6b5a';
    if (pct < 0.5) return '#12b886';
    if (pct < 0.75) return '#34d399';
    return '#6ee7b7';
  }

  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthsParts = ['<div class="tp-hm-months">'];
  let prevWeek = 0;
  for (const ml of monthLabels) {
    const offset = ml.week - prevWeek;
    if (offset > 0) monthsParts.push(`<span style="width:${offset * 14}px"></span>`);
    monthsParts.push(`<span style="width:14px">${monthNames[ml.month]}</span>`);
    prevWeek = ml.week + 1;
  }
  monthsParts.push('</div>');
  const monthsHTML = monthsParts.join('');

  const dayLabels = ['','Mon','','Wed','','Fri',''];
  const gridParts = [];
  for (let dow = 0; dow < 7; dow++) {
    gridParts.push(`<div class="tp-hm-row"><span class="tp-hm-day-label">${dayLabels[dow]}</span>`);
    for (let w = 0; w < weeks.length; w++) {
      const cell = weeks[w][dow];
      const bg = cellColor(cell.val, cell.future);
      const tip = `${cell.date} · ${fmtTS(cell.val)} tokens`;
      gridParts.push(`<span class="tp-hm-cell" style="background:${bg}" title="${tip}"></span>`);
    }
    gridParts.push('</div>');
  }
  const gridHTML = gridParts.join('');

  const legendHTML = '<div class="tp-hm-legend"><span>少 Less</span>'
    + '<span class="tp-hm-legend-cell" style="background:#0d423d"></span>'
    + '<span class="tp-hm-legend-cell" style="background:#0e6b5a"></span>'
    + '<span class="tp-hm-legend-cell" style="background:#12b886"></span>'
    + '<span class="tp-hm-legend-cell" style="background:#34d399"></span>'
    + '<span class="tp-hm-legend-cell" style="background:#6ee7b7"></span>'
    + '<span>多 More</span></div>';

  return `<div class="tp-heatmap"><div class="tp-heatmap-inner">${monthsHTML}${gridHTML}</div>${legendHTML}</div>`;
}

// ── Trend: bar chart for last 30 days ──
function buildTrend(daily) {
  const keys = Object.keys(daily).sort();
  const recentKeys = keys.slice(-30);
  if (recentKeys.length === 0) return '<div style="color:var(--dim);padding:8px">暂无趋势数据</div>';

  const values = recentKeys.map(k => {
    const d = daily[k];
    return d.input + d.output + d.cacheCreation + d.cacheRead;
  });
  const maxVal = Math.max(...values);

  let barsHTML = '';
  for (let i = 0; i < recentKeys.length; i++) {
    const k = recentKeys[i];
    const v = values[i];
    const pct = maxVal > 0 ? (v / maxVal * 100) : 0;
    const label = k.slice(5);
    const tip = `${k}: ${fmtTS(v)}`;
    const color = pct < 30 ? '#0e6b5a' : pct < 60 ? '#12b886' : pct < 80 ? '#34d399' : '#6ee7b7';
    barsHTML += `<div class="tp-trend-bar-wrap"><div class="tp-trend-bar-area"><div class="tp-trend-bar" style="height:${Math.max(pct, 3)}%;background:${color}" data-tip="${esc(tip)}"></div></div><span class="tp-trend-label">${esc(label)}</span></div>`;
  }

  const gridLines = `<div class="tp-trend-grid-lines">
    <div class="tp-trend-grid-line"></div>
    <div class="tp-trend-grid-line"></div>
    <div class="tp-trend-grid-line"></div>
    <div class="tp-trend-grid-line"></div>
  </div>`;
  const yAxis = `<div class="tp-y-axis"><span>${fmtTS(maxVal)}</span><span>${fmtTS(Math.round(maxVal * 0.5))}</span><span>0</span></div>`;

  return `<div class="tp-chart-with-axis">${yAxis}<div class="tp-trend-bars">${gridLines}${barsHTML}</div></div>`;
}

// ── Model ranking sidebar ──
function buildModelRank(mt, totalAll) {
  const sorted = Object.entries(mt).sort((a, b) => {
    const sA = a[1].input + a[1].output + a[1].cacheCreation + a[1].cacheRead;
    const sB = b[1].input + b[1].output + b[1].cacheCreation + b[1].cacheRead;
    return sB - sA;
  });

  let html = '<div class="tp-rank-title">🏆 模型排名 Model Ranking</div>';
  for (let i = 0; i < Math.min(sorted.length, 5); i++) {
    const [name, m] = sorted[i];
    const mTotal = m.input + m.output + m.cacheCreation + m.cacheRead;
    const pct = totalAll > 0 ? (mTotal / totalAll * 100).toFixed(1) : '0';
    const c = modelColor(name);
    html += `<div class="tp-rank-item">
      <span class="tp-rank-num">${i + 1}</span>
      <span class="tp-rank-dot" style="background:${c}"></span>
      <span class="tp-rank-name">${esc(name)}</span>
      <span class="tp-rank-pct">${pct}%</span>
    </div>`;
  }
  return html;
}

// ── Bar chart for weekly/monthly token consumption ──

function buildStackedChart(dailyKeys, daily, type) {
  const title = type === 'weekly' ? '📊 周 Token 消耗 Weekly Token Consumption' : '📊 月 Token 消耗 Monthly Token Consumption';
  let periods;
  if (type === 'weekly') {
    periods = aggregateWeekly(dailyKeys, daily);
  } else {
    periods = aggregateMonthly(dailyKeys, daily);
  }

  const periodKeys = Object.keys(periods).sort();
  if (periodKeys.length === 0) return `<div class="tp-chart-title">${title}</div><div style="color:var(--dim);padding:8px">暂无数据</div>`;

  const totals = periodKeys.map(k => {
    const p = periods[k];
    return p.input + p.output + p.cacheCreation + p.cacheRead;
  });
  const maxTotal = Math.max(...totals);
  const chartMax = maxTotal / 0.72;

  let barsHTML = '';
  for (let i = 0; i < periodKeys.length; i++) {
    const k = periodKeys[i];
    const total = totals[i];
    const pct = chartMax > 0 ? (total / chartMax * 100) : 0;
    const label = type === 'weekly' ? k.slice(5) : k.slice(2);
    const tip = `${k}: ${fmtTS(total)} tokens`;
    barsHTML += `<div class="tp-stack-wrap"><div class="tp-stack-bar-area"><div class="tp-stack-bar-group" data-tip="${esc(tip)}"><div class="tp-stack-seg" style="height:${Math.max(pct, 1)}%;background:#58a6ff"></div></div></div><span class="tp-stack-label">${esc(label)}</span></div>`;
  }

  let gridHTML = '<div class="tp-stack-grid">';
  gridHTML += '<div class="tp-stack-grid-line"></div>';
  gridHTML += '<div class="tp-stack-grid-line"></div>';
  gridHTML += '<div class="tp-stack-grid-line"></div>';
  gridHTML += '<div class="tp-stack-grid-line"></div>';
  gridHTML += '</div>';
  const yAxis = `<div class="tp-y-axis"><span>${fmtTS(Math.round(chartMax))}</span><span>${fmtTS(Math.round(chartMax * 0.5))}</span><span>0</span></div>`;

  return `<div class="tp-chart-title">${title}</div><div class="tp-chart-with-axis">${yAxis}<div class="tp-stack-bars">${gridHTML}${barsHTML}</div></div>`;
}

// ── Model proportion doughnut chart ──
function buildModelPie(mt, totalAll) {
  const title = '🤖 模型 Token 占比 Model Token Proportion';
  if (totalAll === 0) return `<div class="tp-chart-title">${title}</div><div style="color:var(--dim);padding:8px">暂无数据</div>`;

  const sorted = Object.entries(mt).sort((a, b) => {
    const sA = a[1].input + a[1].output + a[1].cacheCreation + a[1].cacheRead;
    const sB = b[1].input + b[1].output + b[1].cacheCreation + b[1].cacheRead;
    return sB - sA;
  });

  let gradParts = '';
  let legendHTML = '';
  let currentDeg = 0;

  for (let i = 0; i < sorted.length; i++) {
    const [name, m] = sorted[i];
    const mTotal = m.input + m.output + m.cacheCreation + m.cacheRead;
    const pct = totalAll > 0 ? (mTotal / totalAll * 100) : 0;
    const nextDeg = currentDeg + pct * 3.6;
    const c = modelColor(name);
    gradParts += `${c} ${currentDeg.toFixed(2)}deg ${nextDeg.toFixed(2)}deg`;
    if (i < sorted.length - 1) gradParts += ', ';
    currentDeg = nextDeg;
  }

  if (currentDeg < 360) {
    gradParts += `, var(--bg3) ${currentDeg.toFixed(2)}deg 360deg`;
  }

  for (let i = 0; i < sorted.length; i++) {
    const [name, m] = sorted[i];
    const mTotal = m.input + m.output + m.cacheCreation + m.cacheRead;
    const pct = totalAll > 0 ? (mTotal / totalAll * 100).toFixed(1) : '0';
    const c = modelColor(name);
    legendHTML += `<div class="tp-pie-legend-item"><span class="tp-pie-dot" style="background:${c}"></span><span class="tp-pie-name">${esc(name)}</span><span class="tp-pie-pct">${pct}%</span></div>`;
  }

  const modelsCount = sorted.length;

  return `<div class="tp-chart-title">${title}</div>
<div class="tp-pie-wrap">
  <div class="tp-pie-ring" style="background:conic-gradient(${gradParts})">
    <div class="tp-pie-hole">
      <div class="tp-pie-hole-v">${modelsCount}</div>
      <div class="tp-pie-hole-l">模型 models</div>
    </div>
  </div>
  <div class="tp-pie-legend">${legendHTML}</div>
</div>`;
}

// ── Hourly distribution chart ──
function buildHourlyChart(hourly) {
  const title = '⏰ 活跃时段分布 Active Time Distribution';
  if (!hourly || hourly.length === 0 || hourly.every(v => v === 0)) return `<div class="tp-chart-title">${title}</div><div style="color:var(--dim);padding:8px">暂无数据</div>`;

  const maxCalls = Math.max(...hourly);

  let barsHTML = '';
  for (let h = 0; h < 24; h++) {
    const calls = hourly[h] || 0;
    const pct = maxCalls > 0 ? (calls / maxCalls * 100) : 0;
    const color = pct < 30 ? 'rgba(16,185,129,0.25)' : pct < 60 ? 'rgba(16,185,129,0.5)' : pct < 80 ? 'rgba(16,185,129,0.75)' : 'rgb(16,185,129)';
    const borderColor = 'rgb(16,185,129)';
    const tip = `${h}:00 · ${calls.toLocaleString()} 次调用 calls`;
    barsHTML += `<div class="tp-hourly-bar-wrap"><div class="tp-hourly-bar-area"><div class="tp-hourly-bar" style="height:${Math.max(pct, 2)}%;background:${color};border:1px solid ${borderColor}" data-tip="${esc(tip)}"></div></div><span class="tp-hourly-label">${h}</span></div>`;
  }

  let gridHTML = '<div class="tp-hourly-grid">';
  gridHTML += `<span style="font-size:9px;color:var(--dim);align-self:flex-start">${maxCalls.toLocaleString()}</span>`;
  gridHTML += '<div style="border-top:1px dashed var(--border);opacity:0.3"></div>';
  gridHTML += `<span style="font-size:9px;color:var(--dim);align-self:flex-end">0</span>`;
  gridHTML += '</div>';

  const totalCalls = hourly.reduce((a, b) => a + b, 0);
  const peakHour = hourly.indexOf(maxCalls);

  return `<div class="tp-chart-title">${title}</div>
<div style="display:flex;gap:12px;margin-bottom:6px;font-size:10px;color:var(--dim)">
  <span>总调用 Total calls: <b style="color:var(--white)">${totalCalls.toLocaleString()}</b></span>
  <span>峰值 Peak: <b style="color:var(--white)">${peakHour}:00</b> (${maxCalls.toLocaleString()} calls)</span>
</div>
<div class="tp-hourly-bars">${gridHTML}${barsHTML}</div>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// Detail table
// ══════════════════════════════════════════════════════════════════════════════

var _tsSortState = {};

function renderPeriodTable(keys, data, type) {
  const sorted = keys.sort((a, b) => b.localeCompare(a));
  const rowData = sorted.map(k => {
    const d = data[k];
    const total = d.input + d.output + d.cacheCreation + d.cacheRead;
    const label = type === 'daily' ? k : type === 'monthly' ? k : k + '<br><small style="color:var(--dim)">' + esc(d.dateRange || '') + '</small>';
    const modelsHtml = Object.entries(d.models).sort((a, b) => {
      const sA = a[1].input + a[1].output + a[1].cacheCreation + a[1].cacheRead;
      const sB = b[1].input + b[1].output + b[1].cacheCreation + b[1].cacheRead;
      return sB - sA;
    }).slice(0, 4).map(([mn, m]) => {
      const mT = m.input + m.output + m.cacheCreation + m.cacheRead;
      const c = modelColor(mn);
      return `<span class="tp-mtag" style="background:${c}20;border-color:${c};color:${c}">${esc(mn)}: ${fmtTS(mT)}</span>`;
    }).join(' ');
    return { key: k, total, input: d.input, output: d.output, cacheRead: d.cacheRead, cacheCreation: d.cacheCreation, messages: d.messages, label, modelsHtml };
  });

  const prev = _tsSortState[type];
  _tsSortState[type] = { rows: rowData, col: prev && prev.col, asc: prev && prev.asc };
  if (_tsSortState[type].col) {
    const col = _tsSortState[type].col, asc = _tsSortState[type].asc;
    const cmp = col === 'key'
      ? (a, b) => asc ? a.key.localeCompare(b.key) : b.key.localeCompare(a.key)
      : (a, b) => asc ? a[col] - b[col] : b[col] - a[col];
    rowData.sort(cmp);
  }
  return _buildTableHTML(rowData, type);
}

function _buildTableHTML(rowData, type) {
  const st = _tsSortState[type] || {};
  const cols = [
    { key: 'key', label: '日期 Date' },
    { key: 'total', label: '总计 Total' },
    { key: 'input', label: '输入 Input' },
    { key: 'output', label: '输出 Output' },
    { key: 'cacheRead', label: '缓存读取 Cache Read' },
    { key: 'cacheCreation', label: '缓存创建 Cache Create' },
    { key: 'messages', label: '消息数 Messages' },
  ];
  const ths = cols.map(c => {
    let arrow = ' ⇅';
    if (st.col === c.key) arrow = st.asc ? ' ↑' : ' ↓';
    return `<th class="tp-sortable" onclick="tsSort('${type}','${c.key}')">${c.label}${arrow}</th>`;
  }).join('') + '<th>模型 Models</th>';

  const rows = rowData.map(r =>
    `<tr><td>${r.label}</td><td><b>${fmtTS(r.total)}</b></td><td>${fmtTS(r.input)}</td><td>${fmtTS(r.output)}</td><td>${fmtTS(r.cacheRead)}</td><td>${fmtTS(r.cacheCreation)}</td><td>${r.messages.toLocaleString()}</td><td class="tp-mbreak">${r.modelsHtml}</td></tr>`
  ).join('');

  return `<table class="tp-table"><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
}

function tsSort(type, col) {
  const st = _tsSortState[type];
  if (!st) return;
  if (st.col === col) { st.asc = !st.asc; } else { st.col = col; st.asc = col === 'key'; }
  const cmp = col === 'key'
    ? (a, b) => st.asc ? a.key.localeCompare(b.key) : b.key.localeCompare(a.key)
    : (a, b) => st.asc ? a[col] - b[col] : b[col] - a[col];
  st.rows.sort(cmp);
  document.getElementById('tp-' + type + '-table').innerHTML = _buildTableHTML(st.rows, type);
}

// ══════════════════════════════════════════════════════════════════════════════
// Render entire token page
// ══════════════════════════════════════════════════════════════════════════════

function renderTokenPage() {
  _modelColorIdx = 0;
  const t = tokenStatsData.totals;
  const mt = tokenStatsData.modelTotals;
  const daily = tokenStatsData.daily;
  const totalAll = t.input + t.output + t.cacheCreation + t.cacheRead;

  if (totalAll === 0) {
    document.getElementById('tp-total-card').innerHTML = '<div style="color:var(--dim);padding:8px">暂无历史 Token 数据</div>';
    document.getElementById('tp-stats-grid').innerHTML = '';
    document.getElementById('tp-model-rank').innerHTML = '';
    document.getElementById('tp-trend-card').innerHTML = '';
    document.getElementById('tp-heatmap-card').innerHTML = '';
    document.getElementById('tp-weekly-chart').innerHTML = '';
    document.getElementById('tp-monthly-chart').innerHTML = '';
    document.getElementById('tp-model-pie').innerHTML = '';
    document.getElementById('tp-hourly-chart').innerHTML = '';
    document.getElementById('tp-detail-tabs').innerHTML = '';
    document.getElementById('tp-daily-table').innerHTML = '';
    document.getElementById('tp-weekly-table').innerHTML = '';
    document.getElementById('tp-monthly-table').innerHTML = '';
    return;
  }

  const inputPct = totalAll > 0 ? (t.input / totalAll * 100).toFixed(1) : '0';
  const outputPct = totalAll > 0 ? (t.output / totalAll * 100).toFixed(1) : '0';
  const crPct = totalAll > 0 ? (t.cacheRead / totalAll * 100).toFixed(1) : '0';
  const ccPct = totalAll > 0 ? (t.cacheCreation / totalAll * 100).toFixed(1) : '0';
  const dailyAvg = t.days > 0 ? Math.round(totalAll / t.days).toLocaleString() : '—';

  // Compute last 7 / 30 days totals
  const today = new Date();
  const cutoff7 = fmtDateISO(new Date(today.getTime() - 7 * 86400000));
  const cutoff30 = fmtDateISO(new Date(today.getTime() - 30 * 86400000));
  let last7 = 0, last30 = 0;
  for (const [k, d] of Object.entries(daily)) {
    const v = d.input + d.output + d.cacheCreation + d.cacheRead;
    if (k >= cutoff7) last7 += v;
    if (k >= cutoff30) last30 += v;
  }

  // 1. Total tokens card
  document.getElementById('tp-total-card').innerHTML = `
    <div class="tp-total-label">总用量 TOTAL TOKENS</div>
    <div class="tp-total-value">${fmtTS(totalAll)}</div>
    <div class="tp-footer-stats">
      <span>开始 Started <span class="tp-fv">${Object.keys(daily).sort()[0] || '—'}</span></span>
      <span>活跃 Active <span class="tp-fv">${t.days} 天 DAY</span></span>
      <span>模型 Models <span class="tp-fv">${Object.keys(mt).length}</span></span>
    </div>
    <div class="tp-recent-stats">
      <div class="tp-recent"><span class="tp-recent-label">最近 7 天 Last 7 Days</span><span class="tp-recent-value">${fmtTS(last7)}</span></div>
      <div class="tp-recent"><span class="tp-recent-label">最近 30 天 Last 30 Days</span><span class="tp-recent-value">${fmtTS(last30)}</span></div>
    </div>`;

  // 2. Stats grid
  const stats = [
    { l: '输入 Input', v: fmtTS(t.input), s: inputPct + '%' },
    { l: '输出 Output', v: fmtTS(t.output), s: outputPct + '%' },
    { l: '缓存读取 Cache Read', v: fmtTS(t.cacheRead), s: crPct + '%' },
    { l: '缓存创建 Cache Create', v: fmtTS(t.cacheCreation), s: ccPct + '%' },
    { l: '消息 Messages', v: fmtTS(t.messages), s: t.messages.toLocaleString() },
    { l: '日平均 Daily Avg', v: dailyAvg, s: 'tokens/天' },
  ];
  document.getElementById('tp-stats-grid').innerHTML = `<div class="tp-stat-grid">${stats.map(s => `<div class="tp-stat"><div class="tp-s-l">${s.l}</div><div class="tp-s-v">${s.v}</div><div style="font-size:9px;color:var(--dim)">${s.s}</div></div>`).join('')}</div>`;

  // 3. Model ranking
  document.getElementById('tp-model-rank').innerHTML = buildModelRank(mt, totalAll);

  // 4. Usage Trend
  const dailyKeys = Object.keys(daily);
  document.getElementById('tp-trend-card').innerHTML = `<div class="tp-h3">📊 使用趋势 Usage Trend <span style="font-size:11px;font-weight:normal;color:var(--dim)">最近 30 天 Last 30 Days</span></div>${buildTrend(daily)}`;

  // 5. Activity Heatmap
  const tzOffset = -(new Date().getTimezoneOffset() / 60);
  document.getElementById('tp-heatmap-card').innerHTML = `<div class="tp-h3">🗓 活跃热力图 Activity Heatmap</div><span style="font-size:10px;color:var(--dim);float:right">UTC+${tzOffset.toFixed(0)}</span>${buildHeatmap(daily)}`;

  // 6. Charts: Weekly, Monthly, Model Pie, Hourly
  document.getElementById('tp-weekly-chart').innerHTML = buildStackedChart(dailyKeys, daily, 'weekly');
  document.getElementById('tp-monthly-chart').innerHTML = buildStackedChart(dailyKeys, daily, 'monthly');
  document.getElementById('tp-model-pie').innerHTML = buildModelPie(mt, totalAll);
  document.getElementById('tp-hourly-chart').innerHTML = buildHourlyChart(tokenStatsData.hourly || []);

  // 7. Detail tabs
  const weeklyCount = weeklyKeysFromDaily(dailyKeys).length;
  const monthlyCount = monthlyKeysFromDaily(dailyKeys).length;
  document.getElementById('tp-detail-tabs').innerHTML = `<div class="tp-tab ${tsDetailTab === 'daily' ? 'active' : ''}" data-tab="daily" onclick="tsSwitchDetail('daily')">每日明细 Daily Breakdown (${dailyKeys.length})</div><div class="tp-tab ${tsDetailTab === 'weekly' ? 'active' : ''}" data-tab="weekly" onclick="tsSwitchDetail('weekly')">每周 Weekly (${weeklyCount})</div><div class="tp-tab ${tsDetailTab === 'monthly' ? 'active' : ''}" data-tab="monthly" onclick="tsSwitchDetail('monthly')">每月 Monthly (${monthlyCount})</div>`;
  document.querySelectorAll('.tp-tc').forEach(tc => tc.classList.remove('active'));
  document.getElementById('tp-tc-' + tsDetailTab)?.classList.add('active');

  document.getElementById('tp-daily-table').innerHTML = renderPeriodTable(dailyKeys, daily, 'daily');
  const weekly = aggregateWeekly(dailyKeys, daily);
  document.getElementById('tp-weekly-table').innerHTML = renderPeriodTable(Object.keys(weekly), weekly, 'weekly');
  const monthly = aggregateMonthly(dailyKeys, daily);
  document.getElementById('tp-monthly-table').innerHTML = renderPeriodTable(Object.keys(monthly), monthly, 'monthly');
}

function weeklyKeysFromDaily(keys) {
  const weeks = new Set();
  for (const k of keys) { const d = new Date(k); const wk = getWeekKey(d); weeks.add(wk); }
  return [...weeks];
}

function monthlyKeysFromDaily(keys) {
  const months = new Set();
  for (const k of keys) { months.add(k.slice(0, 7)); }
  return [...months];
}
