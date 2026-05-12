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

## 2026-05-13 (fix)

- Fix: 修复自动滚动模式运行一段时间后失效的问题 — 新数据到达但视图不往下滚动
  - `scheduleRender()` 不再总是调用 `renderAll()` 强制全量重建，改为直接调用 `renderTree/renderStream/refreshButtons`，数据到达时走增量追加路径，避免频繁 `innerHTML` 替换导致的滚动位置重置
  - 全量重建路径在 `innerHTML` 之前保存 `autoScroll` 值 (`wasAutoScroll`)，防止布局调整触发的 scroll 事件将 `autoScroll` 翻转为 `false` 后跳过滚动
  - 增量路径滚动条件从 `autoScroll && wasAtBottom` 简化为 `autoScroll`，消除布局变化导致 `wasAtBottom` 为 `false` 但 `autoScroll` 为 `true` 时不滚动的死区
  - `handleSnapshot/handleNewSession/handleNewAgent/handleSessionRemoved` 调用 `updateFilters()` 后设置 `needsFullRender = true`，确保新增可见 item 被全量重建正确渲染
  - `scrollDown()` 补充 `autoScroll = false` 逻辑，与 `scrollUp/scrollToTop` 保持一致
