# 7. llmloop：LLM 工具调用循环与上下文压缩

`internal/llmloop/` 是整仓最"核心"的包。它定义了**单个文件审查的 LLM 多轮工具调用循环**，被 `internal/agent`（diff-review）和 `internal/scan`（full-scan）共用，是 OCR 性能、稳定性、上下文管理的真正枢纽。

理解 `llmloop/loop.go:149 RunPerFile` 这一函数 + `compression.go` 的三区压缩 + `pool.go` 的评论 worker pool，就理解了 OCR 一半。

## 7.1 文件清单

| 文件 | 职责 |
|------|------|
| `loop.go` | `Runner` 结构、`RunPerFile`（主循环）、`executeToolCall`（工具分发）、`addNextMessage`（含压缩触发） |
| `compression.go` | 三区压缩：partition / triggerAsyncCompression / tryApplyPendingCompression |
| `pool.go` | `CommentWorkerPool`：code_comment 异步处理池，含 `SubmitFor`/`AwaitKey` 按 key 隔离 |

## 7.2 `Runner` 结构

`loop.go:45`：

```go
type Runner struct {
    deps                  Deps              // 注入的依赖
    totalInputTokens      int64             // atomic 累计
    totalOutputTokens     int64
    totalCacheReadTokens  int64
    totalCacheWriteTokens int64
    warningsMu  sync.Mutex; warnings  []AgentWarning
    toolCallsMu  sync.Mutex; toolCalls  map[string]int64
}
```

**`Runner` 是 per-session 的，跨所有 `RunPerFile` 调用共享 token 计数**。这意味着即使你并发跑 8 个文件，token 累加是原子的、真实的、聚合的——预算 gate 用 `r.TotalTokensUsed()` 拿真值，没有竞态。

`Deps` 结构（`loop.go:25`）从外部注入：

```go
type Deps struct {
    LLMClient         llm.LLMClient
    Model             string
    Template          template.Template
    Tools             *tool.Registry
    MainToolDefs      []llm.ToolDef
    CommentCollector  *tool.CommentCollector
    CommentWorkerPool *CommentWorkerPool
    Session           *session.SessionHistory
    DiffLookup        func(path string) *model.Diff   // code_comment 行号定位用
}
```

注意 `DiffLookup`：scan 模式下它返回一个**合成 Diff**（`NewFileContent` 是整个文件，`Diff` 空），让 code_comment 行号定位的代码（`resolveFromFileContent`）能复用同一逻辑处理两种审查模式。这个抽象非常干净。

## 7.3 `RunPerFile` 主循环：精确解剖

`loop.go:149`。把循环逐步拆开：

```go
func (r *Runner) RunPerFile(ctx, messages, newPath) (bool, error) {
    toolReqCount := r.deps.Template.MaxToolRequestTimes       // 30 / 60
    consecutiveEmptyRounds := 0
    sessionID := uuid.NewString()                              // 用于 prompt cache key
    st := &compressionState{}                                  // 本对话独占

    defer r.cancelPendingCompression(st)                       // 退出时取消后台压缩

    for toolReqCount > 0 {
        select { case <-ctx.Done(): return false, ctx.Err() ; default: }
        toolReqCount--

        // 1. LLM 调用
        rec := session.AppendTaskRecord(MainTask, messages copy)
        resp, err := r.deps.LLMClient.CompletionsWithWat(ctx, ChatRequest{
            Model, Messages: messages, Tools: MainToolDefs, MaxTokens, SessionID
        })
        if err != nil { return false, fmt.Errorf("LLM completion error: %w", err) }
        atomic.Add(...tokens...)                               // 累计真实 usage
        rec.SetResponse(resp, duration)

        content := resp.Content()
        calls  := resp.ToolCalls()

        // 2. 没工具调用 → model 在偷懒，"retry"
        if len(calls) == 0 {
            messages = append(messages,
                NewToolCallMessage("user", "You did not successfully call any tools..."),
            )
            if content != "" { /* 把 assistant content 也插回去 */ }
            continue  // 不递减 consecutiveEmptyRounds
        }

        // 3. 依次执行每个 tool call
        var results []ToolCallResult
        taskCompleted := false
        hasValidResult := false
        for _, call := range calls {
            cp := r.executeToolCall(ctx, newPath, call, rec)
            if cp.Failed     { return false, fmt.Errorf("task failed: %s", cp.Data) }
            if cp.Completed { taskCompleted = true; results = append(... success) }
            else if cp.Data != "" { results = append(...); hasValidResult = true }
            else                  { results = append(... no result) }
        }
        if taskCompleted { return true, nil }                   // task_done 收工

        // 4. 连续空轮退避
        if !hasValidResult {
            consecutiveEmptyRounds++
            if consecutiveEmptyRounds >= 3 {
                fmt.Fprintf(stdout, "...Too many empty retries for %s, stopping\n", newPath)
                break
            }
        } else {
            consecutiveEmptyRounds = 0
        }

        // 5. 把 assistant + tool results 追加，触发压缩判定
        if !r.addNextMessage(ctx, content, calls, results, &messages, newPath, st) {
            break  // 压缩失败仍超 warn 阈值 → 退出
        }
    }

    return false, nil
}
```

### 几个微妙点

- **`len(calls)==0` 分支不递减 `consecutiveEmptyRounds`**——这是有意的，不调用工具的纯文本回复也不是"空"。真正"空"指的是 calls 都返回 `cp.Data == ""` 且 `!Completed`（即工具调用都失败/无结果）。
- **`consecutiveEmptyRounds` 上限 3**——避免坏模型疯狂 retry 工具直到 `MAX_TOOL_REQUEST_TIMES` 浪费 token。
- **`maxConsecutiveEmptyRounds` 写死为 3**（`loop.go:151`），模板未公开。这是 OCR 调过的"恶模型兜底"参数。
- **`messages` 是 slice 切换**——`addNextMessage` 通过 `*messages` 指针修改/重建 slice，主循环每次拉新值，不需要 caller 自己同步。
- **`task_completed` 只看 `task_done.state == "DONE"`** — FAILED 直接 `return false, error`，整个文件 subtask 失败。

## 7.4 `executeToolCall`：工具分发器的三态

`loop.go:276` 是 OCR 唯一的工具分发入口。函数签名：

```go
func (r *Runner) executeToolCall(ctx, newPath, call ToolCall, rec *TaskRecord) tool.TaskCheckpoint
```

三态分支：

1. **未识别的游戏工具名（dynamic tool，从 MCP 注册来的）**——`tool.OfName(call.Function.Name).IsKnown() == false`：
   ```go
   p, ok := r.deps.Tools.Get(call.Function.Name)
   if !ok { return tool.Of(NotAvailableMsg) }
   dynArgs, err := parseToolArgs(call.Function.Arguments)  // json.Unmarshal + nil→{} 防御
   result, err := p.Execute(ctx, dynArgs)
   return tool.Of(result)
   ```

2. **`task_done`**——特殊处理不进 dispatcher：
   ```go
   switch state {
   case "DONE":   return tool.Complete()           // {Completed:true}
   case "FAILED": return tool.Fail(...)             // {Failed:true}
   default:       return tool.Of("invalid state ...")
   }
   ```

3. **六个内置工具**——`lookupTool` + `p.Execute(ctx, args)`，但**`code_comment` 是唯一的异步路径**。

### `code_comment` 异步详解

`loop.go:354` 起的分支：

```go
if t == tool.CodeComment {
    comments, errMsg := tool.ParseComments(args)  // 解析数组
    if errMsg != "" { return tool.Of(errMsg) }

    resolveAndCollect := func(rctx) {
        for i := range comments {
            if d := r.deps.DiffLookup(cm.Path); d != nil {
                if !diff.ResolveComment(cm, d) && r.deps.Template.ReLocationTask != nil {
                    // ① 行号匹配失败 → 调 LLM ReLocateComment 重新生成 existing_code
                    _, resp, msgs := diff.ReLocateComment(...)
                    if msgs != nil { session.RecordReLocationTask(...) }
                }
            }
            r.deps.CommentCollector.Add(*cm)
        }
    }

    if r.deps.CommentWorkerPool != nil {
        pool.SubmitFor(newPath, func() {
            defer ... telemetry.RecordToolResult ...
            resolveAndCollect(asyncCtx)   // context.WithoutCancel(ctx)
        })
        return tool.Of(tool.CommentSucceed)   // 主循环立刻收工
    }
    resolveAndCollect(ctx)                    // fallback：同步处理
    return tool.Of(tool.CommentSucceed)
}
```

**为什么异步**：`ResolveComment` 可能失败，触发 `ReLocateComment` ——一次额外的 LLM 调用，耗时不可预测。如果同步等，主循环就被卡住。扔进 worker pool 后主循环立刻回 `CommentSucceed`，下一轮立刻发新 LLM 请求。

**`SubmitFor(newPath, ...)` + `AwaitKey(newPath)`**：在 `agent.executeSubtask` 末尾会调 `pool.AwaitKey(newPath)`，确保**本文件**的异步任务都完成才进入 `executeReviewFilter`。但其他文件的并发 review 可以同时 Submit，互不阻塞。

### 其它工具的同步路径

`file_read`/`code_search`/`file_read_diff`/`file_find` 都是**同步**：

```go
result, err := p.Execute(ctx, args)
telemetry.RecordToolResult(toolSpan, t.Name(), dur.Milliseconds(), err)
if err != nil { return tool.Of(fmt.Sprintf("Error executing tool %s: %v", t.Name(), err)) }
if rec != nil { rec.AddToolResult(t.Name(), call.Function.Arguments, result) }
return tool.Of(result)
```

错误**不返回 Go error**，而是包成字符串 `tool.Of("Error: ...")` 回给 LLM——让模型看到错误信息自己决定要不要 retry 或换路径。这是 OCR 主动选择"模型自纠错"而非"硬失败"的设计。

## 7.5 三区上下文压缩：frozen / compress / active

这是 OCR 处理长审查最巧妙的工程。`compression.go`。

### 三区定义

`partitionMessages`（`compression.go:123`）把 `messages` 分三段：

```
┌──────────────┬─────────────────────┬─────────────────────┐
│ frozen zone  │   compress zone     │    active zone      │
│ [0:2)        │ [2:compressEnd)     │ [compressEnd:len)   │
│ system + 1st │ 历史轮次会被压缩    │ 最近 K 轮完整保留    │
│ user         │                     │                     │
└──────────────┴─────────────────────┴─────────────────────┘
```

- **frozen** = `messages[0:2]`：恒等于 system + 第一条 user（含规则、diff、plan、changefile）。**永不被压缩**。
- **compress**：从 frozen 后到 active 起点。会被 LLM 调一次 `MEMORY_COMPRESSION_TASK` 总结成 `<previous_review_summary>` 追加到 user 文本里。
- **active**：尾部，保留完整对话原貌。`computeActiveZoneSize` 从尾部往前累加，直到 token > `PromptTokenLimit - reservedTokens` 撑不住为止。

### 两个阈值 + 三个触发点

`compression.go:17-20`：

```go
const tokenSoftThreshold    = 0.60  // 触发后台异步压缩
const tokenWarningThreshold = 0.80  // 触发同步压缩
```

`addNextMessage`（`loop.go:458`）依次：

1. **进入时**先 `tryApplyPendingCompression`：如果上轮触发的后台压缩已完成，把它 swap 进 `*messages`。
2. **追加前**若 `CountMessagesTokens(*messages) > warnLimit(80%)`：立刻 cancel 后台压缩 + 同步 runCompression。
3. **追加 assistant + tool results**。
4. **追加后**再检查，若仍 > warn：再同步压缩一次。
5. **软阈值**：若 `finalCount > softLimit(60%) && < warnLimit`：`triggerAsyncCompression` 启后台 job。

返回 `finalCount < warnLimit`——若同步压缩后仍超 warn，`RunPerFile` 直接 break，避免死循环消耗 token。

### 异步压缩的 ownership 模型

`compressionState` 是 per-`RunPerFile` 的（`loop.go:157`），**不是 Runner 级**。理由（#384 bug）：Runner 共享，一个文件的 job 槽可能被另一文件看到导致 race。所以每个对话持有自己的 `compressionState`。

后台 goroutine 通过 `compressionJob.done` 信道通知完成，并在写入 `job.rebuilt` 后 close。主循环下一轮 select 命中 `<-job.done` 时 swap。**关键技巧**：swap 时保留 `messages[snapshotLen:]`——即压缩启动后追加进来的消息不会被丢，避免"先启动压缩，新加内容被吃掉"的 bug。

### 失败回退

`runCompression` 失败时**不动 messages**（`compression.go:241`）：

> "Return msgs unchanged: truncating to frozenEnd would discard all conversation context, which is worse than staying over the token limit temporarily."

这是 OCR 对错误降级的清晰取舍。

## 7.6 `CommentWorkerPool`：按 key 隔离的并发池

`pool.go`：

```go
type CommentWorkerPool struct {
    semaphore chan struct{}         // 并发 cap
    wg        sync.WaitGroup        // pool-wide
    resultsMu sync.Mutex
    results   []model.LlmComment

    keysMu sync.Mutex
    keys   map[string]*sync.WaitGroup  // per-key
}
```

- `Submit(f)` 普通：`wg.Go(...)`，受 semaphore 控制。
- `SubmitFor(key, f)` 多注册一个 per-key WaitGroup。
- `Await()` 全局等。**契约**：必须保证调 `Await` 时没有其它 goroutine 还在 `Submit`，否则会 panic("Add called concurrently with Wait")——OCR 通过设计避免：`agent.dispatchSubtasks` 结束才 Await，所有 Submit 都在 subtasks 内做。
- `AwaitKey(key)` 只等某个 key 的任务，与其他 key 的 Submit **不冲突**——这是为什么 per-file 调用 AwaitKey(newPath) 安全。

panic 也在 submited work 内 recover，避免坏数据 crash pool。

## 7.7 小结

`llmloop` 这个包的设计理念浓缩成一句话：**把"每文件一个 LLM 单文件审查 agent"做到生产强壮**。它处理的不是"业务"而是工程暴打：流控、压缩、并发、panic 隔离、token 计数、错误降级。这是为什么这种"agent 编排内核"远比一个简单 chat 调 API 复杂得多——也是 OCR 提供的核心价值之一。

如果你想做二次开发，比如改成"流式 UI"或"自我反思循环"，`RunPerFile` 是你必须 fork 的函数。
