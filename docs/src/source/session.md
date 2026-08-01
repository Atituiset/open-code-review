# 12. session：会话持久化与断点续审

`internal/session/` 把每次审查的完整轨迹写成 JSONL，是 OCR "可调试"、"可续审"、"可 Web 回看"三层共同的基础。

## 12.1 文件清单

| 文件 | 职责 |
|------|------|
| `persist.go` | `jsonlWriter`：一行一条 JSON 记录写盘 |
| `history.go` | `SessionHistory`：per-session 高层 API，包装 jsonlWriter |
| `resume.go` | `ResumeState`：重放旧 session JSONL 构建 fingerprint→comments 索引 |
| `list.go` | `ocr session list`/`show`/`remove` 实现 |
| `testing.go` | 测试辅助 |

## 12.2 落盘位置与格式

存储路径 (`persist.go:104`)：

```
~/.opencodereview/sessions/<encoded-repo-path>/<session-id>.jsonl
```

- `encodeRepoPath(repoDir)`：把绝对路径里的 `/\:` 替换成 `-`，避免目录越级。`/home/x/proj` → `home-x-proj`。
- session-id 由 `uuid.NewString()` 生成（`history.go`）。
- 权限：`os.MkdirAll(dir, 0700)` + `os.OpenFile(..., 0600)`，避免其它用户读到 review 涉及的源码明文（review 时会把代码片段写进 messages）。

## 12.3 JSONL 记录类型

每条记录是一个独立 JSON 对象，通过 `type` 字段区分（`persist.go` 各 `WriteXxx` 方法）。下面这张表反映了完整审查的字段：

| type | 字段 | 触发点 |
|------|------|--------|
| `session_start` | `uuid / parentUuid=null / sessionId / timestamp / cwd / gitBranch / model / reviewMode / diffFrom/diffTo/diffCommit / resumedFrom` | `history.go Start()` |
| `llm_request` | `filePath / taskType / request_no / messages (完整数组)` | 每次 `LLMClient.CompletionsWithCtx` 前，runner 写 |
| `llm_response` | `model / content / tool_calls / usage(prompt/completion/cache_read/cache_write) / duration_ms` | LLM 调用后 |
| `llm_error` | `filePath / taskType / request_no / error / duration_ms` | 失败时 |
| `tool_call` | `filePath / taskType / tool_name / arguments / result / ok / duration_ms` | `executeToolCall` 内 |
| `review_item_done` | `filePath / oldPath / newPath / fingerprint / comments / model` | 单文件 subtask 完成 |
| `review_item_reused` | + `sourceSessionId`（断点续审时从别的 session 复用） | `applyResume` |
| `review_item_failed` | `fingerprint / error` | subtask 失败/panic |
| `session_end` | `files_reviewed / duration_seconds / llm_failures` | `history.go Finalize()` |

`parentUuid` 串联成历史链表，可以追溯哪一条是谁的父。

## 12.4 `SessionHistory` API

`history.go` 的核心结构（化简）：

```go
type SessionHistory struct {
    SessionID    string
    fileSessions map[string]*FileSession   // by filePath
    writer       *jsonlWriter
    options      SessionOptions             // reviewMode/from/to/commit/resumedFrom
    startTime    time.Time
    failures     int64
    finalized    bool
}

func (h *SessionHistory) GetOrCreateFileSession(path string) *FileSession
func (*FileSession) AppendTaskRecord(taskType, messages) *TaskRecord
func (*FileSession) RecordReviewItemDone/Failed/Reused(...)
func (h *SessionHistory) Finalize()
```

`FileSession` 聚合同一文件的多个 LLM request/response/tool_call 记录。`TaskRecord` 是单个 LLM 调用的句柄，建时写 `llm_request`、调 `SetResponse` 写 `llm_response`、调 `SetError` 写 `llm_error`、`AddToolResult` 写 `tool_call`。

`TaskType`（`history.go`）五个值：`PlanTask / MainTask / ReviewFilterTask / MemoryCompressionTask / ReLocationTask`。

## 12.5 断点续审 = 重放 JSONL → fingerprint 索引

`resume.go:67 LoadResumeState` 流式读旧 session JSONL：

```go
for {
    line := reader.ReadBytes('\n')
    var rec resumeRecord
    json.Unmarshal(line, &rec)
    switch rec.Type {
    case "session_start":      applySessionStart    // 抓 reviewMode/from/to/commit
    case "review_item_done",
         "review_item_reused": 必有 fingerprint → Items[fingerprint] = ResumeItem{...}
    case "review_item_failed": delete(Items, rec.Fingerprint)  // 失败项不复用
    }
}
```

唯一**键**：`reviewItemFingerprint(mode, d)`，见 `agent.go:563`：

```go
sum := sha256.Sum256([]byte(mode + "\x00" + d.OldPath + "\x00" + d.NewPath + "\x00" + d.Diff))
```

用 mode + 旧/新 path + diff 文本做指纹。**只要 diff 一行变，指纹就变**——这是续审的"硬失效"条件：如果你在 feature 分支 commit 后又 amend，或者 base 推进了，diff 不一样 → 续审全部重审。

`ValidateOptions`（`resume.go:174`）校验当前 `--from/--to/--commit` 必须和旧 session 一致，避免审错范围。

## 12.6 `applyResume`：续审装配

`agent.go:507`：

```go
for _, d := range diffs {
    if d.IsDeleted { continue }
    fingerprint := reviewItemFingerprint(mode, d)
    item, ok := resume.Item(fingerprint)
    if !ok {
        toDispatch = append(toDispatch, d)   // 没复用 → 重审
        continue
    }
    for _, cm := range item.Comments { a.args.CommentCollector.Add(cm) }
    a.session.RecordReviewItemReused(effectivePath(d), ..., resume.SessionID, item.Comments)
    reused++
}
```

被续审到的文件会**直接保留上次 comments**，**不重审**。这就是为什么 `--resume` 能省掉大变更审一半的 token。

## 12.7 回看：CLI 触达

`ocr session list` / `ocr session show <id>` 调 `internal/session/list.go` 实现，列表展示所有 session 的元数据。Web 回看走 `ocr viewer`（见第 16 章），它读同一目录的 JSONL 文件，渲染 HTML。

## 12.8 实战细节

### 12.8.1 session 文件持续增长

每条 LLM request/response + tool call 都写盘。一个长 reviewer 一次 review 可能产生数 MB JSONL。`ocr session list` 会扫所有 session 文件，**仓里有几百个旧 session 时会慢慢变慢**。可以周期性 `ocr session remove <id>` 或直接 rm JSONL。

### 12.8.2 fingerprint 失效场景

- `git rebase` / `git commit --amend` → diff 改变 → fingerprint 改变 → 续审不复用。
- 切到别人的同名分支但 commit history 不同 → 不复用。
- 同 PR 加了一行新 commit 中间 → 这一文件 fingerprint 变 → 重审（正确行为）。

### 12.8.3 secrets 写盘的注意

LLM messages 含被审源码；如果源码里嵌 secrets（`.env` 未 gitignore、硬编码 token）这些字符串会被写进 JSONL。多人共享 home 目录时 `0600` 权限保护了，但如果你 `tar -zcvf sessions.tar.gz ~/.opencodereview/sessions/` 上传 S3 时要注意。第 33 章安全会展开。

## 12.9 小结

session 是 OCR 可调试性的关键。如果你只用 OCR 跑 review 看结果，session 只是个"事后的死记录"。但你需要：

- **追 bug**：`ocr viewer` 看 LLM 到底调了什么工具 → 论证哪一句 prompt 让模型走偏。
- **续审**：因为网络抖断审了一半 → `--resume` 接着审。
- **质量审计**：`session list` 抽查每 review 的 duration / token / failure 数。

这是 OCR 明显比"贴 prompt 的 review 工具"高维的地方。
