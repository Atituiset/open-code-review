# 20. `ocr scan` 全链路时序

scan 与 review 共享 `llmloop.Runner`，但顶层完全不同：它枚举文件而非解析 diff，分批处理且有 dedup / 项目摘要两个 review 没有的阶段。

## 20.1 命令初始化

```
scan_cmd.go:67 RunE → executeScan(opts)
 │
 ├─[1] loadCommonContext(repoDir, rulePath, maxTools, maxGitProcs, false)  ← requireGit=false
 │      非 git 目录也能跑（IsGitRepo=false）
 │
 ├─[2] applyCLIExcludes
 │
 ├─[3] scanTpl := template.LoadScanDefault()   ← 独立 scan 模板
 │      maxTools 上抬 / --batch 覆盖 BatchStrategy / --max-tokens-budget 覆盖
 │
 ├─[4] if preview: runScanPreview
 │
 ├─[5] rt := loadLLMRuntime(cc.Template, toolConfigPath, opts.model)
 │      scanTpl.ApplyLanguage(rt.AppCfg.Language)   ← scan 模板也吃语言
 │
 ├─[6] scanToolDefs := excludeToolDef(rt.MainToolDefs, "file_read_diff")  ← scan 无 diff，砍掉该工具
 │      fileReader := &tool.FileReader{RepoDir, ModeWorkspace, Runner}
 │      tools := buildToolRegistry(...)
 │
 └─[7] ag := scan.NewAgent(scan.Args{...})
         ├─ runner = llmloop.NewRunner(Deps{DiffLookup: a.lookupDiff, ...})
         └─ session（mode=full_scan）
```

## 20.2 `scan.Agent.Run`

```
Run(ctx) (scan/agent.go:208)
 │
 ├─[A] provider := scan.NewProvider(repoDir, paths, gitrunner, MaxFileSizeBytes)
 │      items, err := provider.Enumerate(ctx)      → scan/provider.go:77
 │        ├─ listFiles:
 │        │   ├─ isGitRepo ? listFilesViaGit : listFilesViaWalk
 │        │   ├─ git:  git ls-files -z + git ls-files --others --exclude-standard -z → 去重
 │        │   └─ walk: filepath.WalkDir + gitignore 过滤 + 跳过 ExcludedDirs
 │        ├─ filterByPaths（若 --path 指定）
 │        ├─ 逐文件: Lstat / 大小上限(2MiB) / isBinaryFile(NUL 嗅探) / ReadFile
 │        └─ → []model.ScanItem{Path, Content, IsBinary, LineCount}
 │
 ├─[B] injectScanContentMap()                     → 把 content 灌给 file_read_diff 工具
 │      Tools.Freeze()
 │
 ├─[C] filterScanItems (agent.go:306) → whyExcluded 五级
 │      filterLargeScans (agent.go:328) → token >80% MaxTokens 跳过
 │      → "[ocr] full-scan: N file(s) discovered, reviewing M in ..."
 │
 ├─[D] 估算打印（scan/estimate.go）
 │
 ├─[E] dispatchSubtasks (agent.go:393)
 │      strategy := resolveBatchStrategy()          → by-language / by-directory / none
 │      batches := groupBatches(items, strategy, BatchSize=50)
 │
 │      for bi, batch := range batches {            ← batch 串行
 │         batchStart := collector.Snapshot()
 │         n, budgetHit, err := dispatchBatch(ctx, bi, batch)   ← batch 内文件并发(≤MaxConcurrency)
 │         CommentWorkerPool.Await()                ← 本 batch 异步评论全部收
 │         maybeRunDedup(ctx, bi, batchStart)       ← DEDUP_TASK 合并近重复
 │         if budgetHit { break }
 │      }
 │
 ├─[F] maybeRunProjectSummary(ctx, comments)       ← PROJECT_SUMMARY_TASK，best-effort
 │
 └─[G] session.Finalize()
```

## 20.3 `dispatchBatch`：batch 内并发

```
dispatchBatch (agent.go:466)
 ├─ concurrency := MaxConcurrency (默认8)；sem := make(chan, concurrency)
 ├─ for each item:
 │    ├─ 预算 gate: used + estimateFileTokens(file, plan) > budget → budgetHit=true; break
 │    ├─ sem <- struct{}{}
 │    ├─ go func(it):
 │    │     defer wg.Done(); defer <-sem
 │    │     timeout→ fileCtx WithTimeout
 │    │     executeSubtask(fileCtx, it)
 │    │        err→ subtaskFailed++ / telemetry error / warning
 │    └─
 └─ wg.Wait()
```

## 20.4 `executeSubtask`：单文件

```
executeSubtask (agent.go:543)
 ├─ rule = SystemRule.Resolve(it.Path)
 ├─ planGuidance = maybeRunPlan(ctx, it, rule)    ← ① PLAN_TASK（可选，--no-plan 关）
 │     渲染 plan 占位符 → 1 次 LLM → formatPlanGuidance
 │     失败回退 "(no pre-scan plan; ...)"
 ├─ messages = renderMessages(it, rule, planGuidance)   ← ② 占位符替换
 │     {{plan_guidance}} {{current_system_date_time}} {{current_file_path}}
 │     {{system_rule}} {{change_files}}="(not applicable...)" {{file_content}} {{requirement_background}}
 ├─ if tokenCount > 80% MaxTokens: skip
 └─ runner.RunPerFile(ctx, messages, it.Path)     ← ③ llmloop 主循环（同第 19.4）
       └─ code_comment → DiffLookup(it.Path) → 合成 Diff（NewFileContent=全文）→ ResolveComment 走全文扫
```

## 20.5 `maybeRunDedup`：批内去重

```
maybeRunDedup (agent.go:713)
 ├─ 条件: dedupEnabled && batchComments >= DedupMinComments
 ├─ payload = buildDedupCommentsJSON(batchComments)    ← c-0..c-N ids
 ├─ DEDUP_TASK 1 次 LLM → {groups:[{members,merged_content}]}
 ├─ applyDedupGroups:
 │    ├─ 必须覆盖所有 id、不重复、无未知 id → 否则 return false（保持原样）
 │    └─ collector.ReplaceSince(batchStart, deduped)
 └─ 输出 "[ocr] scan dedup batch #N: X → Y comments"
```

## 20.6 `maybeRunProjectSummary`：整仓汇总

```
maybeRunProjectSummary (agent.go:637)
 ├─ 条件: summaryEnabled && len(comments)>0
 ├─ payload = 每条 comment 渲染成 "- `path`: <content截断280字符>"
 ├─ PROJECT_SUMMARY_TASK 1 次 LLM → markdown
 └─ a.projectSummary = body
```

## 20.7 收尾

```
emitRunResult (scan_cmd.go:201 → shared.go:276)
 ├─ ResolveLineNumbers（scan 的合成 Diff 走全文扫）
 ├─ PrintTraceSummary
 └─ JSON/text 输出（含 project_summary 字段）
```

## 20.8 成本画像

scan 比 review 贵一个量级：

| 场景 | 每文件 LLM 调用次数 | 说明 |
|------|---------------------|------|
| review 小文件（<50 行变更） | 1（main）+ 1（filter）| plan 跳过 |
| review 大文件（≥50 行变更） | 1（plan）+ main×N + 1（filter）| plan 触发 |
| scan | 1（plan 可选）+ main×N + dedup/批 + summary/仓 | 整文件进 prompt |

一个 2000 行的大文件 scan，main 阶段 prompt 就要吃掉整文件 token（比如 58888 上限内的 ~10-20k），加上工具调用膨胀。**scan 整个仓 = 一次全仓 audit 的开销**，切勿在 CI 每次 push 里跑。`ocr scan --path` 定向扫关键目录更合适。
