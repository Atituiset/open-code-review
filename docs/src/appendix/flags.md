# C. CLI 标志总览

> 本表以 `cmd/opencodereview/*.go` 的 Cobra 注册为准（`shared_flags.go` 为公共 flag 工厂）。
> 注意：CLI 默认值是 flag 层面的值；部分 flag（如 `--max-tools`、`--batch`）为 0/空时
> 实际走模板默认（diff 30 / scan 60、scan batch `by-language`）。

## C.1 公共 flag（review / scan / delegate 按需注册）

| 标志 | 默认 | 说明 | 注册位置 |
|------|------|------|----------|
| `--repo` | cwd | 仓库目录（git toplevel 锚定，无短参） | `shared_flags.go addRepoFlag` |
| `--rule` | "" | 自定义规则文件（最高优先级） | `shared_flags.go addRuleFlag` |
| `--exclude` | "" | 追加排除 glob（逗号分隔） | `shared_flags.go addExcludeFlag` |
| `--max-git-procs` | 16 | git 子进程并发上限 | `shared_flags.go addConcurrencyFlags` |
| `--format` / `-f` | text | `text` 或 `json`（仅 review/scan） | `addOutputFlags` |
| `--audience` | human | `human` 或 `agent`（agent=静音进度行，仅 review/scan） | `addOutputFlags` |
| `--model` | "" | 覆盖 LLM 模型（仅 review/scan） | `addModelFlag` |
| `--background` / `-b` | "" | 业务上下文（进 {{requirement_background}}） | `addBackgroundFlags` |
| `--background-file` / `-B` | "" | 从文件读业务上下文 | `addBackgroundFlags` |
| `--preview` / `-p` | false | 只列文件/范围，不调 LLM（仅 review/scan） | `addPreviewFlag` |
| `--tools` | embed | 自定义 tools.json 路径（仅 review/scan） | `addToolsFlag` |

## C.2 `ocr review`

| 标志 | 默认 | 说明 |
|------|------|------|
| `--from` | "" | 基线 ref |
| `--to` | "" | 目标 ref |
| `--commit` / `-c` | "" | 单提交哈希（vs 其父提交） |
| `--resume` | "" | 续审 session id（仅 range/commit 模式） |
| `--concurrency` | 8 | 并发审查文件数 |
| `--timeout` | 10 | 单文件子任务超时（分钟，0=无限） |
| `--max-tools` | 0 | 工具调用轮数上限（0=模板默认 30；1–9 钳到 10；只上抬） |
| `--max-tokens-budget` | 0 | 全局 token 预算（0=无限） |

另含 C.1 全部公共 flag。`--from/--to` 与 `--commit` 互斥；`--preview` 不能与 `--resume` 同用。

## C.3 `ocr scan`

| 标志 | 默认 | 说明 |
|------|------|------|
| `--path` | "" | 扫描路径（逗号分隔，可目录/文件） |
| `--batch` | "" | 覆盖 BATCH_STRATEGY：`none`/`by-language`/`by-directory`（空=模板默认 `by-language`） |
| `--no-plan` | false | 跳过 PLAN_TASK |
| `--no-dedup` | false | 跳过 DEDUP_TASK |
| `--no-summary` | false | 跳过 PROJECT_SUMMARY_TASK |
| `--concurrency` | 8 | batch 内并发 |
| `--timeout` | 10 | 单文件子任务超时（分钟，0=无限） |
| `--max-tools` | 0 | 工具调用轮数上限（0=模板默认 60；只上抬） |
| `--max-tokens-budget` | 0 | 全局 token 预算（0=无限） |

另含 C.1 全部公共 flag。

## C.4 `ocr delegate`

子命令：
- `ocr delegate preview [flags]` —— 列审查范围 spec
- `ocr delegate rule [flags] <path...>` —— 输出按规则内容分组的规则

共用 flag：`--repo`、`--from` / `--to` / `--commit` `-c`、`--exclude`、`--rule`、
`--background` `-b` / `--background-file` `-B`、`--max-git-procs`。

## C.5 `ocr config`

| 子命令 | 说明 |
|--------|------|
| `ocr config provider` | 交互式选 provider/model + 测连（bubbletea TUI） |
| `ocr config model` | 交互式选模型 |
| `ocr config set <key> <value>` | 设配置（空格分隔，支持点分路径如 `llm.extra_body`） |
| `ocr config unset <key>` | 删除 provider / `custom_providers.<name>` / `mcp_servers.<name>` |

> 没有 `ocr config get` 子命令；读生效配置用 `ocr llm test` 验证，或直接看
> `~/.opencodereview/config.json`。

## C.6 `ocr session`

| 子命令 | 说明 |
|--------|------|
| `ocr session list` | 列会话（`--repo` / `--json` / `--limit <n>`，默认 20） |
| `ocr session show <id>` | 会话详情（`--repo` / `--json`） |
| `ocr session remove <id>` | 删除会话 |

## C.7 `ocr viewer`

| 标志 | 默认 | 说明 |
|------|------|------|
| `--addr` | localhost:5483 | 监听地址（如 `:3000` 绑所有网卡） |

## C.8 `ocr llm`

| 子命令 | 说明 |
|--------|------|
| `ocr llm test` | 连通性测试（跑 `testconnection/task.json` 最小对话） |
| `ocr llm providers` | 列出全部内置 provider |

## C.9 `ocr rules`

| 子命令 | 说明 |
|--------|------|
| `ocr rules check [flags] <file-path>` | 校验规则文件覆盖度（`--rule` 指定自定义规则） |

## C.10 全局

| 标志/命令 | 说明 |
|-----------|------|
| `-h` / `--help` | 帮助 |
| `-V` / `--version` | 版本（root flag） |
| `ocr version` | 版本子命令 |
| `ocr completion`（bash/zsh/fish/powershell） | shell completion（Cobra 提供） |
