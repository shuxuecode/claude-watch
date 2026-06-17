# claude-watch

claude-code-watch — 一个 Claude Code 的实时 Web 监控仪表盘。短命令 `cc-watch`。

![](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)
![](https://img.shields.io/github/package-json/dependency-version/shuxuecode/claude-watch/chokidar)
![](https://img.shields.io/github/package-json/dependency-version/shuxuecode/claude-watch/ws)

**[English](README.md) | 简体中文**

## 核心作用

Claude Code 在运行时会将详细的 JSONL 日志写入 `~/.claude/projects/` 目录，包括思考内容、工具调用、子代理活动、token 使用量等。这些信息在 Claude Code 的正常界面中并不全部可见。`claude-watch` 的作用就是**读取这些隐藏日志，实时流式传输到本地 Web 仪表盘**，让你能看到 Claude Code 的"幕后"工作细节。

## 架构组成

项目由三个核心模块构成：

1. **`src/parser/parser.js`** — JSONL 日志解析器。将 Claude Code 的 JSONL 行解析为结构化的流项目（thinking、tool_input、tool_output、text、turn_marker、hook_output 等），并提取 token 使用量和模型信息。

2. **`src/watcher/watcher.js`** — 文件监视器。使用 chokidar 监听 `~/.claude/projects/` 下的 JSONL 文件变化（带轮询 fallback），管理多会话和子代理的发现与跟踪，增量读取文件新增内容并触发解析。

3. **`src/server/server.js`** — HTTP + WebSocket 服务器。提供静态页面服务、REST API（会话列表、状态、上下文信息）和 WebSocket 实时推送，将解析后的内容广播到浏览器客户端。启动时自动打开浏览器。

## 主要功能

- **实时流式传输** — 思考过程、工具调用/结果、文本响应实时呈现
- **多会话监视** — 同时查看所有活跃的 Claude Code 会话，活跃会话不进历史分组；Observer 会话会额外聚合在名为 **Observer** 的文件夹下
- **Observer 会话支持** — 自动识别 `.claude/mem/observer/sessions` 下的 observer 会话，显示真实工作目录，并在 tooltip 中展示被观察请求
- **Token 统计页面** — 独立的 Tokens 标签页，展示总用量、输入/输出、缓存读取/创建、消息数、模型排名、使用趋势、52 周活跃热力图、小时分布、每日/每周/每月明细
- **Hash 路由** — URL hash 同步当前标签（`#stream` / `#tokens`），刷新和浏览器前进/后退保持当前位置
- **深色/浅色主题** — 一键切换主题，状态持久化到 localStorage
- **版本检测** — 自动检查 npm 最新版本，footer 显示更新提示；支持 `claude-watch update` 命令行一键升级
- **子代理追踪** — 在父会话下嵌套显示子代理活动
- **会话彩色标识** — 每个会话显示独特的彩色 hash 前缀，多会话一目了然
- **代理级活跃指示** — 绿点细化到 agent/main 级别，不只看会话整体
- **会话隐藏** — 移除不关心的会话，隐藏状态 24h 内持久化
- **代码块一键复制** — 代码块 header 右侧复制按钮，点击即复制
- **Token/成本追踪** — 每个代理的输入/输出/缓存 token 及上下文窗口利用率
- **过滤控制** — 独立切换 thinking、工具输入/输出、hook 输出、文本的可见性
- **自动发现** — 新会话启动时自动纳入监控
- **HTML 导出** — 将当前会话流导出为自包含 HTML 文件，内嵌 session 列表、token 统计、filter 状态，并支持按 session 筛选浏览

## 致谢

本项目基于 [phiat](https://github.com/phiat) 的 [claude-esp](https://github.com/phiat/claude-esp) 项目提供思路并开发。