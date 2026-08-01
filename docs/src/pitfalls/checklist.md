# 32. 常见踩坑清单

本章按"从安装到规模化"的路径，把前面各章散落的坑点汇总成一份可勾选的 checklist。每一项都标注了根因（源码层），方便你排查时定位。

## 32.1 安装 / 环境

- [ ] **Git 版本 < 2.41**：`--end-of-options`、`--find-renames` 等 flag 行为异常。升级 git。
- [ ] **npm 装完 `ocr: command not found`**：optionalDependencies 被镜像/`--no-optional` 过滤。改 `install.sh` 或手动下载二进制。
- [ ] **Node 版本过低**：npm 安装只要求 ≥14，但 postinstall 脚本可能用到较新语法。用 Node 18+ 更稳。
- [ ] **更新检查干扰**：npm 包装默认 18 分钟后台检查更新（`bin/ocr.js`）。隔离网设 `OCR_NO_UPDATE=1`。
- [ ] **PATH 不含安装目录**：install.sh/ps1 都只警告不自动加 PATH。

## 32.2 LLM 配置

- [ ] **协议错配**：网关只认 OpenAI 却配了 `anthropic` → 404。先 `ocr llm test`。
- [ ] **URL 尾巴**：`openai` client 会自适应 `/chat/completions`，但传错路径（如多一层 `/v1`）仍会 404。
- [ ] **API key 优先级打架**：config.json 的 `providers.<name>.api_key` 会覆盖 EnvVar；改了 env 但 config 里残留旧 key → 用错 key。清 config 或用 `ocr config set providers.<name>.api_key ""`。
- [ ] **`OCR_CONFIG_PATH` 只影响读**：写仍写 `~/.opencodereview/config.json`（防重定向，`config_cmd.go:95`）。脚本以为写到了 OCR_CONFIG_PATH 指向处是误判。
- [ ] **复用 CC env 的坑**：`tryShellRC` 会 grep `~/.bashrc` 等历史 export，可能读到已废弃 token。`ocr llm test` 验证到底用了哪套。
- [ ] **`extra_body` 无环境变量通道**：GitHub Action / CI 只能 `ocr config set llm.extra_body '...'`。

## 32.3 首次运行 / 行为

- [ ] **审不到文件**：先 `ocr review --preview` 看范围。常见原因：非 git 仓、扩展名不在白名单（`.ftl`/`.vue`）、默认排除了测试文件、`--exclude` 太宽。
- [ ] **没审到 untracked 文件以为漏了**：workspace 模式**包含** untracked（`git ls-files --others`）；commit/range 模式不含。
- [ ] **单文件巨大被静默跳过**：diff token >80% MaxTokens → `[ocr] Skipping ...` warning。不是 bug，是预算保护。
- [ ] **`--audience human` 用于 CI**：human 模式进度行混入 stdout，`--format json` 也救不回。CI 必须 `--audience agent`。
- [ ] **评论行号是 0**：`ResolveComment` 全失败 + 兜底也没命中。多为 LLM 的 `existing_code` 与 diff 严重不符。可用 `ocr viewer` 查该文件 Main loop 的 tool_call。

## 32.4 CI / 规模化

- [ ] **浅克隆**：`--shallow` 下 `--from/--to` 找不到 merge-base。必须 `fetch-depth: 0`。
- [ ] **版本滚动**：CI 用 `@latest`，prompt/工具集变化导致评论风格漂移。锁版本。
- [ ] **并发重复审**：多触发源（push+PR）并发。GitLab `resource_group` / GitHub `concurrency`。
- [ ] **评论区限流**：100+ 评论一次贴可能被平台限流。用 `route_severity_below` / `incremental` / `review_comment_batch_size`。
- [ ] **fork PR secrets**：`pull_request_target` 用 repo secrets，但 head 代码不可信。OCR 只读 diff，post-review 脚本别信任 head 内容。
- [ ] **`thinking` 模型爆 token**：默认 thinking 的模型在 review 里可能消费翻倍。`llm.extra_body: {"thinking":{"type":"disabled"}}`。
- [ ] **超时**：单文件子任务默认超时 10 分钟（`--timeout`，0=无限）。CI 里设 5-10 分钟/文件 + job 15 分钟。
- [ ] **token 预算失控**：工具调用会膨胀 context（#409 实测 ~300×）。设 `--max-tokens-budget` 兜底，接受 `budget_exceeded` 状态的 partial 结果。

## 32.5 断点续审

- [ ] **workspace 模式不支持 resume**（`resume.go:178` 显式拒绝）。
- [ ] **range/commit 不一致**：`ValidateOptions` 拒绝；必须与上次完全一致。
- [ ] **diff 一变全失效**：fingerprint 含 diff 全文，rebase/amend/base 推进 → 全部重审。别把 resume 当增量审。

## 32.6 MCP / 插件

- [ ] **stdio MCP 起不来**：`command` 必须在 PATH；`setup` 失败只 WARNING 跳过该 server（review 继续，但工具没了）。
- [ ] **MCP 工具慢**：LLM 主循环等它。别注册秒级延迟的工具，或在 prompt 里提醒"谨慎调用"。
- [ ] **MCP 覆盖保留名**：`tool.IsReserved` 拒绝 `task_done` 等，别硬注册。
- [ ] **插件 vs skills 双份**：改一处忘同步另一处，行为不一致。

## 32.7 session / 隐私

- [ ] **session 累积**：几百次 review 后 `session list` 变慢。定期清理。
- [ ] **JSONL 含源码**：`llm_request/response` 里有完整 prompt（含 diff/文件内容）。别上传共享平台。权限 0600。
- [ ] **telemetry content_logging**：开了会把源码发给 collector。只在受控网络开。

## 32.8 性能

- [ ] **并发太高**：默认 8 文件并发，若 LLM 网关限速可降 `--concurrency 2-4` 换稳定性。
- [ ] **plan phase 每大文件一次调用**：变更 ≥50 行就触发。可接受，但大 PR 注意计划成本。
- [ ] **file_read 500 行截断**：LLM 要读大文件上下文需分多次调用，token 成本上升。属正常行为。

## 32.9 二次开发

- [ ] **internal 包隔离**：`internal/` 只能 module 内用，复用需 fork。
- [ ] **改 prompt 需重编译**：embed 进二进制。
- [ ] **locale 敏感测试**：`make test` 用 `LC_ALL=C`，直接 `go test` 可能因 locale 失败。
