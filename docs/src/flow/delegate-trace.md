# 21. 委派模式三步走时序

委派模式（delegate）是 OCR 所有模式里**唯一不调用 LLM** 的路径。本章按官方 SKILL.md 推荐的宿主 Agent 工作流走一遍，标注代码入口。

## 21.0 角色分工

```
OCR (确定性工程)  ──►  提供 review spec（文件清单 + 规则分组 + git 元数据）
        │                    │
        │   无 LLM 调用      │
        ▼                    ▼
宿主 Agent（Claude Code / Codex / Cursor / OpenCode）
   用自己的 LLM 执行实际审查，产出自定义 JSON
```

## 21.1 Step 1：`ocr delegate preview`

```
delegate_cmd.go:156 executeDelegatePreview
 ├─ loadDelegateContext(opts)
 │    ├─ loadCommonContext(..., requireGit=true)   ← 无 loadLLMRuntime！
 │    ├─ applyCLIExcludes
 │    └─ validateReviewRefs  ← #112 ref 注入安全校验
 ├─ preview := ag.Preview(ctx)                     ← agent/preview.go
 │    └─ 用 diff.Provider.GetDiff 拿所有变化文件，跑 whyExcluded 过滤
 │    └─ 返回 DiffPreview{TotalFiles, ReviewableCount, Insertions, Deletions, Entries[]}
 ├─ mergeBase := dc.mergeBase(ctx)                 ← range 模式: git merge-base
 ├─ 输出 markdown:
 │    # Files (N reviewable / M total)
 │    - mode: range / commit / workspace
 │    - from / to / commit / merge_base / background / total_insertions / total_deletions
 │    - 每文件: `path` [STATUS] +N/-N  （排除的用 ~~strikethrough~~ 标原因）
 └─ 宿主 Agent 解析此 spec 决定审哪些文件
```

## 21.2 Step 2：`ocr delegate rule <paths...>`

```
delegate_cmd.go:204 executeDelegateRule
 ├─ loadDelegateContext
 ├─ groups := delegate.GroupRules(dc.resolver(), paths)   ← delegate/rulegroup.go:24
 │    for each path:
 │      detail := resolver.ResolveDetail(path)  ← DetailResolver: source/pattern/text
 │      key := source + "\x00" + pattern + "\x00" + text   → 分到同组
 ├─ fmt.Print(delegate.RuleGroupsMarkdown(groups))         ← delegate/format.go
 └─ 宿主 Agent 拿到按规则内容分组的文件清单 + 各组规则文本
```

**为什么按 source|pattern|text 分组**：两个文件即使规则文本相同，但 provenance 不同（如 `--rule` 文件 vs 项目 rule.json）应分开，保证每组的 source/pattern 元数据对组内每文件都准确（`rulegroup.go:10-16`）。

## 21.3 Step 3：宿主 Agent 取 diff

`ocr delegate preview` 给了 `mode` / `from` / `to` / `merge_base`，宿主 Agent 按模式自取 diff：

| mode | 宿主取 diff 命令 |
|------|-----------------|
| workspace | `git diff HEAD` + `cat` 未跟踪文件 |
| range | `git diff <merge_base>..<to> -- <path>` |
| commit | `git show <commit>` |

> 注意：SKILL.md 强调 **workspace 模式的未跟踪文件用 `cat` 而不是 `git diff`**（git diff 不含未跟踪文件）。

## 21.4 Step 4：宿主 Agent 审查

宿主 Agent 用自己擅长的 LLM 跑审查，输出规范化的 JSON 数组：

```json
[
  {
    "path": "src/auth/login.go",
    "content": "使用 == 比较浮点数...",
    "start_line": 45,
    "end_line": 47,
    "category": "bug",
    "severity": "high"
  }
]
```

## 21.5 Step 5-7：分级 + 修复

SKILL.md 建议按 severity 分组处理：high 自动修、medium/low 人工确认。

## 21.6 delegate 的边界（源码证据）

| 问题 | 答案 | 源码证据 |
|------|------|---------|
| OCR 调 LLM 吗？ | **不** | `loadDelegateContext` 不调 `loadLLMRuntime`（`delegate_cmd.go:84`） |
| OCR 生成 comments 吗？ | **不** | 只输出 spec 文本 |
| OCR 提供哪些工程保证？ | 文件选择 + 规则解析 + git 元数据 | `agent.Preview` + `delegate.GroupRules` |
| 需要 LLM 配置吗？ | 不需要（但规则、git、repo 需要） | — |
| 需要 Git ≥ 2.41 吗？ | 是 | 官方 README 前置条件 |

## 21.7 与 review/scan 的对比

| | review | scan | delegate |
|--|--------|------|----------|
| LLM 谁跑 | OCR | OCR | 宿主 Agent |
| 输出 | comments | comments + summary | spec（文件+规则+git 元数据）|
| 行号定位 | OCR 四层防御 | OCR 全文扫 | 宿主负责 |
| 适用 | 日常 diff 审查 | 深度审计 | 把 OCR 的工程选择借给自有 Agent |

## 21.8 落地场景

- 团队已深度依赖 Claude Code / Codex，希望 review 质量提升但不想再买一份 LLM 配额 → delegate。
- OCR 在 CI 里跑 `--audience agent` 太贵，希望开发者本地自己 Agent 审 → delegate。
- 你有一套私有 Agent 流程（内部代码理解 + 工单联动），OCR 只做 file selection 和 rule → delegate。
