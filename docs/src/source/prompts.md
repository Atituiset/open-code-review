# 14. prompt 模板：提示词工程内幕

`internal/config/template/prompts/` 和 `scan_template.json` 内联文本是 OCR 提示词工程的实物。本章把每张提示词拆开看，让你理解 OCR 是怎么"对 prompt 进行工程化"的。

## 14.1 占位符语法

OCR 用的不是 Go `text/template`，而是简单的 `strings.ReplaceAll` 替换。两种占位符：

- **双花括号** `{{name}}`：大多数提示词用。
- **单花括号** `{name}`：`re_location_task_user.md` 用（这个 prompt 设计初期走过单独路径，留了不一致的语法）。

替换在 `agent.executeSubtask`（`agent.go:622`）和 `scan.renderMessages`（`scan/agent.go:904`）里逐字 `strings.ReplaceAll(content, "{{...}}", value)`。

## 14.2 diff-review 的五个 prompt 剖析

### 14.2.1 `main_task_system.md`（system, 25 行）

定义 LLM 角色："open-code-review code review assistant by Alibaba"，运行在用户的 IDE/staging area。明确指示：

- 阅读统一 diff（`-` 删除、`+` 添加），只关注新代码。
- 客观、中立。
- 跳过 metadata/annotations 除非明确要求。
- **Strict Focus Rules**：评论只针对当前 diff。
- 回复纪律：`task_done` 收工 / `code_comment` 报 issue / 上下文工具按需调。

不含占位符。语言由 `ApplyLanguage` 后加。

### 14.2.2 `main_task_user.md`（user, 25 行）

**这是 OCR 最重要的 prompt**。占位符最多：

```
<other_changed_files>
{{change_files}}                  ← 别的修改文件列表 (status + path)
</other_changed_files>

<current_file_path>{{current_file_path}}</current_file_path>

<current_file_diff>
{{diff}}                          ← 当前文件的 unified diff
</current_file_diff>

Current time in the real world: {{current_system_date_time}}

### Requirement Background (Optional)
{{requirement_background}}        ← --background / --background-file / commit msg

### Review Checklist
{{system_rule}}                   ← rule_docs/*.md 的文本

### Review Plan (Optional)
{{plan_guidance}}                  ← 来自 PLAN_TASK 的 JSON 渲染 markdown
```

注：`{{plan_guidance}}` 为空时 `stripEmptyPlanBlock` 把 `"### Review Plan (Optional)"` 标题一起去掉。

### 14.2.3 `plan_task_system.md`（37 行）

PLAN_TASK 的 system：

- 角色：planner。
- 输出强约束：单一 JSON 对象 `{change_summary, items: [{severity, description, tool_guidance[]}], sort: high→low}`。
- severity 定义：`high`=安全/数据丢失、`medium`=性能/可维护、`low`=风格。
- `{{plan_tools}}` 是工具列表描述（reference only，模型被告知"不要调"，只看 description 决定 main 阶段怎么用）。

只在 main_task **之前**触发一次（diff 变更行 ≥50）。失败时 OCR **不阻断**（planResult=""）。

### 14.2.4 `plan_task_user.md`

含 `{{change_files}}`、`{{current_file_path}}`、`{{diff}}`、`{{current_system_date_time}}`、`{{requirement_background}}`、`{{system_rule}}`。结尾 "Start with ```json"。

### 14.2.5 `review_filter_task_system.md` + `_user.md`

后处理：剔除"被 diff 直接证伪"的评论。这是 OCR "精度优先" 的命门 prompt。

`review_filter_task_system.md`（7 行）的核心：

> "The reviewing agent that produced these comments had access to tools to read the full file contents and search the codebase. You only see the diff. Filter out only comments **provably incorrect based solely on the diff**. If a comment might be correct but you can't tell, leave it in—the original agent may have seen context you can't see."

`review_filter_task_user.md`（55 行）的协议：

1. Step 1 Fact Check："Only flag when diff provides direct counter-evidence." Veto rule。
2. Step 2 Issue Classification："Does it misidentify normal code as a defect?"
3. 输出 JSON 数组如 `["c-3","c-7"]`，其它评论保留。

`{{path}}`、`{{diff}}`（fenced block + path header）、`{{comments}}`（JSON 列表含 c-0..c-N id/content/existing_code）。

### 14.2.6 `re_location_task_system.md` + `_user.md`

重定位 prompt。`system` 只有 1 行："You are a code-location assistant. Extract the lines from the unified diff that the review comment refers to. End with `/no_think`."

`user`（20 行）规则：

- 一字不差复制 diff 行
- 去掉 `+`/`-` 前缀
- 选最相关位置
- **只输出一个 fenced code block**

占位符用单花括号：`{diff}`、`{existing_code}`、`{suggestion_content}`。`{suggestion_content}` 是评论 `content` 字段，让 LLM 知道评论在说什么以判断 referring 哪段。

### 14.2.7 `memory_compression_task_system.md` + `_user.md`

三区压缩时调用。System（31 行）定义输出结构：

- Identified Code Issues（H/M/L 排序，path:line）
- Tool Call Conclusions
- Completed Tasks
- Pending Tasks
- Current Focus

规则：空维度不写，**types/paths 描述但不复制代码**，避免泄露源码进入摘要。

User 是 `{{context}}\n`（12 字节）——把整个压缩区的 messages XML 化塞进去。`buildMessageXML`（`compression.go:183`）做这个：

```
<message id="0" role="system">
  <content>
    ...
  </content>
</message>
<message id="1" role="user">
  ...
</message>
```

## 14.3 scan 模式的 prompt（内联于 `scan_template.json`）

scan 不在 `prompts/` 目录里有 md，全内联在 `scan_template.json` 的 `MAIN_TASK.messages[].content` 之类。共 5 个 task：

| Task | 角色 | 关键内容 |
|------|------|---------|
| MAIN_TASK | system + user | "review ENTIRE existing source file (no diff context)"，强 tool-call discipline（不要 file_read 同时读当前文件，batch comments, end task_done quickly） |
| PLAN_TASK | system + user | 输出 JSON `{summary, checkpoints[]}`，≤5 项 |
| DEDUP_TASK | system + user | 把 batch_comments 分组，输出 `{groups: [{members:["c-0","c-2"], merged_content:...}]}` |
| PROJECT_SUMMARY_TASK | system + user | 输出 markdown 段：Top Issues / Module Hotspots / Cross-Cutting Concerns / Quick Wins |
| RE_LOCATION_TASK | 同 diff | 重定位（同一份 prompt 在两套模板里复用） |
| MEMORY_COMPRESSION_TASK | system + user | 同 diff 的压缩 prompt |

scan 的 MAIN_TASK system prompt 显式强调：

> "Do NOT call `file_read` to re-fetch the current file" — 因为整文件已在 `<current_file_content>` 里。

这是 OCR 通过 prompt 工程**直接约束 LLM 行为**的典型例子。

## 14.4 ApplyLanguage 的作用

`ApplyLanguage(lang)` 给所有 MAIN_TASK / PLAN_TASK / MEMORY_COMPRESSION_TASK 的 system message 追加 `"\n\nAlways respond in <Language>."`。

- 默认 English。
- 用 `ocr config set language Chinese` 后所有后续 review 的 system 末尾加 `Always respond in Chinese.`
- 评论 content、severity、category 命名等其它字段仍然 enum 英文，只有"自然语言部分"用中文。

注意：`REVIEW_FILTER_TASK` 和 `RE_LOCATION_TASK` 不受 ApplyLanguage 影响——它们只输出 JSON，不需要语言 hint。

## 14.5 prompt 工程的几个关键设计

1. **结构化 XML 标签包裹**：`<current_file_diff>...</current_file_diff>`、`<other_changed_files>...</other_changed_files>`，比"natural English description"对 LLM 更可靠地划分字段。
2. **明确角色与纪律**：每个 system prompt 第一行把角色和禁忌点明，减少 hallucination。
3. **JSON 输出强制**：plan/filter/dedup 都要 JSON，`stripMarkdownFences`（`compression.go:163`）容忍模型加 ``` 包装但最后还是 unmarshal。
4. **review_filter_task 的"veto rule"**：只剔除能被 diff 直接证伪的，弱化 Recall。这是 OCR benchmark 高 Precision 的 root cause。
5. **/no_think directive**：re_location task 末尾加 `/no_think`（DeepSeek-R1/o1 系思考模型的指令），让模型别浪费 reasoning step，速回答 code block。

## 14.6 想自定义 prompt 怎么办

OCR **不**开放 task_template.json 的运行期覆盖。如果你想改 main_task 的 prompt 内容，几条路：

1. **走 `--background`**：在 `{{requirement_background}}` 占位符里塞业务上下文。这是 OCR 公开的"加料"渠道，不改 prompt structure。
2. **走 rule_docs / .opencodereview/rule.json**：把你的特定规则注入 `{{system_rule}}`。这是 OCR 主推的定制方式。
3. **fork + 改 embed 文件 + 重编译**：改 `internal/config/template/prompts/main_task_user.md`，跑 `make build`。下游升级时手动 rebase 这部分。
4. **MCP 工具扩展**：见第 15 章，不碰 prompt 只增加工具。

不推荐改 prompt 文本本身——OCR 在生产环境里这些 prompt 是被大量工具调用 trace 调出来的，乱改容易破坏稳定性。
