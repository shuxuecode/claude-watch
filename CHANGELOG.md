# Changelog

## 2026-05-12 (v0.0.8)

- Fix: inputTokens percentage overflow — changed from cumulative (`+=`) to `Math.max`, since `input_tokens` from Claude API is a total value per call, not incremental
- Fix: server startup race condition — moved `server.listen()` before `openBrowser` and await it, so the browser connects immediately instead of failing and retrying with exponential backoff
- Fix: changed `activeWindow` default from 5 minutes to 100 minutes, so sessions are not auto-cleaned too aggressively

## 2026-05-13

- Feature: 新增 Hook 输出过滤器按钮 (🪝 Hook)，可在工具栏切换 hook_output 的显示/隐藏
- Feature: `MAX_ITEMS` 从 1000 提升到 3000，支持显示更多流式事件
- Change: 会话移除行为从"删除"改为"移至底部"，保留历史数据便于回看
- Change: `CONTEXT_STALE_MS` 从 30 分钟增加到 60 分钟，上下文信息保留更久
- Change: `activeWindow` CLI 默认值从 5 分钟调整为 30 分钟，更贴合实际使用场景

## 2026-05-13 (v0.0.9)

- Fix: 服务端添加 WebSocket 心跳机制，每 30 秒向所有客户端发送 heartbeat 消息，防止健康连接因无活动数据而被 45 秒超时误断
- Fix: seenToolIDs 和 toolNameMap 从 FIFO 批量淘汰改为 LRU 缓存策略，避免最近活跃的 tool ID 被淘汰后其 tool_output 重复显示
- Fix: killExistingPort 从直接 SIGKILL 改为先 SIGTERM 等待 3 秒再升级 SIGKILL，允许旧进程优雅关闭
- Fix: watcher 中所有同步 FS 调用（statSync/readdirSync/accessSync/existsSync）改为异步版本（fsp.stat/fsp.readdir/fsp.access），避免阻塞事件循环
- Fix: formatToolInput 添加 5000 字符截断上限，防止未知工具或 JSON.stringify 产生巨量 content 字符串
- Fix: parser 中所有 makeItem 调用补上 timestamp 字段，之前 thinking/text/tool_input/tool_output 等条目的 timestamp 全为 0
- Fix: watcher _readFile 检测到文件截断（pos > stats.size）时重置位置为 0，而非永久停止读取
- Fix: watcher _populateToolIndex 并发竞争 — 将 toolIndexPopulated flag 移到填充完成后设置，并发调用者通过 _toolIndexPromise 等待同一填充过程而非查询不完整索引
- Fix: 修复自动滚动模式运行一段时间后失效的问题 — 新数据到达但视图不往下滚动
- Perf: watcher _readFile 从一次性分配整个未读内容的大 Buffer 改为 64KB 分块读取，避免断连重连后内存尖峰
- Perf: server item 广播从逐条发送改为 50ms 间隔批量发送 itemBatch，降低高频场景下 WebSocket 消息开销
- Perf: 前端 streamItems.filter(isItemVisible) 从每帧全量扫描改为增量维护 visibleItems 数组，仅在 filter/toggle 变化时重建