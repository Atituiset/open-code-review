# B. 环境变量总览

## B.1 OCR 自身

| 变量 | 作用 | 出处 |
|------|------|------|
| `OCR_CONFIG_PATH` | 覆盖 config.json **读**路径（写仍走默认路径） | `config_cmd.go:95` |
| `OCR_LLM_URL` | LLM endpoint URL（与 TOKEN+MODEL 三件齐才生效） | `llm/resolver.go` |
| `OCR_LLM_TOKEN` | LLM API token | 同上 |
| `OCR_LLM_MODEL` | 默认模型名 | 同上 |
| `OCR_LLM_PROTOCOL` | `anthropic`/`openai`/`openai-responses` | 同上 |
| `OCR_LLM_AUTH_HEADER` | 认证 header 名 | 同上 |
| `OCR_LLM_EXTRA_HEADERS` | 额外请求头 JSON | `llm/resolver.go` |
| `OCR_LLM_TIMEOUT` | 全局请求超时（秒） | `resolver.go` |
| `OCR_USE_ANTHROPIC` | legacy：true 表示用 anthropic 协议 | `resolver.go` |
| `OCR_LLM_USE_ANTHROPIC` | GitHub Action input 专用 | `action.yml` |
| `OCR_ENABLE_TELEMETRY=1` | 开 telemetry | `telemetry/config.go` |
| `OCR_CONTENT_LOGGING=1` | telemetry 记录 prompt/response 全文 | 同上 |
| `OCR_NO_UPDATE=1` | 关 npm 包装的自动更新检查 | `bin/ocr.js` |
| `OCR_UPDATE_INTERVAL` | 更新检查间隔（分钟，默认 18） | 同上 |
| `OCR_VERSION` | install 脚本指定版本 | `install.sh/ps1` |
| `OCR_INSTALL_DIR` | install 脚本安装目录 | 同上 |

## B.2 Provider API key 回退（18 个）

`providers.go` 每个 provider 的 `EnvVar`：

`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `EDENAI_API_KEY` / `DASHSCOPE_API_KEY` / `DASHSCOPE_TOKENPLAN_KEY` / `ARK_API_KEY` / `DEEPSEEK_API_KEY` / `TENCENT_TOKENHUB_API_KEY` / `TENCENT_HUNYUAN_TOKENPLAN_KEY` / `SPARK_API_KEY` / `MOONSHOT_API_KEY` / `Z_AI_API_KEY` / `Z_AI_CODING_API_KEY` / `MIMO_API_KEY` / `MINIMAX_API_KEY` / `QIANFAN_API_KEY` / `OLLAMA_API_KEY` / `LITELLM_API_KEY`

## B.3 Claude Code 兼容

| 变量 | 作用 |
|------|------|
| `ANTHROPIC_BASE_URL` | 被 `tryCCEnv` 直接采用 |
| `ANTHROPIC_AUTH_TOKEN` | 同上 |
| `ANTHROPIC_MODEL` | 同上 |

## B.4 OpenTelemetry 标准

| 变量 | 作用 |
|------|------|
| `OTEL_SERVICE_NAME` | 服务名 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | collector 地址（设了就切 OTLP） |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | grpc / http/protobuf / http/json |
| `traceparent` | 外部 trace 关联（`ContextWithTraceParentFromEnv`） |
| `TRACEPARENT` | 同上（标准拼写） |

## B.5 CI 辅助（post_review 脚本用）

`examples/*` 里 post_review.py 使用的平台变量（GitLab `CI_MERGE_REQUEST_IID`、Bitbucket `BITBUCKET_COMMIT`、Codeup `CODEUP_*`、GitFlic `GITFLIC_TOKEN` 等），见各 examples README。
