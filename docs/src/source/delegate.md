# 11. delegate：委派模式（无 LLM）

`internal/delegate/` 是 OCR 设计上"反直觉"的一支：**OCR 调用一次 LLM 都不调用**，只生成一份"审查规约 spec"丢给宿主 Agent（Claude Code / Codex / Cursor / Open Code）让它用自己的 LLM 跑审查。OCR 这边贡献的是确定的 file selection + rule resolution 工程模块；宿主贡献的是它自己的 LLM。

这个模式在落地层非常有用——见第 27 章。

## 11.1 命令三步走

ocr CLI 通过 `delegate_cmd.go` 暴露两个子命令：

```
ocr delegate preview [--from A --to B|--commit C]  → 列要审的文件 + mode/ref
ocr delegate rule <path1> <path2> ...              → 按规则内容分组，输出 markdown
```

SKILL.md 里建议宿主 Agent 三步走：
1. `ocr delegate preview` → 拿 mode/refs/文件列表/排除原因
2. `ocr delegate rule <paths>` → 拿分组好的规则
3. `git diff merge_base..to -- <path>` → 拿每文件 diff
4. 宿主 Agent 自己审查，输出 `{path, content, start_line, end_line, category, severity}` JSON

注意 OCR 不仅不调 LLM 跑 review，**也不输出 comments**。输出 spec 让宿主发挥。

## 11.2 `loadDelegateContext`：不调 `loadLLMRuntime`

`delegate_cmd.go:84 loadDelegateContext` 只调用 `loadCommonContext`（拿 template + repoDir + rules + git runner），**不调用 `loadLLMRuntime`**——这就是"delegate 无 LLM"在代码层的硬证据。

它依然触发了一些规则校验：
- `validateReviewRefs`：`--from/--to/--commit` 参数安全校验（#112），防 ref 注入；
- `loadBackgroundFile` / `getCommitMessage`：处理 `--background` / `--background-file`，把上下文也写到 spec 里给宿主看。

## 11.3 `executeDelegatePreview`：spec 文本

`delegate_cmd.go:156 executeDelegatePreview`：

```
# Files (N reviewable / M total)

- mode: range
- from: main
- to: feature-x
- merge_base: 3f8a...
- background: <字符串或commit message>

- total_insertions: 1234
- total_deletions: 56

  - `src/auth/login.go` [MODIFIED] +120/-34
  - `src/auth/util.go` [ADDED] +50/-0
~~  - `vendor/lib.go` [MODIFIED] +30/-2 (excluded: filtered by path/extension rules)  ~~
  - `internal/diff/parse.go` [RENAMED] +5/-5
```

被排除的文件用 `~~...~~` 包起来，给宿主看一个明确"哪些不审"的信号。

`ag.Preview` 在 `internal/agent/preview.go` 实现，返回结构化 `DiffPreview{TotalFiles, ReviewableCount, TotalInsertions, TotalDeletions, Entries}`，CLI 层把它渲染成上面的文本。

## 11.4 `executeDelegateRule`：`delegate.GroupRules`

`delegate_cmd.go:204`：

```go
groups := delegate.GroupRules(dc.resolver(), paths)
fmt.Print(delegate.RuleGroupsMarkdown(groups))
```

`internal/delegate/rulegroup.go:24 GroupRules` 实现核心：

```go
for _, path := range paths {
    if hasDetail {
        detail := dr.ResolveDetail(path)     // rules.DetailResolver
        source  = detail.Source  // "custom"|"project"|"global"|"system"
        pattern = detail.Pattern // 匹配的 glob，或 "default"
        text    = detail.Rule
    } else {
        text = resolver.Resolve(path)
        source = "system"; pattern = "default"
    }
    key := source + "\x00" + pattern + "\x00" + text
    // 同 key → 同 group
}
```

**为什么按 `source|pattern|text` 分组而不是按 `text` 分组**：注释明确说"两个文件有相同规则文本但不同 provenance（比如不同 pattern 匹配）应该分到不同组"，这样每组的 `Source/Pattern` 元数据对组内每个文件都准确。

`fmt.go` 的 `RuleGroupsMarkdown` 输出大概长这样（概化）：

```markdown
## Rule group 1
- source: project
- pattern: src/**/*.go
- files: internal/agent/agent.go, internal/llm/client.go
- rule:
  <rule text>
```

宿主 Agent 拿到后可以批量审（一组一组审，避免每次切 prompt）。

## 11.5 `delegate.format.go` 与 `RuleGroupsMarkdown`

`format.go` 包含：

- `RuleGroupsMarkdown(groups)`：把 `[]RuleGroup` 渲染成 markdown，每段含 `source` / `pattern` / `files` / `rule` 文本。
- 测试在 `format_test.go` 验证不同 group 输出顺序、空 group 处理。

## 11.6 安全：`paths` 不被本仓之外影响

`ocr delegate rule <paths>` 接受任意路径列表，但 `rules.Resolver.ResolveDetail(path)` 只在仓内 path 上匹配 glob 不会"调" path，所以路径注入风险低。Path 是否真实存在由宿主决定，OCR 不开文件句柄。

## 11.7 何时用 delegate vs review

- **你的 Agent 反正有 Claude Code 之类的 LLM 配额** → delegate，省一份 LLM 调用。
- **OCR 尚未配好 LLM 但想立刻升级团队 Agent 的 review 质量** → delegate。
- **要让 OCR 跑独立 LLM** 用 review/scan。

主流用户两种都用 review（OCR-managed LLM），因为 prompt 在 task_template.json 里被深度调过。delegate 适合"我有自己的 Agentic 路径但 OCR 的 file selection / rule 匹配更好"的场景，价值在 coworking 而非竞争。
