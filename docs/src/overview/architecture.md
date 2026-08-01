# 2. 顶层架构总览

## 2.1 分层鸟瞰

OCR 在 Go module `github.com/alibaba/open-code-review` 下分成两个非常清晰的世界：

```
cmd/opencodereview/        ← CLI 入口、命令树、I/O 装配  (Cobra + bubbletea TUI)
        │
        │   依赖注入
        ▼
internal/
├── agent/        ← diff-review 顶层编排：解析 diff→filter→plan→并发子任务
├── scan/         ← 全文件审查顶层编排：枚举→filter→batch→并发子任务
├── delegate/     ← 委派模式：无 LLM，只生成"审查规约"丢给宿主 Agent
├── llmloop/      ← 共享的 LLM 工具调用循环 + 三区上下文压缩 + 评论 worker pool
├── llm/          ← LLM 客户端抽象（anthropic / openai / openai-responses）+tiktoken
├── tool/         ← 六个内置工具 + 工具注册表 + 评论收集器
├── diff/         ← git diff 解析、文件枚举、行号定位与重定位、gitignore
├── gitcmd/       ← 共享 git 子进程并发限流器
├── config/
│   ├── rules/      ← 规则解析 (system_rules.json + rule_docs/*.md + 4 层覆盖)
│   ├── allowlist/  ← 扩展名白名单 + 默认排除路径
│   ├── template/   ← prompt 模板 + tools.json + testconnection
│   └── toolsconfig/← 工具 schema 加载
├── session/      ← 会话 JSONL 持久化 + 断点续审状态
├── mcp/          ← MCP 客户端（stdio + remote HTTP）+ 工具注册桥
├── viewer/       ← 会话 Web 回看服务 (net/http + embed.FS)
├── telemetry/    ← OpenTelemetry SDK (console + OTLP)
├── model/        ← 领域模型 (Diff/LlmComment/ScanItem/ExcludeReason/ReviewMode)
├── pathutil/     ← 跨平台路径工具
├── stdout/       ← stdout 静音/恢复（json/agent 模式用）
├── suggestdiff/  ← suggestion_code → unified diff 渲染
└── release/      ← release 资产命名（用于安装脚本）
```

命令行入口通过 `cmd/opencodereview/shared.go` 的 `loadCommonContext` 把 **template + repoDir + rules.Resolver + FileFilter + gitcmd.Runner** 这五件套装好，然后 `review`/`scan` 各自注入 LLM 运行时（`loadLLMRuntime`）后调到 `internal/agent` 或 `internal/scan`。委派模式连 LLM 都不加载。

## 2.2 三条执行管线

OCR 顶层有**三条独立的执行管线**，共享规则体系、工具体系、会话系统、LLM 客户端、`llmloop.Runner`，但顶层编排各不相同：

| 管线 | 入口命令 | 顶层 orchestrator | 是否调 LLM | 是否需要 git | 是否有并发 |
|------|---------|------------------|-----------|------------|----------|
| diff-review | `ocr review` | `internal/agent.Agent.Run` | 是 | 是 | 是（per-file） |
| full-scan | `ocr scan` | `internal/scan.Agent.Run` | 是 | 否（可 walkFs） | 是（per-batch 内 per-file） |
| delegate | `ocr delegate preview\|rule` | `internal/delegate.GroupRules` 等 | **否** | 是 | 否 |

注意：`llmloop.Runner` 是 diff-review 和 full-scan **共用**的执行核（`internal/llmloop/loop.go:149` `RunPerFile`），但**只读** `template.Template` 里的 `MemoryCompressionTask` / `ReLocationTask` / `MaxTokens` / `MaxToolRequestTimes` 四个字段——scan 通过 `toLoopTemplate()`（`internal/scan/agent.go:145`）把 `ScanTemplate` 投影成这个子集喂进去。

## 2.3 顶层数据流（diff-review 管线）

下图是 `ocr review --from A --to B` 的宏观数据流，详细时序见第 19 章。

```
       CLI (cmd/opencodereview/review_cmd.go)
        │
        ├── loadCommonContext ──► rules.NewResolver  (4-layer 合成)
        │                  ──► template.LoadDefault (embed)
        │                  ──► gitcmd.New (sem=16)
        │
        ├── loadLLMRuntime ──► toolsconfig.Load (tools.json)
        │                ──► llm.ResolveEndpointWithModelOverride
        │                ──► llm.NewLLMClient (anthropic/openai/openai-responses)
        │
        ├── buildToolRegistry ──► tool.Registry (file_read/code_search/...)
        ├── initMCPClients   ──► mcp.Client × N + RegisterAll → tools
        │
        ▼
   agent.New(Args) ──► agent.Run(ctx)         [internal/agent/agent.go:195]
        │
        ├── loadDiffs        ← diff.Provider.GetDiff (workspace/commit/range)
        ├── injectDiffMap   ← 把所有 diff 喂给 file_read_diff 工具
        ├── filterDiffs      ← extension allowlist + exclude patterns + 用户规则
        ├── filterLargeDiffs ← 单文件 diff >80% MaxTokens 直接跳过
        │
        ├── dispatchSubtasks ──┐
        │                     │ 每个文件 N 个 goroutine, sem=MaxConcurrency (默认 8)
        │                     │
        │  ┌──────────────────┘
        │  │
        │  ▼ executeSubtask (per-file)
        │  ├── resolveSystemRule (path→rule.md 文本)
        │  ├── executePlanPhase   (变更行 ≥50 才触发, 一次性 LLM 调用)
        │  │      └─► 产出 JSON plan → {{plan_guidance}}
        │  ├── RunPerFile (llmloop.Runner)  ←★ 核心 LLM 工具调用循环
        │  │      └─► 多轮：LLM→parseToolCalls→executeToolCall→append→压缩→…
        │  │            └─► code_comment 走 CommentWorkerPool 异步
        │  │                └─► ResolveComment 失败 → ReLocateComment (LLM)
        │  ├── CommentWorkerPool.AwaitKey(newPath)
        │  └── executeReviewFilter (一次性 LLM 调用, 剔除证伪的评论)
        │
        └── 注：关键是 code_comment 异步：LLM 主循环不等评论处理即可继续
        │
        ▼  Runner 收集 CommentCollector.comments
   emitRunResult  ← diff.ResolveLineNumbers (终极行号定位)
        │
        ├── outputFormat=json → outputJSONWithWarnings(...)
        └── outputFormat=text → outputTextWithWarnings(...) + 项目摘要(scan)
        │
        ▼
  session.Finalize ──► WriteSessionEnd (JSONL)
```

## 2.4 三个关键设计决策的落点

**决策一：每文件一个子 Agent，上下文天然隔离。**
不是给 LLM 一坨 200 个文件的 diff 让它看，而是按文件维度起子任务——`agent.go:437` 的 `go func(d model.Diff) {...}`。每个子任务有独立的 `messages []llm.Message`，独立的 `compressionState`。这是"divide-and-conquer"在 Agent 工程上的直接体现。

**决策二：评论的后处理挪出关键路径。**
`code_comment` 工具调用本身要做的"行号定位 + 可能的重定位 LLM 调用"是慢且不可预知的。`llmloop.go:399` 把它扔进 `CommentWorkerPool.SubmitFor(newPath, ...)`，主循环马上回 `tool.CommentSucceed` 继续下一轮。这把"评论数量 × 重定位延迟"从主耗时变成可重叠的后台成本。

**决策三：上下文三区压缩（frozen / compress / active）。**
当对话 token >80% MaxTokens 时同步压缩，>60% 时异步后台压缩，避免长审查崩盘。详见第 7 章。

## 2.5 包级依赖图（简化）

```
cmd/opencodereview
   │
   ├──► internal/agent ──► internal/llmloop ──► internal/llm
   │         │                   │                  ▲
   │         │                   ├──► internal/tool ─┘
   │         │                   ├──► internal/session
   │         │                   ├──► internal/diff (重定位/工具内)
   │         ▼                   └──► internal/telemetry
   ├──► internal/scan ──(同样依赖 llmloop)
   ├──► internal/delegate ──► internal/config/rules
   ├──► internal/mcp ──► internal/tool (RegisterAll)
   ├──► internal/viewer ──► internal/session (load)
   └──► internal/config/{rules,allowlist,template,toolsconfig}
```

`internal/llmloop` 是真正的"应用核心"，`internal/agent` 和 `internal/scan` 是两个不同的"上层应用"。理解了 `llmloop.Runner.RunPerFile`（第 7 章）就理解了 OCR 一半。
