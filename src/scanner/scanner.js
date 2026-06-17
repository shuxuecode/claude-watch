'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var readline = require('readline');

// ── Walk directory recursively ──
async function walkDir(dir, callback) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath, callback);
      } else {
        try {
          const stats = await fs.promises.stat(fullPath);
          callback(fullPath, stats);
        } catch { /* skip */ }
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'EACCES') {
      console.error('[scanner] walkDir error on ' + dir + ': ' + err.message);
    }
  }
}

function isJsonlFile(filePath, stats) {
  if (!stats.isFile()) return false;
  return path.extname(filePath) === '.jsonl';
}

// ── Get Claude projects directory ──
function getClaudeDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Full-scan all JSONL files under ~/.claude/projects,
 * extract token usage data, aggregate by date.
 * Returns a Map: "YYYY-MM-DD" → { messages, input, output, cacheCreation, cacheRead, models: { modelName: { ... } } }
 */
async function fullScanTokenUsage(progressCallback) {
  const claudeDir = getClaudeDir();
  const dailyStats = new Map();
  // Hourly aggregation: 24-hour distribution of API calls (local timezone)
  const hourlyStats = new Array(24).fill(0);

  // Collect all JSONL files (main + subagent)
  const jsonlFiles = [];
  await walkDir(claudeDir, (filePath, stats) => {
    if (isJsonlFile(filePath, stats)) {
      jsonlFiles.push(filePath);
    }
  });

  if (progressCallback) progressCallback(0, jsonlFiles.length);

  // Process files in concurrent batches for faster startup
  const SCAN_BATCH_SIZE = 8;
  for (let i = 0; i < jsonlFiles.length; i += SCAN_BATCH_SIZE) {
    const batch = jsonlFiles.slice(i, i + SCAN_BATCH_SIZE);
    await Promise.all(batch.map(f => scanOneFile(f, dailyStats, hourlyStats)));
    const done = Math.min(i + SCAN_BATCH_SIZE, jsonlFiles.length);
    if (progressCallback && (done % 50 < SCAN_BATCH_SIZE || done === jsonlFiles.length)) {
      progressCallback(done, jsonlFiles.length);
    }
  }

  return { dailyStats, hourlyStats };
}

async function scanOneFile(filePath, dailyStats, hourlyStats) {
  let input, rl;
  try {
    input = fs.createReadStream(filePath, { encoding: 'utf-8' });
    rl = readline.createInterface({ input, crlfDelay: Infinity });
  } catch {
    return;
  }

  for await (const line of rl) {
    // Fast pre-filter: only parse lines containing "usage"
    if (!line.includes('"usage"')) continue;
    // Also need model for per-model breakdown
    const hasModel = line.includes('"model"');

    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    const msg = raw.message;
    if (!msg) continue;

    // Extract timestamp — required for date-based and hour-based aggregation
    let ts;
    if (raw.timestamp) {
      ts = new Date(raw.timestamp);
    }
    if (!raw.timestamp || isNaN(ts.getTime())) {
      // Skip lines without valid timestamps — can't determine which day/hour they belong to
      continue;
    }
    const dateStr = ts.getFullYear() + '-' + String(ts.getMonth() + 1).padStart(2, '0') + '-' + String(ts.getDate()).padStart(2, '0');
    const hour = ts.getHours();

    // Extract usage
    const usage = msg.usage;
    if (!usage) continue;

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
    const cacheReadTokens = usage.cache_read_input_tokens || 0;

    if (!inputTokens && !outputTokens && !cacheCreationTokens && !cacheReadTokens) continue;

    // Get or create day entry
    let day = dailyStats.get(dateStr);
    if (!day) {
      day = { messages: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, models: {} };
      dailyStats.set(dateStr, day);
    }

    day.messages++;
    day.input += inputTokens;
    day.output += outputTokens;
    day.cacheCreation += cacheCreationTokens;
    day.cacheRead += cacheReadTokens;

    // Hourly distribution (API calls count)
    hourlyStats[hour]++;

    // Per-model breakdown
    const model = (hasModel && msg.model && msg.model !== '<synthetic>') ? msg.model : '';
    if (model) {
      let m = day.models[model];
      if (!m) {
        m = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
        day.models[model] = m;
      }
      m.input += inputTokens;
      m.output += outputTokens;
      m.cacheCreation += cacheCreationTokens;
      m.cacheRead += cacheReadTokens;
    }
  }
}

module.exports = { fullScanTokenUsage, getClaudeDir };
