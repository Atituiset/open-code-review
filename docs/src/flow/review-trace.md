# 19. `ocr review --from A --to B` 全链路时序

本章把 `ocr review` 的每一条指令级路径走一遍，标出每个函数所在的 `file:line`。这是前面所有章节的"串烧"。

## 19.0 前置：命令解析

```
review_cmd.go:83 RunE
 └─ validateReviewOptions(&reviewOpts)
 └─ executeReview(reviewOpts)
```

## 19.1 初始化装配（顺序很重要）

```
executeReview (review_cmd.go:95)
 │
 ├─[1] loadCommonContext(opts.repoDir, opts.rulePath, opts.maxTools, opts.maxGitProcs, true)
 │      shared.go:49
 │      ├─ template.LoadDefault()                 → embed task_template.json + prompts/*.md
 │      ├─ if maxTools > tpl.MaxToolRequestTimes: tpl.MaxToolRequestTimes = maxTools
 │      ├─ tpl.Validate()
 │      ├─ resolveWorkingDir(repoDirInput, true)  → git toplevel 锚定 (shared.go:84)
 │      ├─ rules.NewResolver(repoDir, rulePath)   → 4 层 composed resolver + FileFilter
 │      └─ gitcmd.New(maxGitProcs)                → git 子进程 semaphore(默认16)
 │
 ├─[2] applyCLIExcludes(cc, splitPaths(opts.excludes))   → --exclude 追加进 FileFilter.Exclude
 │
 ├─[3] validateReviewRefs(cc.RepoDir, opts)      → review_cmd.go:292 #112 安全校验
 │      每个 --from/--to/--commit: 不以'-'开头 + git rev-parse --verify --end-of-options <ref>^{commit}
 │
 ├─[4] if commit && !background: background = getCommitMessage()
 │      --background-file 则 resolveBackgroundFilePath + loadBackgroundFile + mergeBackground
 │
 ├─[5] if opts.preview: return runPreview(cc, opts)   → 只列文件，不调 LLM
 │
 ├─[6] loadReviewResumeState(cc.RepoDir, opts)
 │      review_cmd.go:232
 │      ├─ resume 需 range/commit（workspace 拒绝）
 │      ├─ session.LoadResumeState(repoDir, resumeID)  → 重放 JSONL 建 fingerprint 索引
 │      └─ state.ValidateOptions(current)              → 校验 range/commit 一致
 │
 ├─[7] loadLLMRuntime(cc.Template, opts.toolConfigPath, opts.model)
 │      shared.go:144
 │      ├─ toolsconfig.Load(toolConfigPath)            → embed tools.json
 │      ├─ agent.BuildToolDefs(entries, planOnly=true) → PlanToolDefs (code_search/file_read_diff/file_find)
 │      ├─ agent.BuildToolDefs(entries, planOnly=false)→ MainToolDefs (+task_done/code_comment/file_read)
 │      ├─ LoadAppConfig(defaultConfigPath())          → ~/.opencodereview/config.json
 │      ├─ tpl.ApplyLanguage(lang)
 │      └─ llm.ResolveEndpointWithModelOverride(cfgPath, opts.model)
 │             → 四策略瀑布：OCR config → OCR env → CC env → shell rc
 │          llm.NewLLMClient(ep)                        → anthropic/openai/openai-responses
 │
 ├─[8] fileReader = &tool.FileReader{RepoDir, Mode: review mode, Ref, Runner}
 │      buildToolRegistry(rt.Collector, fileReader)     → 注册 5 内置工具
 │
 ├─[9] initMCPClients(ctx, rt.AppCfg, tools, repoDir, Version)
 │      review_cmd.go:338
 │      └─ for each mcp_servers: 连 stdio/remote → mcp.RegisterAll(tools, mc, tools-filter)
 │      rt.PlanToolDefs  += mcpToolDefs
 │      rt.MainToolDefs  += mcpToolDefs
 │
 └─[10] agent.New(agent.Args{...})                     → 构造 Agent + llmloop.Runner
         agent.go:152
         ├─ a.runner = llmloop.NewRunner(llmloop.Deps{...DiffLookup: a.findDiff})
         └─ session 自动创建（mode=branch）
```

> 关键观察：`Tools.Freeze()` 发生在 `agent.Run` 里 `injectDiffMap` 之后（`agent.go:210`），所以 MCP 注册必须在 Run 之前完成——`[9]` 确实在 `agent.New` 之前。

## 19.2 `Agent.Run`：六步主流程

```
agent.Run(ctx) (agent.go:195)
 │
 ├─[A] loadDiffs(ctx)                       agent.go:334
 │      provider = (commit? NewCommitProvider : from&&to? NewProvider : NewWorkspaceProvider)
 │      parsed, err := provider.GetDiff(ctx)
 │        ├─ workspace: git diff HEAD --find-renames -U3 + git ls-files --others
 │        ├─ commit:    git show --find-renames -U3 <commit>
 │        └─ range:     git diff -U3 merge-base(from,to) <to>
 │      → diff.ParseDiffText 切 []model.Diff（含 NewFileContent 全文）
 │
 ├─[B] injectDiffMap()                      agent.go:365
 │      map[newPath]diffText → tool.FileReadDiffProvider.SetDiffMap
 │      a.args.Tools.Freeze()
 │
 ├─[C] countReviewable / filterDiffs        agent.go:866/887
 │      whyExcluded 五级过滤（binary/用户exclude/include放行/扩展名白名单/默认排除）
 │      → 打印 "[ocr] N file(s) changed, reviewing M in ..."
 │
 ├─[D] 预算估算（若 MaxTokensBudget>0）      agent.go:243
 │      est := estimateDiffCost(a.diffs) → 打印估算，超预算 WARNING
 │
 ├─[E] dispatchSubtasks(ctx)               agent.go:382
 │      ├─ filterLargeDiffs (token >80% MaxTokens 跳过)
 │      ├─ applyResume (fingerprint 命中则复用 comments)
 │      └─ for each diff: 预算gate → sem ← → go executeSubtask
 │            └─ 每文件 goroutine 内:
 │               defer recover() panic隔离 + subtaskFailed++
 │               超时 context.WithTimeout(ConcurrentTaskTimeout)
 │               executeSubtask(fileCtx, d)
 │      wg.Wait()
 │      CommentWorkerPool.Await()
 │      若 subtaskFailed == dispatched → error "all N file review(s) failed"
 │
 └─[F] session.Finalize()   → 写 session_end JSONL
```

## 19.3 `executeSubtask`：单文件 plan + main + filter

```
executeSubtask(ctx, d model.Diff) (agent.go:576)
 │
 ├─ changeFilesExcludingCurrent = buildChangeFilesExcept(newPath)   agent.go:804
 ├─ rule = resolveSystemRule(lower(newPath))                        agent.go:832
 │
 ├─[P] Phase 1: Plan
 │     if Template.PlanTask != nil && changeLines >= PLAN_MODE_LINE_THRESHOLD(50):
 │         executePlanPhase(ctx, newPath, d.Diff, changeFiles, rule)  agent.go:926
 │         ├─ 渲染 plan_task_system/user + 占位符替换
 │         ├─ LLMClient.CompletionsWithCtx(...)   ← 1 次 LLM 调用
 │         ├─ session.RecordPlanTask(...)
 │         └─ 返回 planResult (JSON)
 │     失败 → planResult=""，不阻断
 │
 ├─[M] Phase 2: Main（核心）
 │     messages = 渲染 main_task 占位符（agent.go:622）
 │        {{current_system_date_time}} {{current_file_path}} {{system_rule}}
 │        {{change_files}} {{diff}} {{requirement_background}} {{plan_guidance}}
 │        (planResult=="" → stripEmptyPlanBlock 先删掉空 plan 标题)
 │     tokenCount := CountMessagesTokens(messages)
 │     if tokenCount > PromptTokenLimit(MaxTokens): → skip with warning
 │
 │     mainCompleted, err := runner.RunPerFile(ctx, messages, newPath)   ← llmloop 主循环
 │
 ├─[R] Review Filter
 │     if err == nil:
 │        CommentWorkerPool.AwaitKey(newPath)   ← 等本文件异步评论
 │        executeReviewFilter(ctx, d, newPath)  agent.go:695
 │          ├─ comments := collector.CommentsForPath(newPath)
 │          ├─ 渲染 review_filter 占位符 {{path}}/{{diff}}/{{comments}}
 │          ├─ 1 次 LLM 调用，解析 JSON 剔除集合
 │          └─ collector.RemoveByPathAndIndices
 │
 └─ return (mainCompleted, "", err)
```

## 19.4 `llmloop.Runner.RunPerFile`：核心多轮循环

```
RunPerFile(ctx, messages, newPath) (llmloop/loop.go:149)
 │
 ├─ toolReqCount = MaxToolRequestTimes (默认30)
 ├─ compressionState{}.defer cancelPendingCompression
 │
 ├─ for toolReqCount > 0:
 │    ├─ select ctx.Done → return false, ctx.Err()
 │    ├─ toolReqCount--
 │    ├─ [L1] LLM 调用
 │    │     rec := fs.AppendTaskRecord(MainTask, messages copy)
 │    │     resp, err := LLMClient.CompletionsWithCtx(ChatRequest{Model, Messages, Tools: MainToolDefs, MaxTokens, SessionID})
 │    │     rec.SetResponse(resp, duration)
 │    │     atomic.Add(token counters...)          ← 累计真实 usage
 │    │     content := resp.Content(); calls := resp.ToolCalls()
 │    │
 │    ├─ [L2] if len(calls) == 0:
 │    │     append "You did not successfully call any tools..." user msg
 │    │     continue                              ← 不减 empty 计数
 │    │
 │    ├─ [L3] for each call: executeToolCall(ctx, newPath, call, rec)
 │    │      ├─ task_done:   DONE→Complete / FAILED→Fail / else→msg
 │    │      ├─ 未知工具:    Tools.Get(name) → MCP provider → Execute
 │    │      ├─ code_comment: ParseComments → SubmitFor(newPath, resolveAndCollect)
 │    │      │     resolveAndCollect: ResolveComment(cm,d) 失败→ ReLocateComment(LLM)
 │    │      │     → CommentCollector.Add(cm)          （异步，主循环立刻回 CommentSucceed）
 │    │      └─ 其它工具:    lookupTool.Execute(ctx, args) → 结果字符串
 │    │
 │    ├─ [L4] if taskCompleted → return true, nil
 │    ├─ [L5] empty-round 计数（≥3 break）
 │    │
 │    └─ [L6] addNextMessage(...)  llmloop/loop.go:458
 │           ├─ tryApplyPendingCompression(st, messages)
 │           ├─ if CountMessagesTokens > warnLimit(80%): cancel + runCompression 同步压缩
 │           ├─ append assistant(ToolCalls) + 每条 tool result
 │           ├─ if 追加后仍 > warnLimit: 再压缩一次
 │           ├─ if 60%<count<80%: triggerAsyncCompression 后台压缩
 │           └─ return count < warnLimit   （false → break）
 │
 └─ return false, nil（达到 toolReqCount 上限或压缩超限）
```

## 19.5 收尾输出

```
executeReview 收尾 (review_cmd.go:229)
 └─ emitRunResult(ctx, ag, comments, startTime, outputFormat, audience, q)   shared.go:276
      ├─ comments = diff.ResolveLineNumbers(comments, ag.Diffs())   ← 终极行号兜底
      ├─ telemetry.RecordReviewDuration / RecordCommentsGenerated
      ├─ if audience==agent && !json: q.Restore()（唤醒 stdout 打摘要）
      ├─ telemetry.PrintTraceSummary(...)
      └─ outputFormat==json ? outputJSONWithWarnings(...) : outputTextWithWarnings(...)
          JSON 结构含: comments / warnings / files reviewed / token 4件 / duration /
                       project_summary / tool_calls / trace_id / resume_info / session_id / budget_exceeded
```

## 19.6 一图流程

```
┌───────┐  ┌──────────────────┐  ┌─────────────────────┐  ┌──────────────────────────┐
│ CLIs  │→ │commonContext     │→ │ llmRuntime           │→ │ agent.Agent              │
│ parse │  │ (shared.go:49)   │  │ (shared.go:144)      │  │ (agent.go:195 Run)       │
└───────┘  │ template/resolver │  │ client/tooldefs/mcp │  └──────┬───────────────────┘
           │ gitrunner/filter  │  └─────────────────────┘         │
           └──────────────────┘                                   ▼
                                                  ┌─────────────────────────────┐
                                                  │ loadDiffs → filter →        │
                                                  │ dispatchSubtasks(×N goroutine)│
                                                  │  └ per-file:                │
                                                  │     plan(≥50行) →            │
                                                  │     RunPerFile(main loop) →  │
                                                  │     review_filter            │
                                                  └──────────┬──────────────────┘
                                                             ▼
                                        ┌─────────────────────────────────────┐
                                        │ llmloop.Runner.RunPerFile            │
                                        │  LLM→toolcalls→execute→compress→…   │
                                        │  (code_comment 异步走 CommentWorkerPool)│
                                        └─────────────────────────────────────┘
                                                             ▼
                                              emitRunResult → ResolveLineNumbers → JSON/Text
```

## 19.7 时间成本分析（落地参考）

假设 50 个文件、每文件 diff 平均 300 行、MaxTokens=58888：

- **plan phase**（仅变更 ≥50 行的文件）：每文件 1 次 LLM 调用，~2-5s。
- **main loop**：每文件通常 1-4 轮。每轮 LLM 延迟 ~3-15s（看模型）。工具调用毫秒级。code_comment 异步不阻塞。
- **review_filter**：每文件 1 次 LLM 调用，~2-4s。
- **并发 8** → 理论 50 文件 ÷ 8 × 单文件 ~15-40s ≈ **2-4 分钟**，加上 MCP 工具（若慢）可能到 5-10 分钟。

预算建议：CI 里给 job 至少 **10-15 分钟 timeout**，配合 `--timeout`（如 5）防止单文件卡死。
