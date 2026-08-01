# 6. Agent 编排层（diff-review）

`internal/agent/` 是 `ocr review` 的顶层指挥官。它**不碰** LLM 单轮调用的细节，专注做四件事：

1. 从 git 拿 diff、解析、过滤；
2. 为每个待审文件 spawn 一个并发子任务；
3. 调度 plan phase + 调用 `llmloop.Runner` 跑 main loop；
4. 之后做 review_filter 质量门，收尾。

LLM 多轮工具调用循环本身被搬到了 `internal/llmloop/`（第 7 章），让 `agent` 包保持"指挥"而非"执行"的角色。

## 6.1 关键文件清单

| 文件 | 职责 |
|------|------|
| `agent.go` | `Agent` 结构、`Run`、`dispatchSubtasks`、`executeSubtask`、`executeReviewFilter` |
| `preview.go` | `--preview` 模式：只列文件列表，不调 LLM |
| `estimate.go` | diff 成本估算（`estimateDiffCost` / `estimateDiffFileTokens`） |
| `util.go` | git branch 检测、`whyExcluded` 过滤规则实现、`buildChangeFilesExcept`、`stripEmptyPlanBlock`、`humanTokens` 等 |

`agent_test.go` / `coverage_test.go` / `budget_test.go` / `init_test.go` / `smallfiles_test.go` 等是测试。

## 6.2 `Agent.Args`：注入全部依赖

`agent.go:43` 的 `Args` 结构把所有外部依赖作为命名参数显式注入。这是 OCR 整个 CLI 装配层的最终目的：

```go
type Args struct {
    RepoDir                               string
    From, To, Commit                      string   // diff 范围
    ReviewMode                            string   // workspace/range/commit
    Template                              template.Template
    SystemRule                            rules.Resolver
    FileFilter                            *rules.FileFilter
    LLMClient                             llm.LLMClient
    Tools                                 *tool.Registry
    PlanToolDefs, MainToolDefs            []llm.ToolDef
    CommentWorkerPool                     *CommentWorkerPool   // code_comment 异步
    MaxConcurrency                        int                   // 默认 8
    ConcurrentTaskTimeout                 int                   // 分钟，0=无限
    CommentCollector                      *tool.CommentCollector
    Background                            string                 // {{requirement_background}}
    Model                                 string                 // 模型名兜底
    GitRunner                             *gitcmd.Runner         // git 子进程并发限流
    Session                               *session.SessionHistory // 测试可注入
    Resume                                *session.ResumeState    // 断点续审
    MaxTokensBudget                       int64                  // 总预算，0=无限
}
```

`agent.New`（`agent.go:152`）除了构造 `*Agent` 还做一件隐式的事：**构造 `llmloop.Runner` 并把 `DiffLookup` 闭包绑定到自身** ——`a.findDiff` 在后续才能查到 diff。`Runner` 是 per-Agent 而非 per-file，token/warning/tool-call 计数都是聚合在它身上（见第 7 章）。

## 6.3 `Agent.Run` 六步流水线

`agent.go:195 Run` 是整个 diff-review 的顶层 master：

```
diff.parse                   telemetry.StartSpan("diff.parse")
loadDiffs                    解析 workspace/commit/range 三模式的 diff
injectDiffMap                把所有 diff 灌给 file_read_diff 工具
Tools.Freeze                 冻结注册表（防运行期再 Register）
countReviewable / filterDiffs 扩展白名单 / 用户 exclude / 默认排除 / 估算
dispatchSubtasks             并发跑每文件子任务
                             └─ 内部调 executeSubtask（plan+main+review_filter）
session.Finalize             写 session_end
```

### 6.3.1 `loadDiffs`：选 Provider

`agent.go:334` 按 commit / range / workspace 三种模式分别用 `diff.NewCommitProvider` / `diff.NewProvider` / `diff.NewWorkspaceProvider`。Provider 的实现在 `internal/diff/git.go`（见第 9 章），最终产出 `[]model.Diff`，每条含 `OldPath / NewPath / Diff(纯文本) / NewFileContent / Insertions / Deletions / IsNew / IsDeleted / IsRenamed / IsBinary`。

### 6.3.2 `injectDiffMap`：cross-file 钩子

`agent.go:365`：把所有 diff 文本构造一张 `map[newPath]diffText`，塞进 `FileReadDiffProvider.DiffMap`。这样 LLM 审 `internal/agent/agent.go` 时如果调 `file_read_diff` 想看 `internal/agent/util.go`，工具能秒回，不需要再跑 `git diff`。这是 OCR "智能打包"在工程上的最小成本实现。

注意：这是**包级**而非文件级的 diff 共享。`a.diffs` 里所有文件都进 map，**包括被 filter 掉的**——注释明说：让 LLM 查询"相关但被过滤掉的文件"的 diff。这降低了"被过滤的关键文件需要时查不到"的盲区。

### 6.3.3 `filterDiffs`：三层过滤

`agent.go:887` 的实际算法委派给 `whyExcluded`（`util.go`）：返回 `ExcludeReason` 枚举。逻辑顺序：

1. IsBinary → 跳过
2. FileFilter.IsUserExcluded → 跳过（用户 exclude）
3. **HasInclude && IsUserIncluded** → **优先放行**（用户 include 可以放进白名单外的扩展，如 `.ftl` Freemarker，#371）
4. 没匹配 include → 扩展名是否在 `IsAllowedExt` → 不在跳过
5. `IsExcludedPath`（默认排除测试文件）→ 跳过

### 6.3.4 `filterLargeDiffs`：token 预过滤

`agent.go:840`：单文件 diff 自身 token > `PromptTokenLimit(MaxTokens)`（即 80%）就丢，因为加 system+规则+plan 后必然超 MaxTokens。这里用的是 `llm.CountTokens(d.Diff)` 的本地 tiktoken 估算。被丢掉的会 warning 出 "[ocr] Skipping <path> (~{n} tokens exceeds 80% of max_tokens(58888))"。

### 6.3.5 预算 gate 与 `estimateDiffCost`

`agent.go:243` 起始的预算逻辑：

```go
if a.args.MaxTokensBudget > 0 {
    est := estimateDiffCost(a.diffs)
    fmt.Fprintf(stdout.Writer(), "[ocr] estimated cost: %s\n", est)
    if est.TotalTokens > a.args.MaxTokensBudget {
        ... WARNING: estimate exceeds budget; review will stop partway
    }
}
```

`estimate.go` 的估算是**地板**，不是天花板：它无法估计 LLM 工具调用展开后的 context 膨胀。注释明确指出 #409 报告里看到 `~300×` 的 tool-use 膨胀是可能的。所以这只是给 budget-setter 一个对照参考，避免完全无信息地踩坑。

## 6.4 `dispatchSubtasks`：N=8 并发子任务

`agent.go:382` 是 OCR 性能的关键：

```go
concurrency := a.args.MaxConcurrency; if concurrency <= 0 { concurrency = 8 }
sem := make(chan struct{}, concurrency)
for i := range toDispatch {
    if toDispatch[i].IsDeleted { continue }
    // 预算 gate：检查 used + nextEst > budget
    if a.args.MaxTokensBudget > 0 {
        projected := used + estimateDiffFileTokens(toDispatch[i])
        if projected > budget { a.budgetExceeded = true; break }
    }
    sem <- struct{}{}
    go func(d model.Diff) {
        defer wg.Done(); defer func() { <-sem }()
        defer func() { recover() ... atomic subtaskFailed++ ... telemetry error ... }()  // panic 隔离
        // 单文件超时
        if timeout > 0 { fileCtx, cancel = context.WithTimeout(ctx, timeout); defer cancel() }
        completed, skipReason, err := a.executeSubtask(fileCtx, d)
        if err != nil { atomic subtaskFailed++; session.RecordReviewItemFailed }
        if completed { session.RecordReviewItemDone }
    }(toDispatch[i])
}
wg.Wait()
```

关键设计点：

1. **semaphore 控并发**：默认 8 个文件同时审（不是 8 个 LLM 调用并发——每文件内部 LLM 调用是串行的，但 8 文件 × N 工具调用并发，实际 LLM 并发数 = 8 × 每文件是否在等 LLM vs 工具 vs 评论 pool）。
2. **Panic 隔离**：单文件 panic 不能影响其他文件。`defer recover()` 把 panic 转 `subtask_error` warning + `atomic subtaskFailed++`，`wg.Wait()` 后还会检查"全部失败" `failed == dispatched` 报 `all N file review(s) failed — check your LLM configuration and API key`。
3. **预算 gate 在 `<-sem` 之前**：先估算下一文件是否会让 projected 超 budget，超了就 break，不再调度。已在飞的 worker 不取消，让它自然完成（半成品贡献 token 到原子计数器）。
4. **断点续审**：`applyResume` 在 `dispatchSubtasks` 之前（`applyResume` 实际在 `dispatchSubtasks` 体内的 `toDispatch := a.applyResume(a.diffs)`），对已完成的 fingerprint 直接复用上次的 comment，不重审。
5. **CommentWorkerPool** 在 dispatch 结束统一 `Await` 一次，确保所有异步 code_comment 任务都收回。

## 6.5 `executeSubtask`：单文件两阶段

`agent.go:576` 是单文件级编排骨架：

```
executeSubtask(ctx, d) (completed bool, skipReason, err):
  1. changeFilesExcludingCurrent = buildChangeFilesExcept(newPath)   // "其他改文件列表"
  2. rule = resolveSystemRule(lower(newPath))                        // path→rule.md 文本
  3. Phase 1 (plan, 若变更行 ≥ PLAN_MODE_LINE_THRESHOLD=50):
     - executePlanPhase → 1 次 LLM 调用 (PLAN_TASK messages)
     - 返回 planResult (JSON→markdown 渲染) 或失败时 ""
  4. Phase 2 (main):
     - 占位符替换 {{current_file_path}}/{{system_rule}}/{{change_files}}/{{diff}}/
                   {{requirement_background}}/{{plan_guidance}}/{{current_system_date_time}}
     - tokenCount = CountMessagesTokens(messages)
     - 若 tokenCount > PromptTokenLimit(MaxTokens): 直接跳过（warning token_threshold_exceeded）
     - llmloop.Runner.RunPerFile(ctx, messages, newPath)
       ↓ 返回 (mainCompleted bool, err)
  5. main 完成后：
     - CommentWorkerPool.AwaitKey(newPath)  // 等本文件异步评论处理收工
     - executeReviewFilter(ctx, d, newPath)
```

`stripEmptyPlanBlock`（`util.go`）的细节：当 plan 为空时，把 prompt 里的 `### Review Plan (Optional)\n…\n\n` 包装也一并去掉，避免空标题泄漏到模型——但**必须**在 `ReplaceAll("{{plan_guidance}}", planResult)` 之前做，因为 regex 依赖占位符还在。这是个微妙的代码顺序约束，写 review 看到要特别注意。

### `resolveSystemRule` 的细节

`agent.go:832` 直接调 `a.args.SystemRule.Resolve(path)`。`SystemRule` 实现了 4 层 composed resolver（见第 13 章），返回的是**规则 markdown 文本**（一次性把 `rule_docs/*.md` 的内容读出来填进 PathRule Rule 字段，见 `rules/system_rules.go:96 LoadDefault`）。文本最终被替换进 `{{system_rule}}` 占位符。

## 6.6 `executeReviewFilter`：保留可证伪，剔可疑

`agent.go:695` 是 OCR "精度优先" 落地最直接的代码：

```go
ft := a.args.Template.ReviewFilterTask
comments := a.args.CommentCollector.CommentsForPath(newPath)
if len(comments) == 0 { return }

// 序列化 comments 为 JSON 数组 [{id:"c-0",content,existing_code},...]
// 套 REVIEW_FILTER_TASK prompt：{{path}}/{{diff}}/{{comments}}
// 1 次 LLM 调用 (非 agent loop，只是单 round completion)
// 期望响应：JSON 数组 ["c-3","c-7"] 表示要剔除的 comment id

indices := parseFilterResponse(resp.Content(), len(comments))
a.args.CommentCollector.RemoveByPathAndIndices(newPath, indices)
```

prompt 关键提示（见第 14 章）："评论 agent 有完整工具上下文但你只看得到 diff，所以**只标记你能用 diff 直接证伪的**，可疑但不可证伪的要放过"——这是 OCR 主动牺牲 Recall 换 Precision 的设计要点。

错误**静默**：LLM 调用失败或 JSON 解析失败只 warning，不阻断。

## 6.7 budget_exceeded 状态

`agent.go:139 budgetExceeded bool` 在预算 gate 触发时被设为 true。返回值 `BudgetExceeded()`（`agent.go:326`）被 `emitRunResult` 读，从而让 JSON 输出的 `status` 变成 `"budget_exceeded"` 而不是 `"success"`，但**仍然带 partial comments + nil error**——CI 端可以按这个字段决定要不要 repost 那些 partial comments。

## 6.8 估计成本：`estimate.go`

`estimateDiffCost` 汇总每文件 `estimateDiffFileTokens(d)`。后者公式：

```
file_tokens = CountTokens(d.Diff) * 并发因子
plan_tokens = if changeLines>=50 { fixed_plan_overhead } else { 0 }
```

`estimate.go` 注释明确承认这是**地板**估算，真实 tool-use 膨胀可达 300×（#409）。所以这个数字用于"该不该开 budget"决策，**不**用于报告账单。
