# 1. 项目定位与设计哲学

## 1.1 一句话定位

**OpenCodeReview（OCR）是一个 AI 驱动的命令行代码审查助手**：它读 Git diff（或整文件），把变更文件分流给一个**有工具调用能力**的 LLM Agent，产出结构化、带行级精度的审查意见。和"裸的 Claude Code + 一个 review skill"相比，OCR 用**确定性工程的第一性约束**把审查过程关键步骤焊死，只为 LLM 留下"动态判断"这一段自由度。

## 1.2 解决了什么痛点（来自 README）

通用 Agent（如 Claude Code+Skill）做代码审查有三个老毛病：

1. **覆盖不全**：变更大了之后"摸鱼"，只审掉一部分文件。
2. **定位飘**：报告的行号/文件经常对不上代码。
3. **质量抖**：纯自然语言驱动的 Skill 难调试，prompt 一改质量就跳。

根因是：**纯语言驱动的架构，对审查过程没有硬约束**。

## 1.3 核心理念：确定性工程 × Agent 混合

这是 OCR 区别于其它"贴个 prompt 调 LLM"工具的灵魂。这条哲学几乎可以解释仓里每一处关键代码决策：

### 工程负责"绝对不能错"的部分

| 工程手段 | 代码落点 | 它保证什么 |
|---------|---------|----------|
| 精确文件选择 | `internal/agent/agent.go` `filterDiffs` / `whyExcluded` | 该审的必审、不该审的不浪费 |
| 智能打包（分治）| `internal/agent/agent.go` `dispatchSubtasks` 整体架构 | 大变更集稳定 + 天然并发 |
| 规则匹配（模板引擎，而非自然语言）| `internal/config/rules/system_rules.go` `Resolver` | 给模型聚焦的检查清单 |
| 行号定位（外置模块）| `internal/diff/resolver.go` `ResolveComment` | 反馈位置根本不会飘 |
| 反思模块（评论筛选）| `internal/agent/agent.go` `executeReviewFilter` | 评论内容精度 |
| 重定位模块 | `internal/diff/relocation.go` `ReLocateComment` | 当匹配失败时用 LLM 把位置拉回 |

### Agent 负责"需要动态判断"的部分

- **场景化 prompt**：`internal/config/template/prompts/*.md`，专门为代码审查优化，降本增效。
- **场景化工具集**：`internal/tool/` 六件套（`task_done` / `code_comment` / `file_read` / `code_search` / `file_read_diff` / `file_find`），从大规模生产工具调用 trace 里蒸馏出来的最小可用集，比通用 Agent 工具箱更稳更可预测。

## 1.4 与"纯 Skill 方案"的差异：一个直观比喻

| 维度 | 纯 Skill 方案 | OCR |
|------|--------------|-----|
| 文件选择 | Agent 自己 walk 文件 | 工程在 LLM 之前决定，Agent 看不到被过滤的 |
| 行号 | Agent 自报 | 工程把 `existing_code` 匹配到 diff 行 |
| 工具集 | 通用 fs/grep/shell | 6 个专用工具 |
| Prompt | 一坨综述 | task_template.json + 占位符替换 |
| 大变更集 | 容易丢文件 | 每文件子任务隔离 + 并发 |
| 失败定位 | 难 | 每文件 panic recover + 警告回收 |
| 成本控制 | 不确定 | token 预算 + 上下文压缩 |

## 1.5 benchmark 自我标定（README 口径）

OCR 自建了一个 benchmark：50 个开源仓 + 200 个真实 PR + 10 种语言 + 80+ 资深工程师标注的 1,505 条 ground-truth。结论性指标：

- 在**同一底模**下，OCR 比通用 Agent（Claude Code）**Precision / F1 显著更高**。
- 消耗**约 1/9 的 token**，单审更快。
- **Recall 比 Agent 低**——这是有意为之的精度优先取舍，宁可少报也不糊报。

> 注：这是上游官方口径，未由本文档独立复现。但结合 1.3 的工程取舍，Recall 偏低确实在工程模型的预期之中——`executeReviewFilter` 会主动剔除"仅凭 diff 无法证伪"以外的可疑项。

## 1.6 一组关键现实

在解读后续代码时请始终记住这几条**事实**，它们会反复解释为什么某处代码写得这么"工程化"：

- `ocr` 是**单进程 Go 二进制**，所有 prompt、规则、工具 schema 都 `//go:embed` 进二进制，运行期不需要外部 prompt 文件。
- 主循环是**同步阻塞、多轮**的（per-file 一个 `llmloop.Runner.RunPerFile`），不是流式；Anthropic/OpenAI 都用 SDK 非流式调用，只有 OpenAI 兼容协议可在 `extra_body.stream=true` 时走流式（`internal/llm/client.go:351`）。
- 文件之间**串行调度但文件内并行 LLM 评论收集**（通过 `CommentWorkerPool`，详见第 7 章）。
- reviewer 默认每文件最多 30 次工具调用（`task_template.json` 的 `MAX_TOOL_REQUEST_TIMES`），scan 模式 60 次。
- 一切会话都被记到 `~/.opencodereview/sessions/<repo>/<sess-id>.jsonl`，可断点续审、可 Web 回看。
