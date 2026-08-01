# D. 术语表

## A

- **Agent**：本文档指 OCR 内嵌的"LLM 工具调用 Agent"（每文件一个子 Agent 实例），也泛指 Claude Code 等宿主编程代理。
- **allowlist（白名单）**：`supported_file_types.json` 的 80 个扩展名；文件扩展名不在其内则默认不审。

## B

- **Background（业务背景）**：`--background` / `--background-file` 提供的上下文，注入 prompt 的 `{{requirement_background}}`。
- **Batch（批）**：scan 模式的调度单位，按策略把文件分组，batch 内文件并发、batch 之间串行。

## C

- **code_comment**：LLM 报 issue 用的工具，异步处理行号定位与重定位。
- **CommentCollector**：线程安全的评论收集器，`agent`/`scan`/`llmloop` 共享。
- **CommentWorkerPool**：code_comment 异步处理的工作池，`SubmitFor(key)`/`AwaitKey(key)` 按文件隔离。
- **compression（上下文压缩）**：对话超 token 阈值时的三区压缩（frozen/compress/active），60% 异步、80% 同步。
- **custom rule（自定义规则）**：`--rule` / 项目 / 全局规则文件，优先级高于系统规则。

## D

- **delegate（委派模式）**：OCR 不调 LLM，只输出"审查规约"（文件清单 + 规则分组），由宿主 Agent 执行审查。
- **diff**：git unified diff 文本，OCR 审查的基本输入。
- **DiffMap**：`map[path]diffText`，灌给 file_read_diff 工具做跨文件上下文。

## E

- **existing_code**：LLM 给的评论锚点代码片段，用于行号定位。
- **ExcludeReason**：文件被排除的原因枚举（用户规则/扩展名/默认路径/二进制）。

## F

- **file_read**：读文件工具（workspace 读盘 / commit+range 读 git show）。
- **fingerprint**：`sha256(mode+oldPath+newPath+diff)`，续审复用的键。
- **frozen zone**：上下文压缩时永不压缩的头部（system + 第一条 user）。

## G

- **gitcmd.Runner**：git 子进程并发限流器（默认 16）。
- **global rule**：`~/.opencodereview/rule.json`，用户全局规则层。

## L

- **LLMClient**：`llm.CompletionsWithCtx` 统一接口，三协议实现。
- **llmloop.Runner**：共享的 LLM 工具调用循环执行器，per-session 持有 token 计数。
- **LlmComment**：评论领域模型（Path/Content/ExistingCode/SuggestionCode/Category/Severity/StartLine/EndLine）。

## M

- **MAX_TOOL_REQUEST_TIMES**：每文件工具调用上限（diff 30 / scan 60）。
- **MaxTokens**：58888，单次 LLM 调用与压缩判断的基准。
- **MCP**：Model Context Protocol，OCR 作为客户端接入外部工具。

## P

- **plan phase**：大文件（≥50 行变更）先让 LLM 出 JSON 审查计划，注入 main 阶段。
- **plan_guidance**：plan 阶段输出，替换 prompt 的 `{{plan_guidance}}`。
- **Provider**：① `tool.Provider` 工具接口；② `diff.Provider` diff 获取器；③ LLM provider 预设（18 个）。
- **prompt cache**：Anthropic `cache_control: ephemeral`，OCR 自动给 system+tools 开。

## R

- **re-location（重定位）**：行号匹配失败时调 LLM 重新生成 existing_code。
- **review_filter**：diff-review 后的评论质量门，剔除可被 diff 证伪的评论。
- **ResolveComment**：把 existing_code 匹配到 diff 行号（hunk 优先，全文兜底）。

## S

- **scan**：全文件审查模式（无 diff），含 plan/dedup/project-summary 阶段。
- **session**：一次 review/scan 的完整 JSONL 记录，可续审、可 Web 回看。
- **severity/category**：评论的严重度（critical/high/medium/low）与类别（bug/security/...）。

## T

- **task_done**：LLM 终止信号（DONE/FAILED）。
- **TaskType**：session 记录里的任务类型（Plan/Main/ReviewFilter/MemoryCompression/ReLocation）。
- **task_template.json / scan_template.json**：两套 prompt 任务配置。

## W

- **workspace mode**：审当前未提交改动（staged+unstaged+untracked）。
