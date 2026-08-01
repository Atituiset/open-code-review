# 10. scan：全文件审查管线

`internal/scan/` 是 `ocr scan` 的实现。和 `ocr review` 的根本区别是 **没有 diff**——它把整文件作输入让 LLM 全文审，适合"审陌生仓 / 审应该走的重构目录"。但我们将在本章看到它和 `agent` 共享 `llmloop.Runner`，证明第 7 章那个抽象的可复用性。

## 10.1 文件清单

| 文件 | 职责 |
|------|------|
| `agent.go` | `Agent`、`Run`、`dispatchSubtasks`、`dispatchBatch`、`executeSubtask`、`maybeRunPlan` |
| `provider.go` | `Provider.Enumerate` 列文件（git ls-files 或 filepath.WalkDir） |
| `batch.go` | `BatchStrategy` + `groupBatches`：by-language / by-directory / none |
| `estimate.go` | scan 成本估算 |
| `preview.go` | `--preview` 模式 |

## 10.2 `Agent.Args` vs `agent.Args`

scan 的 `Args`（`agent.go:38`）和 diff-review 的几乎平行，但有几个关键差异：

- 多了 `Paths []string`（自定义扫描范围；空=全仓）
- `Template` 是 **`template.ScanTemplate`**（独立 scan 模板）而非 diff 的 `template.Template`
- 多了 `MaxFileSizeBytes int64`（默认 2 MiB 硬上限）
- 多了三个 skip 开关：`SkipPlan` / `SkipDedup` / `SkipSummary`
  → 对应 `--no-plan` / `--no-dedup` / `--no-summary`
- 没有 `ReviewMode` / `From` / `To` / `Commit` / `Resume` —— scan 不支持续审

`NewAgent` 自动构造 `llmloop.Runner`（`agent.go:123`），其中：

```go
DiffLookup: a.lookupDiff,  // 返回合成 Diff，让 code_comment 复用 resolveFromFileContent
```

`lookupDiff`（`agent.go:275`）从 `a.items[i].AsDiff()` 拿到一个合成 Diff，`NewFileContent = it.Content`，`Diff = ""` —— 这是 scan 模式下行号定位复用 diff-review 代码的桥。

`Template` 经过 `toLoopTemplate()`（`agent.go:145`）投影成 `llmloop` 只读的子集：`MemoryCompressionTask / ReLocationTask / MaxTokens / MaxToolRequestTimes`。其他字段（PlanTask / MainTask / ReviewFilterTask / DedupTask / ProjectSummaryTask）留空让 scan 在自己包内编排。

## 10.3 `Run` 五步管线

`scan/agent.go:208`：

```
1. Enumerate (provider.Enumerate)
   ├─ isGitRepo ? git ls-files -z + git ls-files --others --exclude-standard -z → 去重
   └─ 否则 filepath.WalkDir + 加载 .gitignore + ExcludedDirs 黑名单

2. injectScanContentMap
   把所有 file 内容 map[path]content 灌给 file_read_diff 工具
   （即使 scan 没有 diff，模型若调该工具也能拿到整文件）

3. filterScanItems → filterLargeScans
   ─ binary 跳过
   ─ 用户 exclude → ExcludeUserRule
   ─ 用户 include（若配置） → 优先放行（#371）
   ─ 扩展名不在 IsAllowedExt → ExcludeExtension
   ─ 默认排除路径（测试等）→ ExcludeDefaultPath
   ─ file tokens > 80% MaxTokens 跳过

4. estimateCost → 打印估算
   若 MaxTokensBudget>0 且估算超 → WARNING

5. dispatchSubtasks
   groupBatches(strategy, size) → 顺序跑 batch，每个 batch 内 per-file 并发
   └─ 每 batch 结束：
      ├─ CommentWorkerPool.Await (这 batch 的 async 评论全收)
      ├─ maybeRunDedup  (DEDUP_TASK 合并近重复)
      └─ budgetHit? break

6. maybeRunProjectSummary (PROJECT_SUMMARY_TASK 整仓汇总，best-effort)

7. session.Finalize
```

## 10.4 `dispatchSubtasks` 与 `dispatchBatch`：batch × file 二级并发

`scan/agent.go:393`：

- **batch 之间串行**：为了 DEDUP_TASK 能拿到本批所有 comment，且相邻 batch 提高同语言 prompt cache 命中率。
- **batch 内并发**：`sem := make(chan struct{}, MaxConcurrency)`，每文件起一个 goroutine 跑 `executeSubtask`，`MaxConcurrency` 默认 8。

预算 gate 在 `dispatchBatch:483`：每文件 acquire slot 前检查 `used + estimateFileTokens(file, plan) > budget`，超了 `budgetHit=true; break` 这个 batch 剩下的文件也不再调度（和 agent 一样的设计，不取消在飞的）。

## 10.5 `executeSubtask`：每文件两步

`scan/agent.go:543`：

```
executeSubtask(ctx, it model.ScanItem):
  rule = SystemRule.Resolve(it.Path)
  planGuidance = maybeRunPlan(ctx, it, rule)            // ① PLAN_TASK（可选）
  messages = renderMessages(it, rule, planGuidance)      // ② 占位符替换
  if tokenCount > PromptTokenLimit(MaxTokens): skip with warning
  runner.RunPerFile(ctx, messages, it.Path)              // ③ 核心 agent loop
```

`renderMessages`（`agent.go:904`）把 scan MAIN_TASK 模板的 5 个占位符 `{{current_file_path}}` / `{{system_rule}}` / `{{file_content}}` / `{{plan_guidance}}` / `{{requirement_background}}` 全替换。注意 `{{change_files}}` 在 scan 里被替换成 `"(not applicable in full-scan mode)"`，因为 scan 没有其它改文件概念。

## 10.6 `maybeRunPlan` 输出格式

`agent.go:591`：PLAN_TASK 让 LLM 输出 JSON：

```json
{
  "summary": "一句话文件描述",
  "checkpoints": [
    {"focus": "...", "lines": "45-78", "why": "..."}
  ]
}
```

`formatPlanGuidance`（`agent.go:854`）把 JSON 翻译成 prompt 嵌入的 markdown。失败时回退原文本（不做硬拒绝）。

## 10.7 `maybeRunDedup`：批内去重

`agent.go:713` 跑 DEDUP_TASK。触发条件：

- `dedupEnabled()` = template 有 DedupTask 且没 `--no-dedup`
- `len(batchComments) >= DedupMinComments`（默认 2；scan_template.json 里是 4）

让 LLM 把 `batch_comments` 分组，输出 JSON：

```json
{ "groups": [
   {"members": ["c-0","c-2"], "merged_content": "合并内容"}
] }
```

`applyDedupGroups`（`agent.go:796`）严格校验：
- 不能漏任何 id（`len(seen) != len(originals) → return false`）
- 不能重复 id
- 不能有未知 id
- 任何违规直接 return false，**保持原 batch 不动**——这是 dedup 永远只是优化、不是 correctness gate 的硬保证。

成功才 `collector.ReplaceSince(batchStart, deduped)`。

## 10.8 `maybeRunProjectSummary`：整仓汇总

`agent.go:637`：跑完所有 batch 后，若 `summaryEnabled` 且至少有 1 条 comment，把所有 comment 渲染成 markdown 列表（每条截断 280 字符）喂给 PROJECT_SUMMARY_TASK 让 LLM 总结成：

- Top Issues
- Module Hotspots
- Cross-Cutting Concerns
- Quick Wins

输出 markdown 写进 `a.projectSummary`，最终通过 `emitRunResult` 在 agent-text 模式打印或在 JSON 里以 `project_summary` 输出。best-effort：失败也不影响 comments。

## 10.9 scan 与 review 的对比表

| 维度 | 录入 | diff-review (`agent`) | full-scan (`scan`) |
|------|-----|---------|--------|
| 输入 | | diff 文本 | 整文件内容 |
| 文件发现 | | git diff 输出 | git ls-files / Walk |
| 大小上限 | | diff token > 80% MaxTokens skip | 2 MiB 字节 + 80% tokens |
| 子任务并发 | | max 8 per-file | max 8 per-file （batch 内）|
| 子任务 | | plan+main+filter | plan+main |
| 后处理 | | review_filter | dedup + 项目摘要 |
| 文件顺序 | | 按 diff 顺序 | by-language group adjacent |
| 断点续审 | | range/commit 支持 | 不支持 |
| 输出额外字段 | | resume_info | project_summary |

## 10.10 何时用 scan 而不是 review

- **继承陌生代码库**：跑 `ocr scan --path <dir>` 全审一遍，快速建立问题地图。
- **重构一个目录**：审整体设计问题，而不只是改动的行。
- **README / 配置审查**：没 diff 概念的文件类型可选 scan（虽然 review 默认就走 `--find-renames`）。

scan 调用更贵（每文件 = 整文件 token + 可能 plan + 可能 dedup + 项目 summary），所以**不要在 CI 里每次 PR 都跑 scan**——它定位是按需的深度审计。`review` 是日常 diff 守门，`scan` 是周期性深度审计。
