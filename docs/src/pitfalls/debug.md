# 35. 调试与排障手册

按症状→根因→处方组织的排障手册。每个症状都指到源码定位点。

## 35.1 LLM 相关

### "LLM completion error" 或 subtask_error

```
[ocr] LLM completion error: ...
[ocr] Subtask error for src/a.go: ...
```

**排查步骤**：
1. `ocr llm test` —— 最快定位是配置错还是网络错。
2. 确认协议：看 `~/.opencodereview/config.json` 的 `protocol` 字段，网关只认 openai 就别配 anthropic。
3. 确认 URL：`openai` client 会自动拼 `/chat/completions`，`anthropic` 拼 `/v1/messages`。手动 curl 网关对比。
4. 看 session JSONL 的 `llm_error` 记录（`ocr viewer` 或 grep JSONL），里面是 SDK 原始 error。
5. 检查网关限流/超时：`OCR_LLM_TIMEOUT`（秒）全局覆盖，`--timeout` 是每文件子任务超时（分钟，默认 10，0=无限）。

**根因参考**：
- 并发 8 文件 × 每文件多轮 → 瞬时请求密集，网关 429 → SDK 重试 5 次仍失败。
- 模型名拼错 / 网关不认识 `model` 字段。
- thinking 模型 + `extra_body` 冲突。

### "all N file review(s) failed — check your LLM configuration and API key"

`agent.go:501`：每个文件都失败。先 `ocr llm test`。

### 评论质量差 / 漏报

1. **规则没生效**：`ocr delegate rule src/a.go` 看命中了什么规则；`ocr review --preview` 看文件范围。
2. **被 review_filter 剔多了**：`executeReviewFilter` 是"可证伪才剔"，但如果 prompt 版本问题可能误剔。看 session 里 `review_filter.execute` span 的 `comments.before/filtered`。
3. **模型弱**：工具调用膨胀导致 context 乱。换强模型或收紧工具。

## 35.2 文件/范围问题

### "No supported files changed. Skipping review."

`agent.go:218`。原因：
- 不是 git 仓（`ocr review` 需要 git；`ocr scan` 不需要）。
- 扩展名都不在白名单。`--preview` 看排除原因。
- `--exclude` 误伤。

### 某文件没被审

`ocr review --preview` 会标 `(excluded: <reason>)`。看 `whyExcluded` 五级。

### 大文件被跳过

`[ocr] Skipping <path> (~N tokens exceeds 80% of max_tokens(...))` —— `filterLargeDiffs`。这是预算保护，不是 bug。要审它：`--max-tokens-budget` 不管用（那是全局 gate），这是单文件 diff token 超 MaxTokens 的 80%。唯一办法是提高模板 MaxTokens（fork）或缩小该文件 diff。

## 35.3 行号 / 定位

### 评论 start_line = 0

`ResolveComment` + fallback 都没命中。原因：
- LLM 的 `existing_code` 和 diff 完全对不上（模型幻觉 snippet）。
- 文件内容在审后变了（fingerprint 不匹配？不会，因为行号在 session 内解决）。

**诊断**：`ocr viewer` 打开该文件 session → Main loop → 找 code_comment 的 tool_call → 看 `existing_code` 参数 vs `d.Diff`。

**缓解**：用更强/更会贴代码的模型；或在 `--background` 里提示"existing_code 必须是 diff 中逐字出现的代码"。

## 35.4 断点续审异常

- "resume requires --from/--to or --commit" → workspace 不支持。
- "resume session review mode ... does not match" → range/commit 不一致，`ValidateOptions`。
- 全部重审 → diff 变了（rebase/amend/base 推进），fingerprint 失效。正常。

## 35.5 性能 / 卡住

### 审到一半像卡死

- 单文件 LLM 调用本身 5 分钟超时（SDK 默认）；整文件子任务默认 10 分钟超时（`--timeout`，0=无限）。**CI 建议设 `--timeout 5-10` 兜底**。
- 工具调用同步路径（非 code_comment）：`file_read`/`code_search` 卡在 git 子进程？`gitcmd.Runner` semaphore 16 并发，`code_search` 的 `git grep` 大仓可能慢。
- MCP 工具慢会拖主循环。

**看进度**：`--audience human` 会打印每步（tool_call/LLM request）；`--format json` 则无进度。卡住时切 human 观察是哪一步。

### 内存 / CPU

- scan 大仓：`listFilesViaWalk` 全 walk + 每文件 ReadFile。大仓先 `--path` 定向。
- 并发 8 文件 × 每文件多轮 LLM → 每个在等网络不占 CPU，但 session JSONL 写入是串行（mutex）。磁盘慢会拖整体。

## 35.6 Session / 输出

### JSON 输出被 `[ocr]` 污染

没加 `--audience agent`。`newQuietHandle` 只对 json 或 agent 静音；两个都加。

### 输出里有 project_summary 但空

scan 的 PROJECT_SUMMARY_TASK 失败（best-effort）。看 session 里 `__scan_project_summary__` 记录的 llm_error。

### "TraceID" 但 telemetry 没开

TraceID 打印逻辑在 `telemetry.IsEnabled()` 才打印（`review_cmd.go:200`）。如果没开 telemetry 不会打印。开了才需要 collector。

## 35.7 viewer 打不开 / 403

- `ocr viewer --addr 127.0.0.1:8765` 后浏览器访问其它 host（如 `localhost` 别名）可能 403：Host 守卫白名单默认 loopback（`localhost`/`127.0.0.1`/`::1`）。若绑非 loopback 地址或自定义域名需配 `OCR_VIEWER_ALLOWED_HOSTS`（看 `hostguard.go` 实现）。
- session 目录不存在 → 没有 session 可看，先跑一次 review。

## 35.8 二次开发调试技巧

1. **grep session JSONL**：`rg 'tool_call' ~/.opencodereview/sessions/...` 快查工具调用轨迹。
2. **`go run ./cmd/opencodereview review --preview`** 快速验证范围。
3. **`make test`** 全套单测（80% 覆盖门槛）。
4. **加日志**：所有进度走 `stdout.Writer()`，json/agent 模式静音。二次开发调试用 human。
5. **OTLP trace**：本地 `otel-collector` + Jaeger，看 span 树定位瓶颈。
