# 8. Tool：六件套工具体系

`internal/tool/` 实现了 OCR 给 LLM 暴露的全部六个内置工具，外加工具注册表、评论收集器、文件读取器抽象。这一把工具集是从大规模生产 trace 里"蒸馏"出来的最小集——OCR 故意不暴露通用 file system / shell / `gh` 类工具，而是只给 LLM 审查代码时真正需要的几件事。

## 8.1 抽象与注册表

`internal/tool/definitions.go`：

```go
type Tool struct { name string }

var (
    Unknown      = Tool{"unknown"}      // 不识别时的兜底，IsKnown()==false
    TaskDone     = Tool{"task_done"}
    CodeComment  = Tool{"code_comment"}
    FileRead     = Tool{"file_read"}
    FileFind     = Tool{"file_find"}
    FileReadDiff = Tool{"file_read_diff"}
    CodeSearch   = Tool{"code_search"}
)
```

`Provider` 接口（`definitions.go:66`）是所有工具实现的统一抽象：

```go
type Provider interface {
    Tool() Tool
    Execute(ctx context.Context, args map[string]any) (string, error)
}
```

`Registry` 是一个 `map[name]Provider`，含 `Freeze()` 防止运行期再注册（`agent.go:210` 在 `injectDiffMap` 后立刻 Freeze）。

MCP 工具会通过 `mcp.RegisterAll(tools, mc, filterNames)`（见第 15 章）注册进同一个 Registry，作为 `Dynamic(name)` 工具——LLM 看不到差异，dispatcher 用 `Tool.IsKnown()` 判定是否六件套之一。

## 8.2 六件套逐个剖析

### 8.2.1 `task_done` — 终止信号

不在 tool dispatch 里注册 `Provider`，而是直接在 `llmloop.executeToolCall:311` 内联：

```go
switch state {
case "DONE":   return tool.Complete()           // {Completed:true}
case "FAILED": return tool.Fail("task_done reported FAILED")
default:       return tool.Of("Error: invalid task_done state")
}
```

`task.TaskCheckpoint` 的 `Completed` / `Failed` / `Data` 三字段足以让 `RunPerFile` 区分终态。

### 8.2.2 `code_comment` — 评论收集 + 异步行号处理

`code_comment.go`：

- 接收参数：`comments: [{content, existing_code, suggestion_code, thinking, category, severity}]`，外层 `path` 由 `llmloop.executeToolCall:348` 强制注入 `args["path"] = newPath`——防 LLM 幻觉挂在错的文件上。
- 校验：`category` 必须是 `bug|security|performance|maintainability|test|style|documentation|other`，否则 normalize 成 `other`；`severity` 必须 `critical|high|medium|low`，否则 `low`。
- 处理逻辑（在 `llmloop.executeToolCall` 中）：
  1. `tool.ParseComments(args)` → `[]model.LlmComment`
  2. 异步路径（`CommentWorkerPool` 存在）：
     - `pool.SubmitFor(newPath, resolveAndCollect)`——每条 comment：
       a. `diff.ResolveComment(cm, d)` 文本匹配定位行号；
       b. 失败且配置了 `ReLocationTask` → 调 LLM `ReLocateComment` 重定位（第 9 章）；
       c. `CommentCollector.Add(cm)`
- 同步路径：同上逻辑，但在 ctx 上执行（无 pool 时 fallback）。
- 返回：`tool.Of(tool.CommentSucceed)` 让主循环立刻继续。

`comment_collector.go` 提供线程安全的 `CommentCollector`，含 `Add / Comments / CommentsForPath / RemoveByPathAndIndices / Snapshot / Since / ReplaceSince`——后者被 scan 的 dedup 用。

### 8.2.3 `file_read` — 读当前文件指定段

文件 `file_read.go` + 共用 `filereader.go`：

- 入参：`file_path (required) / start_line / end_line`
- 输出：根据 review mode 决定数据源
  - `workspace`：`os.ReadFile(filepath.Join(RepoDir, path))`（实际是 working tree）
  - `commit` / `range`：`git show <ref>:<path> --end-of-options`（保证审的是变更后的版本）
- 关键：尊重 git hunk header `@@-x,y +m,n@@`——如果指定行不在 hunk 范围内，工具会自动检查并仍返回内容。
- **>500 行截断**：返回文本里带 `IS_TRUNCATED` flag，让 LLM 知道不够再下一段。
- 由 `FileReader`（`filereader.go`）持有 `RepoDir / Mode / Ref / Runner`，所有 file 系工具复用。

### 8.2.4 `code_search` — 文本/正则搜索

`code_search.go`：

- 入参：`search_text (required) / file_patterns [] / case_sensitive / use_perl_regexp`
- 实现：包装 `git grep`，走 `gitcmd.Runner.Stream` 流式拉结果，**最多返回 100 个匹配**。
- `file_patterns` 转成 `git pathspec`，支持 include/exclude。
- 大仓搜索要靠 runner 的 semaphore（16 并发）避免 git grep 子进程爆量。

### 8.2.5 `file_read_diff` — 跨文件 diff 上下文

`file_read_diff.go`：

- 入参：`path_array [] (required)`
- 输出：每个 path 对应的 diff 文本，从 `FileReadDiffProvider.DiffMap` 取（这个 map 在 `agent.injectDiffMap` 和 `scan.injectScanContentMap` 时填充）。
- 设计意图：让 LLM 在审 main.go 时，可以查 util.go 的 diff 来跨文件理解上下文，不需要再起 git 进程。
- 注意：scan 模式下 `file_read_diff` 被 `excludeToolDef` 从工具列表里**剔除**——见 `scan_cmd.go:144`，因为 scan 模式没有 diff 概念。

### 8.2.6 `file_find` — 文件名查

`file_find.go`：

- 入参：`query_name (required) / case_sensitive`
- 输出：文件名匹配的路径列表，**≤100 项**，case-insensitive 默认。
- 实现：`git ls-files`（workspace/commit/range 模式） 或 `filepath.WalkDir`（非 git 时 scan fallback）。

## 8.3 工具结果回灌

`response_message.go` 把 `ToolCallResult` 转成 `llm.NewToolResultMessage(toolCallID, result)` 的 tool role message。`llmloop.loop.go:484` 在 `addNextMessage` 里逐个 append 进 messages，然后下一轮 LLM 调用就能看到。

注意：OpenAI 协议每个 tool result 单独一条 message，Anthropic 协议会把多个 tool result 合到一条 user message 的 `tool_result` blocks 里——这个翻译在 `internal/llm/client.go:652 flushToolResults` 完成。

## 8.4 schema 定义文件

`internal/config/toolsconfig/tools.json` 是六个工具的 schema 定义，结构是：

```json
[
  { "name": "task_done", "plan_task": false, "main_task": true,
    "definition": { ... OpenAI-style function schema ... } },
  { "name": "code_comment", "plan_task": false, "main_task": true, "definition": ... },
  { "name": "file_read", "plan_task": false, "main_task": true, "definition": ... },
  { "name": "code_search", "plan_task": true, "main_task": true, "definition": ... },
  { "name": "file_read_diff", "plan_task": true, "main_task": true, "definition": ... },
  { "name": "file_find", "plan_task": true, "main_task": true, "definition": ... }
]
```

`ToolDefsByPhase(planOnly bool)` 按 `plan_task`/`main_task` 字段过滤，让 plan phase 只看到 `code_search`/`file_read_diff`/`file_find`（只读上下文），main phase 才看到 `task_done`/`code_comment`/`file_read`。

这个 JSON 也是 `//go:embed` 进二进制的，但可以通过 `--tool-config <path>` 加载自定义版替换。这是 OCR 留给二次开发的少量扩展点之一。

## 8.5 工具调用 token / 错误可见性

每个工具调用都会被 `telemetry.PrintToolCallStarted/Finished/Error`（`internal/telemetry/events.go`）翻译成 `[ocr] 📤 tool_call code_search started`、`[ocr] ✅ tool_call code_search finished in 12ms` 之类的 stdout 进度信息（json/agent 模式静音），并写入 session JSONL `tool_call` 记录。

LLM 看到的工具结果字符串：

- `code_comment` 给回 `"Comments submitted successfully."`（`tool.CommentSucceed`）
- 其它工具给回 `result string`（`tool.Of(result)`）
- 工具未注册 → `"Error: Tool not found. The tool you attempted to call does not exist or is not available. Please check the tool name and try again with a valid tool."`（`NotAvailableMsg`）——这一类"温和错误回执"是为了让 LLM 自己 adapt，而不是故障停止。

## 8.6 文件读取的安全/隔离

`FileReader` 的 `Mode` 决定行为：

- `ModeWorkspace`：直接 `os.ReadFile(absPath)`。注意：`review` 的 workspace 模式也走这条，但底层 provider 已先做了 git diff 拿到 newPath，所以 LLM 调 file_read 时能拿到工作树最新内容（含未提交）。
- `ModeCommit` / `ModeRange`：`git show <ref>:<path>`。这是关键安全保证——审 commit/range 模式时，LLM 不能看到 history 之外的代码（如未来的 HEAD），避免 prompt injection 让 LLM 读 secrets 文件。

不过 workspace 模式下 file_read 理论上能读未跟踪文件——monorepo 里有敏感文件（如 `.env`）会被允许。OCR 没有显式黑名单，只能靠 `.gitignore` + 用户 exclude pattern 防御。这是落地时的一个关注点（见 33 章安全）。

## 8.7 小结

六件套工具是 OCR 设计哲学最直接体现：**"模型只该问一些值得问的问题"**。它们覆盖了代码审查中真正需要动态决策的所有场景：

- 我要不要看看这段代码的上下文？→ `file_read`
- 这函数被哪里调用？→ `code_search`
- 这个改名涉及哪些文件？→ `file_read_diff` / `file_find`
- 我要报这条 issue：→ `code_comment`
- 我审完了，可以收工了：→ `task_done`

砍掉通用 fs/shell 工具让模型不会"乱跑"——这也是为什么 benchmark 显示 OCR 比通用 Agent token 消耗少 1/9。
