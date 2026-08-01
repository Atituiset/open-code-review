# 17. telemetry：OpenTelemetry 可观测性

`internal/telemetry/` 是 OCR 的可观测性层，基于 OpenTelemetry Go SDK。它记录 metrics、traces、spans、事件，支持 console 输出和 OTLP 导出。**默认完全关闭**，要显式开。

## 17.1 文件清单

| 文件 | 职责 |
|------|------|
| `config.go` | `Config` 解析：config.json + 环境变量，三层优先级 |
| `provider.go` | OpenTelemetry provider 初始化（meter + tracer） |
| `exporter.go` | console / OTLP gRPC / OTLP HTTP 导出器 |
| `metrics.go` | 8 个 metric 的定义与 Record 函数 |
| `span.go` | span 辅助（StartSpan / StartLLMSpan / StartToolSpan / SetAttr） |
| `events.go` | 结构化事件 + 人性化 stdout 进度打印 |
| `shutdown.go` | ShutdownWithTimeout |

## 17.2 配置与优先级

三层优先级（`config.go:110 ResolveConfig`）：

```
默认(全关) < config.json telemetry.* < 环境变量
```

config.json 字段（`config.go:62`）：

```json
{
  "telemetry": {
    "enabled": true,
    "exporter": "console",           // "console" | "otlp"
    "otlp_endpoint": "http://collector:4317",
    "content_logging": false
  }
}
```

环境变量（`config.go:42 resolveEnv`）：

| 变量 | 作用 |
|------|------|
| `OCR_ENABLE_TELEMETRY=1` | 主开关 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 设了自动切 OTLP |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | grpc / http/protobuf / http/json |
| `OTEL_SERVICE_NAME` | 服务名 |
| `OCR_CONTENT_LOGGING=1` | 记录 prompt/response 全文 |

## 17.3 8 个 Metric

`metrics.go`：

| Metric | 类型 | 维度 |
|--------|------|------|
| `ocr.review.duration_seconds` | histogram | — |
| `ocr.files_reviewed_total` | counter | — |
| `ocr.comments_generated_total` | counter | — |
| `ocr.llm.requests_total` | counter | `model` / `status` |
| `ocr.llm.tokens_used` | counter | `type`(total) / `model` |
| `ocr.llm.request_duration_seconds` | histogram | `model` |
| `ocr.tool.calls_total` | counter | `tool.name` / `status` |
| `ocr.tool.execution_duration_seconds` | histogram | `tool.name` |

## 17.4 Spans 清单

`span.go` / `events.go` 里出现的 span/event 名（从各调用点收集）：

| Span 名 | 出处 |
|---------|------|
| `diff.parse` | `agent.go:197` |
| `review.run` | `review_cmd.go:193` |
| `scan.run` | `scan_cmd.go:180` |
| `subtask.execute.<path>` | `agent.go:577` |
| `main.loop` | `agent.go:661` |
| `plan.execute` | `agent.go:927` |
| `review_filter.execute` | `agent.go:696` |
| `scan.subtask.<path>` | `scan/agent.go:544` |
| `scan.enumerate` | `scan/agent.go:213` |
| `llm.`（StartLLMSpan） | `loop.go:173` |
| `tool.`（StartToolSpan） | `loop.go:290` |

Events：`review.started`、`no.files.changed`、`scan.started`、`scan.no.files`、`token.threshold.exceeded`、`plan.failed`、`plan.skipped`、`subtask.panic`、`subtask.error`、`scan.subtask.error`、`budget...` 等。

## 17.5 人性化 stdout（events.go）

OCR 把 telemetry 事件同时翻译成 `[ocr]` 前缀的彩色 stdout 行，供 human 交互模式（`--audience human`）看进度：

```
[ocr] 📤 tool_call code_search started
[ocr] ✅ tool_call code_search finished in 12ms
[ocr] 💭 LLM request (main_task) 2.1s, 4.3k tokens
```

`--audience agent` / `--format json` 会通过 `stdout.Quiet()` 静音这些行。`events.go` 里有一组 `PrintToolCallStarted/Finished/Error`、`PrintLLMRequest` 等。

## 17.6 Trace 上下文传播

`cmd/opencodereview` 支持从环境读 trace parent（`telemetry.ContextWithTraceParentFromEnv`），使 OCR 能被外部 trace 系统当作子 span 关联。`review_cmd.go:200` 打印 `[ocr] TraceID: ...`（非 json 模式）。

## 17.7 落地建议

- **个人使用**：`OCR_ENABLE_TELEMETRY=1` + `exporter: console` 即可看到每次 review 的耗时/token/工具调用摘要。
- **公司统一观测**：OTLP 推到 Collector，再进 Grafana/Jaeger。按 `model`/`status` 维度看 LLM 请求量和失败率，按 `tool.name` 看哪些工具调用最多（决定要不要精简工具集）。
- **内容审计**：`content_logging: true` 会把完整 prompt/response 发到 exporter——**注意这含源码**，务必只在受控网络里开。

> 坑：OTLP gRPC exporter 需要 `grpc` 依赖，OCR 已经静态链接。但如果你自己编译时 `CGO_ENABLED=1` 而目标机器没有相关动态库，可能会在 exporter 初始化时失败——`telemetry.Init` 失败是静默的（`provider.go`），不会崩。
