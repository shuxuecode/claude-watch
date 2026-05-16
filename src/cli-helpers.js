'use strict';

function compareVersions(a, b) {
  var pa = a.split('.').map(Number);
  var pb = b.split('.').map(Number);
  for (var i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function parseDuration(s) {
  var match = s.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) throw new Error('Invalid duration: ' + s);
  var val = parseInt(match[1], 10);
  switch (match[2]) {
    case 'ms': return val;
    case 's': return val * 1000;
    case 'm': return val * 60 * 1000;
    case 'h': return val * 3600 * 1000;
    default: throw new Error('Invalid duration unit: ' + match[2]);
  }
}

module.exports = { compareVersions, parseDuration };