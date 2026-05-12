# Changelog

## 2026-05-12

- Fix: inputTokens percentage overflow — changed from cumulative (`+=`) to `Math.max`, since `input_tokens` from Claude API is a total value per call, not incremental
- Fix: server startup race condition — moved `server.listen()` before `openBrowser` and await it, so the browser connects immediately instead of failing and retrying with exponential backoff (1s→2s→4s→8s)
- Fix: changed `activeWindow` default from 5 minutes to 100 minutes, so sessions are not auto-cleaned too aggressively
- src/server/server.js
- src/watcher/watcher.js
- CHANGELOG.md
- public/index.html
- README.md
- README.zh-CN.md
- bin/claude-watch.js
