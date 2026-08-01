# 30. 可观测性接入

## 30.1 开关与优先级

三层配置（默认全关）：

```
默认(disabled) < config.json telemetry.* < 环境变量
```

### 方式 A：环境变量（最简单）

```bash
export OCR_ENABLE_TELEMETRY=1
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
export OTEL_SERVICE_NAME=code-review
ocr review --from main --to feature
```

设了 `OTEL_EXPORTER_OTLP_ENDPOINT` 会自动切 OTLP exporter。

### 方式 B：config.json

```json
{
  "telemetry": {
    "enabled": true,
    "exporter": "otlp",
    "otlp_endpoint": "http://collector:4317",
    "content_logging": false
  }
}
```

`exporter` 可选 `console` 或 `otlp`。`content_logging: true` 会把完整 prompt/response 发送（**含源码，谨慎**）。

## 30.2 落地示例：Grafana/Jaeger

```
ocr ──OTLP──► otel-collector ──► Prometheus (metrics) / Jaeger (traces)
```

推荐 dashboards：

- **review 质量**：`ocr.review.duration_seconds`、`ocr.comments_generated_total`、`ocr.files_reviewed_total`
- **LLM 成本**：`ocr.llm.tokens_used`（按 `model`）、`ocr.llm.requests_total`（按 `status`）
- **工具健康**：`ocr.tool.calls_total`（按 `tool.name`、`status`）、`ocr.tool.execution_duration_seconds`
- **失败率**：`ocr.llm.requests_total{status="error"}` 占比、trace 里 `subtask.error`/`llm.error` span

## 30.3 Console 模式（个人调试）

```bash
OCR_ENABLE_TELEMETRY=1 ocr review --from main --to feature
```

stdout 会多出：
- `[ocr] TraceID: ...`
- 每次 LLM/工具的 span 摘要（`events.go` 的彩色行）
- 结束的 trace summary

对"看看这次 review 慢在哪、token 花哪了"非常够用。

## 30.4 Trace 关联

- 每次 review 生成一个 trace（`review.run` / `scan.run`），子 span 覆盖 diff.parse / subtask / plan / main.loop / review_filter / 每次 LLM / 每个工具。
- `review_cmd.go:193` 用 `telemetry.ContextWithTraceParentFromEnv` 读 `traceparent` 环境变量，**可被外部系统当子 span 挂接**（比如你的 CI runner 发出 traceparent，OCR 自动成为其子 span）。
- TraceID 也会打印到 stderr（非 json 模式），方便事后对账。

## 30.5 数据安全红线

- `content_logging: true` + OTLP 会把**完整源码 + LLM 分析**发到 collector——**只在受控网络开**，且确认 collector 侧访问控制。
- 即使 `content_logging: false`，metrics 也带 `model`/`tool.name`/`status` 标签，无源码内容，可安全发给共享观测平台。
- session JSONL（`~/.opencodereview/sessions/`）与 telemetry 独立，永远记录内容（见 29.6）。

## 30.6 坑点

1. **OTLP gRPC 需依赖**：OCR 静态链接了 grpc；但若你自己编译时 CGO 混用，初始化失败是静默的（`provider.go` 不 panic）。
2. **`OTEL_EXPORTER_OTLP_PROTOCOL` 默认 grpc**：你的 collector 若只开 http/protobuf，要显式设 `http/protobuf`。
3. **console exporter 在 `--audience agent` 下**：静音机制只静音 `stdout.Writer()` 的进度行，console exporter 走 `fmt.Printf`（不静音）。agent 模式最好关 console telemetry，用 OTLP。
4. **metric 注册错误被吞**：`checkMetricErr` 是空函数（`metrics.go:72`），metric 注册失败静默，别指望它报错。
