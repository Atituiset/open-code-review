# 3. 核心概念词典

在深入源码前先固化一组贯穿全文的术语，避免后文每处都重新解释。

## 3.1 三种"review mode"

定义在 `internal/session/`（`ReviewModeWorkspace` / `ReviewModeRange` / `ReviewModeCommit` / `ReviewModeFullScan`），由 `cmd/opencodereview/review_cmd.go:258 reviewModeFromOptions` 推导：

| Mode | 触发条件 | diff 来源 | 支持断点续审? |
|------|---------|---------|------------|
| `workspace` | 不带 `--from/--to/--commit` | `git diff HEAD` + 未跟踪 | 否 |
| `range` | `--from A --to B` | `merge-base(A,B)..B` | 是 |
| `commit` | `--commit C` | `C^..C` | 是 |
| `full_scan` | `ocr scan` | 无 diff，走整文件 | 否 |

> 断点续审只支持 `range` / `commit`：workspace 没有稳定的 ref 锚定（`session/resume.go:178 ValidateOptions` 显式拒绝）。

## 3.2 三种"audience"

`--audience` 决定输出形式，影响 stdout 是否静音、JSON 是否带人话：

- `human`（默认）：彩条进度 + 文本摘要。
- `agent`：只 JSON（`--format json` 配套），用于 CI / IDE 插件 / VS Code 扩展消费。会调 `stdout.Quiet()` 把 `[ocr] ...` 进度线掐掉。
- `--preview`：不调 LLM，只列要审哪些文件，走 `agent.Preview` / `scan.Preview`。

## 3.3 三种"task template"

OCR 有两套独立的 prompt 模板，互不复用文本，只共享 `{{...}}` 占位符语法：

| 模板 | 文件 | pipeline | 含 5 个 task |
|------|------|---------|------------|
| Diff 模板 | `internal/config/template/task_template.json` + `prompts/*.md` | `ocr review` | MAIN / PLAN / MEMORY_COMPRESSION / REVIEW_FILTER / RE_LOCATION |
| Scan 模板 | `internal/config/template/scan_template.json`（prompt 文本内联）| `ocr scan` | MAIN / PLAN / DEDUP / PROJECT_SUMMARY / MEMORY_COMPRESSION / RE_LOCATION |

> 决策：两套分开是刻意的，让 prompt 可以独立演进（`internal/config/template/template.go:24` 注释）。

`MAX_TOKENS=58888`，`MAX_TOOL_REQUEST_TIMES=30`（diff）/ `60`（scan），`PLAN_MODE_LINE_THRESHOLD=50`，`MAX_FILE_SIZE_BYTES=2MiB`（scan）。

## 3.4 四层规则优先级

`internal/config/rules/system_rules.go:252 NewResolver` 合成 4 层 Resolver，**先匹配者赢**：

```
高  --rule <file>           (custom)   自定义规则文件
 │   <repo>/.opencodereview/rule.json (project) 仓库内
 │   ~/.opencodereview/rule.json      (global)  用户全局
低   embed system_rules.json + rule_docs/*.md  (system) 内核
```

每层内部都是"first-match-wins"，由 `path_rule_map` / `rules` 数组顺序决定。用户规则默认**替换**系统规则；当 entry 设 `"merge_system_rule": true` 时则**拼接**（`system_rules.go:384 mergeWithSystemRule`）。

## 3.5 六件套工具

`internal/tool/definitions.go` + `internal/config/toolsconfig/tools.json` 定义了六个内置工具，每个工具按"plan / main 阶段是否启用"分两段：

| 工具 | plan | main | 作用 |
|------|-----|-----|-----|
| `task_done` | ❌ | ✅ | 终止本轮任务，参数 `state: DONE\|FAILED` |
| `code_comment` | ❌ | ✅ | 上报问题，含 `existing_code` 滑动窗口锚点；异步处理 |
| `file_read` | ❌ | ✅ | 读当前文件指定行段，>500 行截断 |
| `code_search` | ✅ | ✅ | 文本/正则搜索，含 git pathspec include/exclude |
| `file_read_diff` | ✅ | ✅ | 读**其它**改文件的 diff（cross-file 上下文） |
| `file_find` | ✅ | ✅ | 按文件名查 |

MCP 工具也会被注册进同一个 `tool.Registry`（`mcp.RegisterAll`），对 LLM 来说无差别。

## 3.6 评论模型 `LlmComment`

`internal/model/review.go` 定义，关键字段：

| 字段 | 含义 |
|------|------|
| `Path` | 被审文件，**强制覆盖**为当前子任务文件（`llmloop.go:348 args["path"] = newPath`） |
| `Content` | 评论正文 |
| `ExistingCode` | 评论锚点的代码片段（≥1 行），用来在 diff 里定位行号 |
| `SuggestionCode` | 可选的修复建议 |
| `StartLine`/`EndLine` | 最终行号，由 `diff.ResolveComment` / `ReLocateComment` 填充 |
| `Category` | `bug\|security\|performance\|maintainability\|test\|style\|documentation\|other` |
| `Severity` | `critical\|high\|medium\|low` |

## 3.7 关键预算数字

| 量 | 默认值 | 出处 |
|----|------|-----|
| `MaxTokens` | 58888 | `task_template.json` / `scan_template.json` |
| `MaxToolRequestTimes` | 30 (diff) / 60 (scan) | 同上 |
| `PlanModeLineThreshold` | 50 行 | 同上 |
| Token 警戒线 | 80% MaxTokens | `llmloop/compression.go:19 tokenWarningThreshold` |
| Token 软压缩线 | 60% MaxTokens | `llmloop/compression.go:18 tokenSoftThreshold` |
| MaxConcurrency | 8（`<=0` 时默认） | `agent.go:399` / `scan/agent.go:469` |
| git 并发上限 | 16 | `gitcmd/runner.go:11 defaultMaxConcurrent` |
| MaxFileSizeBytes（scan） | 2 MiB | `scan/provider.go:33 DefaultMaxFileSizeBytes` |
| 规则文件大小上限 | 512 KB | `rules/system_rules.go:543` |
| 单 comment 内容截断（scan summary）| 280 字符 | `scan/agent.go:692 maxLine` |
| Anthropic SDK 重试 | 5 次 | `llm/client.go:593 option.WithMaxRetries(5)` |
| OpenAI SDK 重试 | 5 次 | `llm/client.go:314 openaiopt.WithMaxRetries(5)` |
| MCP 初始化超时 | 30s | `review_cmd.go:360/397` |
| MCP setup 超时 | 5 分钟 | `review_cmd.go:378` |
| 单文件子任务超时 | `--timeout`（默认 10，0=无限）| `agent.go:403` |

## 3.8 三种 LLM 协议

`internal/llm/protocol.go` 给出三个 canonical 名字：

- `anthropic` — Anthropic Messages API（`/v1/messages`）
- `openai` — OpenAI Chat Completions（`/chat/completions`）
- `openai-responses` — OpenAI Responses API（`/responses`）

`NewLLMClient`（`llm/client.go:205`）按 `ep.Protocol` dispatch，**未识别的协议退回 OpenAIClient**，保证 legacy 调用者不会被破坏。18 个内置 provider 预设见 13 章。
