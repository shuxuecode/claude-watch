# Changelog

## 2026-06-18

### 文档

- Docs: README 添加 `chokidar`、`ws` 依赖版本徽章和语言切换链接，补全 0.3.0 功能说明（Observer 文件夹、Token 统计页面、Hash 路由、主题切换、版本检测等）

## 2026-06-17

### 新功能

- Feature: Observer 会话识别与真实工作目录显示 — 解析 claude-mem observer 会话 JSONL 中的 `<observed_from_primary_session>` 内容，提取被观察主会话的真实 `<working_directory>` 和 `<user_request>`，在左侧树中显示为 `[Observer] {project}`，并在 hover tooltip 中展示完整路径和观察请求
- Feature: `sessionDisplayName()` 统一显示名计算 — `public/js/shared.js` 新增共享函数，Observer 会话自动加 `[Observer]` 前缀，非 observer 会话保持原有优先级（title → folderName → ID 前缀），被 `stream.js` 和 `app.js` 共同使用
- Feature: 左侧树新增 Observer 虚拟文件夹 — 所有 `isObserver=true` 的会话聚合在名为 **Observer** 的文件夹下，支持展开/折叠，不影响原有日期分组与 flat 会话

### Bug 修复

- Fix: Observer 会话被误解码为 `sessions` — 由于 `resolveProjectPath` 把目录名 `.claude-mem` 中的连字符误判为路径分隔符，且 observer 自身的 transcript 位于 `.../observer-sessions/`，导致树面板把 observer 会话显示为无意义的 `sessions`。现在优先使用从 transcript 提取的 `realCwd`，fallback 时才用 projectPath

### 代码改动

- `src/parser/parser.js`：新增 `StreamItemType.OBSERVER_META` 类型、`collectText()` 和 `extractObserverMeta()` 函数，支持从 `queue-operation` / `user` 消息中解析 observer 内容；`parseLine` 新增 `queue-operation` 分支
- `src/watcher/watcher.js`：`Session` 类新增 `realCwd`、`isObserver`、`observedRequest` 字段；`buildSession` 首次扫描 transcript 识别 observer；`_listSessionsFiltered` / `newSession` 广播透传新字段
- `src/server/server.js`：`/status` 和 WebSocket `snapshot` 返回 `realCwd`、`isObserver`、`observedRequest`
- `public/js/stream.js`：`handleSnapshot` / `handleNewSession` 接收并存储 observer 字段；`handleItem` / `handleItemBatch` 动态应用 `observer_meta`；会话行 tooltip 显示完整路径和观察请求；`rebuildNodes()` / `getNodeHTML()` / `treeClick()` 新增 `observer-folder` 虚拟文件夹，聚合所有 Observer 会话
- `public/js/app.js`：顶部 session info 和导出弹窗项目名使用 `realCwd || projectPath`

## 2026-06-15

### 代码重构

- Refactor: 前后端代码分离 — `index.html` 从 2879 行精简为 126 行纯 HTML 结构，内联 CSS 提取到 `css/app.css`，内联 JS 提取到 `js/app.js`
- Refactor: 前端模块化拆分 — 单体 `app.js`（2275 行）拆分为 4 个职责单一的文件：
  - `shared.js`（245 行）— 共享工具函数（LRUCache、esc、fmtTok 等）和共享状态（sessions、filters、contextData 等）
  - `stream.js`（1076 行）— Stream 页面完整逻辑：树形面板、流式渲染、Markdown 渲染、过滤器、滚动检测、拖拽调整
  - `token.js`（474 行）— Token 统计页面完整逻辑：热力图、趋势图、饼图、小时分布图、堆叠图、明细表
  - `app.js`（470 行）— 协调器：WebSocket 连接与消息分发、主题切换、HTML 导出、Tab 切换

### 新功能

- Feature: Hash 路由 — Tab 切换同步更新 URL hash（`#stream`/`#tokens`），支持浏览器前进/后退、刷新保持当前 Tab、直接通过 URL 访问指定页面
- Feature: Token 统计页面标题中文化 — 所有英文标题添加中文翻译，包括：总用量、输入/输出、缓存读取/创建、消息数、日平均、模型排名、使用趋势、活跃热力图、活跃时段分布、每日明细/每周/每月，以及表格表头和图表图例

### Bug 修复

- Fix: 直接访问 `#tokens` URL 时 Token 页面无数据 — `handleTokenStats` 收到 WebSocket 数据后检查当前是否在 Tokens Tab，如果是则自动触发 `renderTokenPage()`，解决数据到达时 Tab 已切换但未渲染的时序问题

## 2026-06-07

### 新功能

- Feature: HTML 导出 — 工具栏新增 💾 导出按钮，可将当前会话流导出为自包含 HTML 文件。导出文件内嵌完整 CSS（页面样式 + highlight.js 主题）、session 列表头部（项目名/模型/session ID）、token 统计、当前 filter 状态、导出时间戳，并支持按 session 点击筛选浏览。文件名格式为 `claude-watch-{PREFIX}-{TIMESTAMP}.html`
- Feature: Stream 渲染行添加 `data-session-id` 属性 — 每条 stream 行（thinking/tool_input/tool_output/text/hook/diagnostics/marker/separator 等）携带所属 session ID，为按 session 过滤和导出筛选提供数据基础

## 2026-06-06

### Bug 修复

- Fix: `resolveProjectPath` 未正确处理 Claude 路径编码中的 `--`（点号编码）— 旧代码 `split('-')` 将 `--` 拆为空元素导致 progressive join 产生含 `//` 的无效路径，fallback naive 转换把所有 `-` 替换为 `/` 产出错误路径如 `Users/claude/`，使得树面板对 `.claude` 等隐藏目录下的会话显示无意义名称（如 "sessions"、"skills"）。修复后采用三层策略：直接解码优先（`--→/.`, `-→/`）；渐进合并兜底（空元素合并为点前缀目录）；fallback 返回直接解码结果。

## 2026-05-28

### 新功能

- Feature: 会话隐藏 — 删除会话时加入 `hiddenSessionIDs` 并持久化到 localStorage（24h 过期），重新打开页面后隐藏的会话不再出现
- Feature: 会话彩色前缀标识 — 每个会话在左侧树和右侧流面板显示彩色 hash 前缀（如 `[1A2B]`），基于 `colorRank` 用 HSL 色轮分配颜色，方便多会话视觉区分
- Feature: 代码块一键复制 — 代码块 header 右侧新增 ⎘ 复制按钮，点击后复制代码内容并在 1.5s 内显示 ✓ 反馈
- Feature: agent/main 节点活跃指示 — 活跃绿点从仅 session 级别细化到 agent/main 级别，main 活跃阈值 10 分钟、agent 活跃阈值 3 分钟
- Feature: snapshot 追加 `lastActivities` — 服务端从 itemBuffer 计算各 agent 最后活动，前端初始化时填充 `agentActivity`，跳过历史模式下也能看到各节点活动描述
- Feature: 活跃会话不进历史文件夹 — 创建日期较早但当前活跃的会话归入 flatSessions（与今日会话并列），不再被折叠进历史日期分组
- Feature: 批量发送阈值 — 新增 `FLUSH_BATCH_LIMIT=50`，pending items 满 50 条立即广播不等 200ms timer，减少高频场景延迟

### Bug 修复

- Fix: CLI `-h` 短选项冲突 — `-h` 原同时用于 `--host` 和 `--help`，改为 `-h` 仅映射 `--help`，`--host` 不再接受短选项
- Fix: 活动窗口默认值不合理 — `-w` 默认值从 5m 改为 24h，与 UI 活跃阈值对齐
- Fix: 自动更新失败静默无反馈 — npm 全局更新 stderr 从 `ignore` 改为 `pipe`，失败时打印 exit code 和 stderr 内容
- Fix: 刷新页面后所有绿点全亮 — session `lastActivity` 改用 item 真实时间戳（`itemTime()`）替代 `Date.now()`，避免页面加载瞬间把所有会话标记为活跃
- Fix: `renderStream` XSS 风险 — CSS class 名也经过 `esc()` 转义，防止恶意 class 注入
- Fix: watcher 文件删除后 debounce timer 泄漏 — unlink 事件中清理对应 `debounceTimers`，防止已删除文件的定时器残留
- Fix: `formatToolInput('Bash')` 空值崩溃 — `inp.command` 加 `|| ''` 空值保护，防止 description 存在但 command 为 undefined 时报错
- Fix: `_countFileLines` 性能瓶颈 — 改为 `_estimateFileLines` 用 `stat.size / 500` 估算，避免逐字节读文件数行数导致历史初始化慢

### 性能优化

- Perf: 树渲染增量更新 — `treeDirty` 标记 + cursor 变化只切换 selected class，不再每次全量重写 `innerHTML`
- Perf: solo/filter 判断加速 — 新增 `visibleFilterCount` 快速判断 solo 状态（O(1) 替代 O(n) 遍历全部 session）
- Perf: 活跃刷新降频 — 15s 定时器从 `rebuildNodes + renderTree` 改为只 `updateTreeDots + refreshButtons`
- Perf: `resolveProjectPath` 缓存 — `_projectPathCache` 避免重复 fs.access 查找
- Perf: `_allowedPrefix` 缓存 — home realpath 只计算一次，不再每次 HTTP 请求都调用
- Perf: watcher 读取循环缓存 `fileSize` — 不再每次 chunk 都调用 `handle.stat()`
- Perf: `seenToolIDs` LRU 扩容 — 从 5000 提升到 20000，减少高频场景下 tool ID 被淘汰
- Refactor: `stripNonUserContent` 合并 5 条 replace 为单条正则
- Refactor: `scheduleTreeRender` 合并到 `scheduleRender`，统一渲染调度

## 2026-05-24

- Feature: Hook 输出新增 `command` 和 `content` 字段展示 — `command:` 显示 hook 执行的命令路径，`content:` 显示 hook stdin 输入（仅在非空且与 stdout 不同时展示），`stdout:` 显示 hook 进程标准输出
- Change: Hook 输出字段名（command/content/stdout）使用灰色（`var(--dim)`），与青色内容区做视觉区分
- Change: parser 新增 `hookContent` 和 `hookCommand` 字段，从 `attachment.content`（stdin）和 `attachment.command` 提取
- Fix: stdout 尾部 `\n` 导致多出空行，改为 `.replace(/\n$/, '')` 去除
- Fix: `attachment.content` 与 `attachment.stdout` 内容相同（PostToolUse 类型常见）时去重，避免 content/stdout 重复展示
- Test: hook_success 测试从 1 个扩充到 5 个，覆盖全字段解析、尾部换行去除、content/stdout 去重、不同内容保留、空字段处理

## 2026-05-23 (v0.0.15)

- Feature: 左侧树节点新增任务描述显示 — Main 代理显示用户输入的 Prompt，子代理显示当前执行的 `{toolName}: {content}`（如 `Bash: npm test`），task 节点显示任务描述，CSS `text-overflow: ellipsis` 自动截断
- Feature: 左侧树工具栏新增 💬 按钮，可切换 agent/task 任务描述行的显示/隐藏
- Feature: parser 新增 `USER_TEXT` 类型，提取用户消息中的文本 Prompt，用于 Main 代理节点显示
- Change: Main 代理节点只显示用户 Prompt，不显示过程中的工具调用描述；子代理节点继续显示工具调用描述
- Change: `USER_TEXT` 条目不在右侧流面板中显示（`isItemVisible` 返回 false）
- Change: 左侧树节点 HTML 结构从 `<tree-node>` 单层改为 `<tree-content>` 包裹 `<tree-node>` + `<tree-activity>` 的双层容器，支持名称行+描述行布局
- Change: hover/selected/dim 样式从 `.tree-node` 移至 `.tree-content`，确保整行（名称+描述）视觉一致
- Change: `.tree-row` 从 `align-items: center` 改为 `flex-start`，适配多行内容

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
- Feature: `MAX_ITEMS` 从 1000 提升到 9999，支持显示更多流式事件
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