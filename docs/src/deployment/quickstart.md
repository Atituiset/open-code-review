# 24. 第一次审查

## 24.1 从零开始（30 秒路径）

```bash
# 1. 安装
npm install -g @alibaba-group/open-code-review

# 2. 配置 LLM（交互式，自动测连）
ocr config provider

# 3. 到目标仓库跑
cd /path/to/your/repo

# 4. 审查当前未提交的改动
ocr review

# 5. 审查分支差异
ocr review --from main --to feature

# 6. 审查单个 commit
ocr review --commit abc123
```

## 24.2 理解输出

human 模式（默认）输出类似：

```
[ocr] 8 file(s) changed, reviewing 8 in /path/to/repo
[ocr] Plan completed for internal/agent/agent.go
[ocr] 💭 LLM request (main_task) 3.1s, 2.4k tokens
[ocr] ✅ tool_call code_search finished in 15ms
[ocr] ✅ tool_call file_read finished in 8ms
[ocr] 📤 tool_call code_comment submitted (2 comments)
...
[ocr] TraceID: ...
[ocr] Summary: 8 files reviewed, 14 comments, 123.4k input tokens, 45.6k output tokens, 3m12s
```

关键数字：`files reviewed` / `comments` / `tokens` / `duration`。

## 24.3 JSON 输出（CI 消费端）

```bash
ocr review --from main --to feature --format json --audience agent > result.json
```

`result.json` 顶层结构（关键字段）：

```json
{
  "status": "success",                 // 或 warnings / budget_exceeded / error
  "comments": [
    {
      "path": "src/auth/login.go",
      "content": "使用 == 比较浮点不安全",
      "category": "bug",
      "severity": "high",
      "start_line": 45,
      "end_line": 47,
      "existing_code": "...",
      "suggestion_code": "..."
    }
  ],
  "warnings": [],
  "files_reviewed": 8,
  "total_input_tokens": 123456,
  "total_output_tokens": 45678,
  "total_tokens_used": 169134,
  "total_cache_read_tokens": 90000,
  "total_cache_write_tokens": 5000,
  "duration_seconds": 192.3,
  "project_summary": "",               // scan 模式才有
  "tool_calls": { "code_search": 4, "file_read": 7, "code_comment": 5 },
  "trace_id": "...",
  "resume_info": null,
  "session_id": "...",
  "budget_exceeded": false
}
```

**给脚本/机器人用 `--audience agent`**：它会静音所有 `[ocr]` 进度行，只留干净 JSON。

## 24.4 预览（不花 token）

```bash
ocr review --preview
# 或
ocr review --from main --to feature --preview
```

列全部文件，标出 `WillReview` 与被排除原因。适合：
- 确认范围对不对；
- 排查"为什么某文件没审"；
- CI 里先 `--preview` 决定要不要跑真审。

## 24.5 常用 flag 速查

```bash
# 范围
ocr review                                  # workspace（staged+unstaged+untracked）
ocr review --from main --to feature         # 分支比较（merge-base）
ocr review --commit <sha>                   # 单个提交
ocr review --resume <session-id>            # 断点续审

# 过滤
ocr review --exclude '**/generated/*,**/testdata/*'
ocr review --rule ./team-rules.json         # 自定义规则文件

# 上下文
ocr review --background "本 PR 新增登录限流"     # 业务背景
ocr review --background-file ./docs/req.md     # 或从文件读

# 性能/成本
ocr review --concurrency 4                   # 并发文件数（默认8）
ocr review --timeout 5                       # 单文件超时（分钟，默认10，0=无限）
ocr review --max-tools 50                    # 提升每文件工具调用上限（0=模板默认30）
ocr review --max-tokens-budget 2000000       # 全局 token 预算

# 输出
ocr review --format json --audience agent    # CI 用
ocr review --model gpt-5.5                   # 覆盖模型
```

## 24.6 断点续审示例

```bash
# 第一次跑，网络断了
ocr review --from main --to feature
# → [ocr] Session: 8f3a... (retry with: --resume 8f3a...)

# 断点续审（只审失败的/未完成的文件，成功的直接复用）
ocr review --from main --to feature --resume 8f3a...
```

> 条件：`--from/--to` 或 `--commit` 必须与上次一致；workspace 模式不支持续审。见 12.5。

## 24.7 全文件扫描

```bash
ocr scan                          # 审全仓
ocr scan --path internal/agent    # 审某目录
ocr scan --path a.go,b.go         # 审指定文件
ocr scan --no-plan                # 跳过 plan
ocr scan --no-dedup               # 跳过去重
ocr scan --no-summary             # 跳过项目摘要
```

scan 会额外输出 `project_summary` markdown 段。**注意成本**（见 20.8）。
