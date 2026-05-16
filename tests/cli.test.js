'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');
const { compareVersions, parseDuration } = require('../src/cli-helpers');

// ============================================================================
// compareVersions
// ============================================================================

describe('compareVersions', () => {
  it('should return 0 for equal versions', () => {
    assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0);
    assert.strictEqual(compareVersions('0.0.10', '0.0.10'), 0);
  });

  it('should return 1 when a > b', () => {
    assert.strictEqual(compareVersions('2.0.0', '1.0.0'), 1);
    assert.strictEqual(compareVersions('1.1.0', '1.0.0'), 1);
    assert.strictEqual(compareVersions('1.0.1', '1.0.0'), 1);
    assert.strictEqual(compareVersions('0.0.11', '0.0.10'), 1);
  });

  it('should return -1 when a < b', () => {
    assert.strictEqual(compareVersions('1.0.0', '2.0.0'), -1);
    assert.strictEqual(compareVersions('1.0.0', '1.1.0'), -1);
    assert.strictEqual(compareVersions('1.0.0', '1.0.1'), -1);
    assert.strictEqual(compareVersions('0.0.9', '0.0.10'), -1);
  });

  it('should handle versions with different segment counts', () => {
    assert.strictEqual(compareVersions('1.0.0', '1.0'), 0);
    assert.strictEqual(compareVersions('1.0.1', '1.0'), 1);
    assert.strictEqual(compareVersions('1.0', '1.0.1'), -1);
  });
});

// ============================================================================
// parseDuration
// ============================================================================

describe('parseDuration', () => {
  it('should parse milliseconds', () => {
    assert.strictEqual(parseDuration('500ms'), 500);
  });

  it('should parse seconds', () => {
    assert.strictEqual(parseDuration('30s'), 30000);
  });

  it('should parse minutes', () => {
    assert.strictEqual(parseDuration('5m'), 300000);
  });

  it('should parse hours', () => {
    assert.strictEqual(parseDuration('1h'), 3600000);
  });

  it('should throw on invalid duration', () => {
    assert.throws(() => parseDuration('abc'), /Invalid duration/);
    assert.throws(() => parseDuration('10d'), /Invalid duration/);
    assert.throws(() => parseDuration(''), /Invalid duration/);
  });

  it('should handle zero values', () => {
    assert.strictEqual(parseDuration('0ms'), 0);
    assert.strictEqual(parseDuration('0s'), 0);
    assert.strictEqual(parseDuration('0m'), 0);
  });
});

// ============================================================================
// CLI argument parsing via subprocess
// ============================================================================

describe('CLI -v flag', () => {
  it('should print version', () => {
    const result = cp.spawnSync('node', ['bin/claude-watch.js', '-v'], { encoding: 'utf-8' });
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.match(/v\d+\.\d+\.\d+/));
  });
});

describe('CLI --help flag', () => {
  it('should print help text', () => {
    const result = cp.spawnSync('node', ['bin/claude-watch.js', '--help'], { encoding: 'utf-8' });
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('USAGE'));
    assert.ok(result.stdout.includes('OPTIONS'));
    assert.ok(result.stdout.includes('--port'));
  });
});

describe('CLI -l flag (list sessions)', () => {
  it('should list sessions and exit', () => {
    const result = cp.spawnSync('node', ['bin/claude-watch.js', '-l', '1'], { encoding: 'utf-8', timeout: 5000 });
    assert.strictEqual(result.status, 0);
  });
});

describe('CLI -a flag (list active sessions)', () => {
  it('should list active sessions and exit', () => {
    const result = cp.spawnSync('node', ['bin/claude-watch.js', '-a'], { encoding: 'utf-8', timeout: 5000 });
    assert.strictEqual(result.status, 0);
  });
});

describe('CLI unknown option', () => {
  it('should print error and exit with 1', () => {
    const result = cp.spawnSync('node', ['bin/claude-watch.js', '--unknown-flag'], { encoding: 'utf-8' });
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('Unknown option'));
  });
});