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

## 2026-05-13

- Feature: 新增 Hook 输出过滤器按钮 (🪝 Hook)，可在工具栏切换 hook_output 的显示/隐藏
- Feature: `MAX_ITEMS` 从 1000 提升到 3000，支持显示更多流式事件
- Change: 会话移除行为从"删除"改为"移至底部"，保留历史数据便于回看
- Change: `CONTEXT_STALE_MS` 从 30 分钟增加到 60 分钟，上下文信息保留更久
- Change: `activeWindow` CLI 默认值从 5 分钟调整为 30 分钟，更贴合实际使用场景
