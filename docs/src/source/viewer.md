# 16. viewer：会话回看 Web 服务

`internal/viewer/` 实现 `ocr viewer`：一个本地 Web 服务，把 `~/.opencodereview/sessions/` 下的 JSONL 渲染成可浏览的会话回看 UI。它本质上是"session JSONL 的只读浏览器"。

## 16.1 文件清单

| 文件 | 职责 |
|------|------|
| `server.go` | `StartServer(addr)`：HTTP 服务 + 路由 + Host-header 守卫 |
| `handler.go` | 三个路由 handler：repo 列表 / 会话列表 / 会话详情 |
| `store.go` | JSONL 读取、解析成 `SessionRecord` / `TaskCard` / `ReviewComment` |
| `hostguard.go` | DNS rebinding 防护：Host header 白名单 |
| `templates/*.html` + `static/style.css` | `//go:embed` 的前端 |

## 16.2 路由

`server.go:23` 起 `http.NewServeMux`：

| 路由 | 功能 |
|------|------|
| `GET /` | 所有仓库列表（从 sessions 根目录枚举子目录） |
| `GET /r/{repo}` | 该 repo 的所有 session 列表 |
| `GET /r/{repo}/{sessionID}` | 单个 session 详情：task 卡片 + 评论 |

注意：`repo`/`sessionID` 路径参数做了 `..` 和 `/` 校验（`server.go:33/43`），防目录穿越。

## 16.3 关键安全设计：Host-guard（DNS rebinding 防护）

`server.go:50-55` 的注释把威胁模型说得很清楚：

> "Without this, any web page the user visits can DNS-rebind its origin to 127.0.0.1 and read the session JSONL exposed by this viewer (which contains LLM request bodies = source code being reviewed and the LLM's analysis of it)."

也就是：**viewer 暴露的 JSONL 里含被审源码和 LLM 分析**。任何恶意网页如果能把浏览器定向到 `127.0.0.1`（DNS rebinding 攻击），就可以跨域读到这些数据。

`hostGuard`（`hostguard.go`）实现：
- 从 `addr` 推导允许的 Host（默认 loopback：`localhost` / `127.0.0.1` / `::1`，可用 `OCR_VIEWER_ALLOWED_HOSTS` 环境变量扩展）。
- 所有请求先检查 `Host` header 是否在 allowlist；不在直接 403。

这是 OCR 对"本地端口服务"这类攻击面难得的认真处理。

## 16.4 store 解析

`store.go` 把 JSONL 读成：

- `SessionRecord`：会话元数据（session_start 记录）。
- `TaskCard`：单条 LLM 调用（含 request/response/error/duration）。
- `ReviewComment`：`review_item_done/reused` 里的评论列表。

前端渲染按 `orderedTasks`（`server.go:120`）固定顺序：PlanTask → MainTask → ReLocationTask → MemoryCompressionTask → 其它（如 scan 的 DEDUP/SUMMARY）。

## 16.5 用法

```bash
ocr viewer            # 默认 localhost:5483
ocr viewer --addr 127.0.0.1:8765
```

启动后打印 `Open browser: http://127.0.0.1:8765`，浏览器打开即用。所有资源（templates + css）都 embed 在二进制里，**无需外部静态文件**。

## 16.6 viewer 的定位

viewer 不是"面向 C 端的产品"，而是 OCR 团队的**内部调试工具**公共化了：

- 追踪某次 review 为什么漏了一个 bug → 看 LLM 调了什么工具、在哪一步下结论。
- 评估新 prompt 的效果 → 对比 plan/main 阶段行为。
- 审计 review 质量 → 看 tool_call 序列是否合理。

如果你只关心"评论对不对"，viewer 可有可无；如果你要**对 review 行为负责**（比如你在公司内部推动落地，需要审查 AI 审查的质量），viewer 是不可或缺的取证工具。
