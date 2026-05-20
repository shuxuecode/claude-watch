# Changelog

## 2026-05-20 (v0.0.13)

- Feature: 右侧数据展示区每条请求标签行（Main » 📤 Bash result 等）右侧新增时间戳显示，格式为 YYYY-MM-DD HH:MM:SS.mmm，使用数据模型中已有的 timestamp 字段

## 2026-05-16 (v0.0.10)

- Feature: 新增 favicon.svg
- Feature: 新增大量测试覆盖 — parser (custom-title, compact_boundary, hook_success, diagnostics, pr_link, model, formatToolInput, prettyToolName, agentDisplayName, formatTokenCount, MAX_TOOL_INPUT_LENGTH), watcher (_populateToolIndex, _lookupAgentType, readAgentType, resolveProjectPath, isMainSessionFile), server (task-output 成功路径, cleanupContextMap, WS handleCommand), CLI (compareVersions, parseDuration, -v/--help/-l/-a/未知选项)
- Feature: 新增 tests/cli.test.js CLI 参数解析测试
- Refactor: 提取 compareVersions/parseDuration 到 src/cli-helpers.js，消除 bin/claude-watch.js、cli.test.js、watcher.test.js 中的重复定义
- Refactor: 删除 watcher 中 _walkDirStatic 冗余包装，直接使用 _walkDirAsync
- Fix: /api/task-output TOCTOU 漏洞 — 改用 realPath 读文件而非原始路径，防止符号链接在检查和读取之间被替换
- Fix: allowedPrefix 也经 realpath 解析，防止 homedir 包含符号链接时合法请求被拒绝
- Fix: killExistingPort 排除 PID 1 和自身进程，防止误杀系统关键进程
- Fix: askYesNo 在非交互终端（CI/daemon）下直接返回 false，避免永久挂起
- Fix: WebSocket handleCommand 输入验证 — removeSession 要求非空 string，setSkipHistory 强制布尔值
- Fix: broadcast 遍历 Set 时不再在循环中修改 Set，先收集再批量删除+terminate
- Fix: handleSessionRemoved splice+push 导致会话永不删除，改为真正 splice + sessionsMap.delete
- Fix: removeSelectedSession 同样的 splice+push bug，改为真正删除 + sessionsMap.delete
- Fix: parsePRLink PR #0 被丢弃（!0 为 true），改为 raw.prNumber == null 只排除 null/undefined
- Fix: formatToolInput Grep undefined pattern 生成 /undefined/，改为 fallback 空字符串
- Fix: agentDisplayName 非字符串类型抛 TypeError，加 String() 转换，null 也返回 'Main'
- Fix: _doPopulateToolIndex 用正则匹配 JSON 字段不健壮，改为 JSON.parse + 遍历 content 数组
- Fix: req.headers.host 可为 undefined（HTTP/1.0），兜底为 'localhost'
- Fix: 4处 process.exit(1) 硬退出前调用 this.stop() 清理定时器/WebSocket/chokidar
- Fix: cli.test.js 硬编码版本号 v0.0.10 改为正则 /v\d+\.\d+\.\d+/ 匹配
- Fix: compareVersions NaN bug — 缺段版本号如 '1.0' 的 NaN 与 0 比较总为 false，改为 (pa[i] || 0)
- Fix: watcher chunk 读取 buf.toString('utf-8') 可能包含旧 buffer 数据，改为 buf.toString('utf-8', 0, bytesRead)
- Fix: 删除 index.html 行 390 悬空的 visibleDirty = true 冗余赋值

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