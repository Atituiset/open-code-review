# 23. 配置 LLM 提供商

## 23.1 三种配置入口

| 入口 | 命令/文件 | 适用 |
|------|----------|------|
| 交互式 | `ocr config provider` → 选 provider → 选 model → 输 key → 自动测连 | 个人首次配置 |
| CLI | `ocr config set provider anthropic` / `ocr config set model <name>` 等（空格分隔，点分路径） | CI / 脚本化 |
| 环境变量 | `OCR_LLM_URL` + `OCR_LLM_TOKEN` + `OCR_LLM_MODEL` | CI / 容器，避免写 key 到文件 |

配置文件最终落在 `~/.opencodereview/config.json`。

## 23.2 交互式配置（`ocr config provider`）

bubbletea TUI 流程：

1. 列出 18 个内置 provider（排序）；
2. 选 provider → 列出它预设的 models；
3. 选 model → 输入 API key（masked）；
4. "Test connectivity" → `ocr llm test` 验证；
5. 写入 config.json。

写入的内容形如：

```json
{
  "provider": "dashscope",
  "model": "qwen3.7-max",
  "providers": {
    "dashscope": {
      "api_key": "sk-...",
      "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1"
    }
  },
  "language": "Chinese"
}
```

## 23.3 环境变量快速配置（CI 友好）

最简三件套：

```bash
export OCR_LLM_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export OCR_LLM_TOKEN="sk-xxx"
export OCR_LLM_MODEL="qwen3.7-max"
ocr review --from main --to feature
```

可选：

```bash
export OCR_LLM_PROTOCOL="openai"          # anthropic | openai | openai-responses
export OCR_LLM_AUTH_HEADER="authorization"
export OCR_LLM_EXTRA_HEADERS='{"X-Org":"my-team"}'
export OCR_LLM_TIMEOUT="300"              # 秒，全局覆盖
```

**优先级**：环境变量 > config.json。所以 CI 里用环境变量、本地用 config.json，互不干扰。

## 23.4 三种协议速查

| protocol | 典型 BaseURL | 认证 | 备注 |
|----------|-------------|------|------|
| `anthropic` | `https://api.anthropic.com` | `x-api-key` 或 `authorization` | 走 /v1/messages；自动加 prompt cache_control |
| `openai` | `https://api.openai.com/v1` | Bearer | 走 /chat/completions；补 /chat/completions 后缀 |
| `openai-responses` | OpenAI /v1 | Bearer | 走 /responses；支持 cache key / reasoning |

## 23.5 自定义 provider（网关/内网/推理平台）

```bash
ocr config set custom_providers.mycompany.url "https://llm.internal.company.com/v1"
ocr config set custom_providers.mycompany.protocol "openai"
ocr config set custom_providers.mycompany.api_key "sk-..."
ocr config set custom_providers.mycompany.model "my-llm-7b"
ocr config set provider "mycompany"
```

`CustomProviders` 要求 `url` + `protocol`（相比 `Providers` 只覆盖预设字段，它完全是新的）。

## 23.6 复用 Claude Code 的配置（零配置迁移）

如果你本机已经配好 Claude Code 环境变量：

```bash
export ANTHROPIC_BASE_URL="..."
export ANTHROPIC_AUTH_TOKEN="..."
export ANTHROPIC_MODEL="..."
```

OCR 的 `tryCCEnv` 策略会自动读到，**无需任何 OCR 配置**。`tryShellRC` 还会去 grep 你的 `~/.zshrc`/`~/.bashrc` 里的 export 行——但这条兜底策略在服务器上可能意外读到已废弃的 token，注意排查（`ocr llm test` 能验证到底用了哪个）。

## 23.7 配置语言

```bash
ocr config set language "Chinese"    # 评论用中文
ocr config set language "English"
```

影响：所有 system prompt 末尾追加 `Always respond in <Language>.`（见 14.4）。**只影响自然语言部分**，JSON/enum 字段仍是英文。

## 23.8 诊断工具

```bash
ocr llm test                # 连通性 + 模型回答
```

> 没有 `ocr config get` 子命令。想核对当前生效配置：直接看
> `~/.opencodereview/config.json`（key 明文存放，别贴到公共频道），或用
> `ocr llm test` 确认最终 resolve 到哪个 endpoint。
```

## 23.9 常见坑

1. **URL 写错协议**：给 `openai` 协议传了一个只支持 Anthropic 的网关地址 → 报 404。先 `ocr llm test` 验证。
2. **token 过期/错配**：`providers.<name>.api_key` 覆盖了 provider 预设的 EnvVar，改 key 后要确认写进了 config 而不是 env 变量残留。
3. **`extra_body` 无环境变量通道**：`extra_body`（如 `{"thinking":{"type":"disabled"}}`）只能走 config.json，不能走 OCR_LLM_EXTRA_BODY（没有这个 env）。GitHub Action 里就是靠 `ocr config set llm.extra_body ...` 写的。
4. **内网网关带前缀**：网关常在 URL 后带 `/api/v1`，而 OCR 的 `openai` client 会强制拼 `/chat/completions`。传完整路径 `.../api/v1/chat/completions` 或 `.../api/v1` 都行（client 会自适应，见 `client.go:305`）。
5. **403/401**：多为 header 不对。`openai` 用 `authorization: Bearer <token>`，`anthropic` 用 `x-api-key`。自定义 provider 记得设 `auth_header`。
