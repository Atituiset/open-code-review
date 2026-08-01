# 29. Session Viewer 与断点续审

本章把"回看会话"和"续审"两个能力串起来，给出落地用法。

## 29.1 会话存储

每次 review/scan 都会在 `~/.opencodereview/sessions/<encoded-repo-path>/<session-id>.jsonl` 写一份完整 JSONL：

```
session_start
llm_request ×N   （每次 LLM 调用前）
llm_response ×N  （每次 LLM 调用后）
tool_call ×N     （每个工具调用）
review_item_done / reused / failed ×N
session_end
```

记录里含：完整 prompt/response 文本、工具参数与结果、token usage、每文件评论、duration、失败信息。**这就是你审查的完整审计轨迹**。

## 29.2 查看会话列表

```bash
ocr session list
```

输出每个 session 的：id / 时间 / 仓库 / reviewMode / 文件数 / comments / tokens / duration / failures。

```bash
ocr session show <session-id>      # 看单会话详情
ocr session remove <session-id>    # 删除
```

## 29.3 Web Viewer

```bash
ocr viewer
# 或
ocr viewer --addr 127.0.0.1:8765
```

打开浏览器访问 `http://127.0.0.1:8765`，能看到：

- 仓库列表 → 会话列表 → 会话详情
- 详情里按 `Plan → Main → ReLocation → MemoryCompression` 顺序展示每次 LLM 调用的 task 卡片
- 每张卡片：request 文本、response、tool_calls、usage、duration、error
- 评论按文件分组 + severity 计数

**用途**：
- 追溯"这次 review 为什么漏了这个 bug"→ 看 Main loop 里 LLM 调了什么工具、在哪一轮下结论。
- 评估 prompt 改动的效果 → 对比两次 session 的行为差异。
- 审计 review 质量 → 看 tool_call 序列是否合理。

**安全**：viewer 暴露的是本机会话 JSONL（含源码），有 Host-header DNS rebinding 防护（`hostguard.go`）。**别把端口暴露到公网**。

## 29.4 断点续审

```bash
# 1. 首次审（网络断了/超时）
ocr review --from main --to feature
# → [ocr] Session: 8f3a... (retry with: --resume 8f3a...)

# 2. 续审
ocr review --from main --to feature --resume 8f3a...
```

**续审语义**（`agent.go:507 applyResume`）：

- 用 `fingerprint = sha256(mode + oldPath + newPath + diff)` 判断每个文件是否变过；
- 变过的 → 复用上次 comments（不重审）；
- 没变过（或上次 failed）→ 重审；
- 输出 `[ocr] Resume <id>: reusing N file(s), reviewing M file(s)`。

**限制**：
- 只支持 `--from/--to` 或 `--commit`；workspace 模式不支持（无稳定 ref 锚定）。
- 当前 range/commit 必须与上次 session 完全一致（`ValidateOptions` 会拒绝不一致）。
- diff 一旦变化（rebase/amend/base 推进），指纹变 → 全部重审。

## 29.5 落地建议

| 场景 | 用 |
|------|-----|
| 大 PR 审一半断了 | `--resume` |
| CI 审完后想看行为 | `ocr viewer` 或 session list |
| 评估新模型/新规则 | 同 PR 两次 session 对比 |
| 追 review 漏报 | viewer 里看 Main loop tool_call |
| 磁盘清理 | `ocr session remove <id>` 或删 JSONL |

## 29.6 坑点

1. **session 文件累积**：每次 review 数 MB，几百次后 `session list` 变慢。定期清理。
2. **敏感数据**：JSONL 含被审源码全文（在 llm_request/llm_response 里），`0600` 权限保护但别随意上传/分享。
3. **续审不等于增量**：它只在"文件没变"时复用；同一文件内部部分改了就整个重审该文件（按文件粒度，不是 hunk 粒度）。
4. **`OCR_CONTENT_LOGGING` 与 session**：session 永远记内容（与 telemetry 的 content_logging 开关无关）。要彻底不落盘需改源码。
