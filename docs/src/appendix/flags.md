# C. CLI 标志总览

## C.1 公共

| 标志 | 默认 | 说明 |
|------|------|------|
| `--repo-dir` / `-d` | cwd | 仓库目录 |
| `--rule` | "" | 自定义规则文件（最高优先级） |
| `--exclude` | "" | 追加排除 glob（逗号分隔） |
| `--max-git-procs` | 16 | git 子进程并发上限 |
| `--format` / `-f` | text | `text` 或 `json` |
| `--audience` | human | `human` 或 `agent`（agent=静音进度行） |
| `--model` | "" | 覆盖 LLM 模型 |
| `--background` / `-b` | "" | 业务上下文（进 {{requirement_background}}） |
| `--background-file` / `-B` | "" | 从文件读业务上下文 |
| `--preview` / `-p` | false | 只列文件，不调 LLM |

## C.2 `ocr review`

| 标志 | 默认 | 说明 |
|------|------|------|
| `--from` | "" | 基线 ref |
| `--to` | "" | 目标 ref |
| `--commit` / `-c` | "" | 单提交哈希 |
| `--resume` | "" | 续审 session id |
| `--concurrency` | 8 | 并发审查文件数 |
| `--per-file-timeout` | 0（无限）| 单文件超时（分钟）|
| `--max-tools` | 30 | 每文件工具调用上限（只上抬）|
| `--max-tokens-budget` | 0（无限）| 全局 token 预算 |
| `--tool-config` | embed | 自定义 tools.json |
| `--staged` | false | 只审 staged（legacy，不推荐）|

## C.3 `ocr scan`

| 标志 | 默认 | 说明 |
|------|------|------|
| `--path` | "" | 扫描路径（逗号分隔，可目录/文件）|
| `--batch` | by-language | `by-language`/`by-directory`/`none` |
| `--no-plan` | false | 跳过 PLAN_TASK |
| `--no-dedup` | false | 跳过 DEDUP_TASK |
| `--no-summary` | false | 跳过 PROJECT_SUMMARY_TASK |
| `--concurrency` | 8 | batch 内并发 |
| `--per-file-timeout` | 0 | 单文件超时（分钟）|
| `--max-tools` | 60 | 每文件工具上限 |
| `--max-tokens-budget` | 0 | 全局 token 预算 |

## C.4 `ocr delegate`

| 标志 | 默认 | 说明 |
|------|------|------|
| `--from` / `--to` / `--commit` | "" | 审查范围 |
| `--exclude` | "" | 排除 |
| `--background` / `-B` | "" | 上下文 |

子命令：
- `ocr delegate preview` —— 列审查范围 spec
- `ocr delegate rule <path...>` —— 输出按规则内容分组的规则

## C.5 `ocr config`

| 子命令 | 说明 |
|--------|------|
| `ocr config provider` | 交互式选 provider/model + 测连 |
| `ocr config model` | 交互式选模型 |
| `ocr config set <dotted.key> <value>` | 设配置（点分路径） |
| `ocr config get` | 读配置 |
| `ocr llm test` | 连通性测试 |

## C.6 `ocr session`

| 子命令 | 说明 |
|--------|------|
| `ocr session list` | 列会话 |
| `ocr session show <id>` | 会话详情 |
| `ocr session remove <id>` | 删除会话 |

## C.7 `ocr viewer`

| 标志 | 默认 | 说明 |
|------|------|------|
| `--addr` | 127.0.0.1:0 | 监听地址 |

## C.8 全局

| 标志 | 说明 |
|------|------|
| `-h` / `--help` | 帮助 |
| `--version` | 版本 |
| `completion` | shell completion（Cobra 提供）|
