# 5. LLM 客户端与多协议抽象

`internal/llm/` 是 OCR 的"网卡层"：它把三家协议、HTTP 细节、token 计算、缓存控制、SDK 错误重试都收敛在一个接口 `LLMClient` 后面，让上层 `llmloop.Runner` 完全不必关心 San Кабыт这样的协议差异。

## 5.1 一图看懂三层

```
┌─────────────────────────────────────┐
│   LLMClient (interface)             │  llm/client.go:35
│   CompletionsWithCtx(ctx, ChatRequest) (*ChatResponse, error)
└────────────┬────────────────────────┘
             │ 实现 3 个
   ┌─────────┼─────────────┬──────────────┐
   ▼         ▼             ▼              ▼
 OpenAIClient  AnthropicClient  OpenAIResponsesClient
 (chat)        (/v1/messages)   (/responses)
   │             │                  │
   ▼             ▼                  ▼
 github.com/openai/openai-go/v3   anthropics/anthropic-sdk-go   (responses_client.go)
```

`NewLLMClient`（`client.go:205`）按 `ep.Protocol` dispatch，三个 canonical 值定义在 `protocol.go`。未识别协议**退回 OpenAIClient**（兼容 legacy）。

## 5.2 `ChatRequest` / `ChatResponse`：上下层契约

```go
type ChatRequest struct {
    Model       string
    Messages    []Message    // 含 role/content/tool_calls
    Tools       []ToolDef   // OpenAI 风格 function schema
    Temperature *float64
    MaxTokens   int
    SessionID   string       // 仅 Responses API 客户端用它设 `prompt_cache_key`
}
```

`Message.Content` 是 `any`：字符串 OR `[]ContentBlock`（Anthropic 多块内容）。`ToolCall` 用 OpenAI 的 `function` 形态承载（`id/type/function.name/function.arguments(JSON 字符串)`），在 Anthropic 端翻译成 `tool_use` block 时会 `json.Unmarshal` 一次。

`ChatResponse` 抽象度很高——它**已经是 OpenAI 形态**：

```go
type ChatResponse struct {
    Choices []Choice   // 一条 (Anthropic 强制单 choice；OpenAI 也只取一个)
    Usage   *UsageInfo
}
```

`Choice.Message.ToolCalls` 是归一化的 `[]ToolCall`。这意味着 `llmloop.loop.go:203 resp.ToolCalls()` 不需要 if-else 区分协议——协议差异全在 client 内部消解。

## 5.3 三种协议适配的差异要点

### OpenAIClient（`client.go:294-562`）

- 用官方 SDK `github.com/openai/openai-go/v3`，`WithMaxRetries(5)` + `WithRequestTimeout(cfg.Timeout)`，默认 5 分钟。
- **URL 后缀补齐**：如果给的 URL 不以 `/chat/completions` 结尾，自动补一次（`client.go:305`）；再把 `/chat/completions` 剥掉作为 baseURL 传 SDK。所以 `OCR_LLM_URL=https://api.openai.com/v1`、`=https://api.openai.com/v1/chat/completions` 都能用。
- 支持 `extra_body.stream=true` 切流式（`completionsStreaming`），用 SDK accumulator 拼装；流式时特别处理 `reasoning_content` 这种非标字段（多为 DeepSeek-R1 系模型用）。
- tool_call 序列化：`asst.ToolCalls = append(..., openai.ChatCompletionMessageFunctionToolCallParam{ID, Function{Name, Arguments}})`。

### AnthropicClient（`client.go:567-856`）

- 用 `github.com/anthropics/anthropic-sdk-go`。
- URL 后缀补 `/v1/messages`。**auth header 三态**：`authorization` → `WithAuthToken`，`x-api-key` → `WithAPIKey`，其它 → 自定义 header。`NormalizeAuthHeader`（`protocol.go`）把大小写差异吸收掉。
- **system blocks + tools 强制带 `cache_control: ephemeral`**（`client.go:748/752`）——这是 Anthropic prompt caching 的关键，使大 system prompt 和工具 schema 命中缓存，省 token 又省延迟。
- **tool_use ↔ tool_call 翻译**：
  - 输入侧 `buildAnthropicParams:695`：`anthropic.NewToolUseBlock(tc.ID, argsMap, tc.Function.Name)`，`argsMap` 是 `json.Unmarshal(arguments)` 得到的；并 guard `arguments=null` 变成 `map[string]any{}`（`#382` bugfix）。
  - 输出侧 `mapAnthropicResponse:792`：`block.Type == "tool_use"` → `ToolCall{ID: block.ID, Function.Name: block.Name, Arguments: string(block.Input)}`。
- `usage` 把 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` 都算入 `PromptTokens`，并把后两者单独存进 `CacheReadTokens` / `CacheWriteTokens`——上层 `Runner.TotalTokensUsed()` 因此准确反映**包含缓存的真实消耗**。
- `thinking` block 被收集到 `ReasoningContent`，最终通过 `ChatResponse.Content()` 只在文本空时回退显示（`client.go:150`）。
- `stripThinkTags` 用 byte-构造法剥离 `` 标签（兼容 DeepSeek 等"思考模式"包装）。

### OpenAIResponsesClient（`responses_client.go`）

- 用 Responses API（`/responses`）。关键差异是它的 tool call 风格、`reasoning` 项、`prompt_cache_key`（这就是为什么 `ChatRequest.SessionID` 存在）。
- 这个 client 比上面两个新，主要是为了支持 OpenAI 之后的 Responses 路线（含 reasoning models）。

## 5.4 token 计数：tiktoken + 内嵌 BPE

OCR 在三个地方需要本地估算 token：
- 预审阶段的成本估算（`agent.estimate.go` / `scan.estimate.go`）；
- 大文件过滤（`agent.filterLargeDiffs`：diff 自身 token >80% MaxTokens 直接跳过）；
- 上下文压缩决策（`llmloop.CountMessagesTokens` 与各 `warnLimit` 比较）。

实现：`client.go:269 CountTokens` → `countTokensWithEncoding` → `tiktoken.GetEncoding(encName)`。

**关键技巧**：tiktoken-go 默认要从网络下载 BPE 词表（`tiktoken`）。OCR 把它**内嵌到二进制**（`internal/llm/bpe_data/*` + `embedded_loader.go:InitEmbeddedLoader` 注册给 tiktoken），所以 `ocr` 在隔离网环境里也能本地估 token。

`encodingForModel`（`client.go:281`）按模型名子串选择编码：
- 含 `o1` / `o3` / `o4` → `o200k_base`
- 默认 → `cl100k_base`

> 注意：这是一个 OpenAI 训练的 tokenizer，对 Anthropic / Qwen / DeepSeek 等模型**只是近似**，会偏低估约 5-15%。生产 token 真值要看 API 返回的 `Usage`，不要把 `CountTokens` 当账单。

## 5.5 Endpoint resolver：怎么知道用哪个 LLM

`internal/llm/resolver.go` 的 `ResolveEndpointWithModelOverride` 是个四策略瀑布模型，**先找到 URL+Token+Model 三件齐的就赢**：

```
1. tryOCRConfig    : config.json 的 provider/preset 或 legacy llm.* 块
2. tryOCREnv       : OCR_LLM_URL + OCR_LLM_TOKEN + OCR_LLM_MODEL
3. tryCCEnv        : ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN + ANTHROPIC_MODEL
                     (兼容 Claude Code 已登录用户的 env)
4. tryShellRC      : 上面都没找到时 grep ~/.zshrc / ~/.bashrc 等的 export 行
```

每一策略里，provider 的 `api_key` 缺失会回退到 provider 预设的 `EnvVar`（如 `ANTHROPIC_API_KEY`）。18 个内置 provider 预设在 `llm/providers.go`（详见 13 章），含 anthropic、openai、edenai、dashscope、dashscope-tokenplan、volcengine、deepseek、tencent-tokenhub、hy-tokenplan、iflytek、kimi、z-ai、z-ai-coding、mimo、minimax、baidu-qianfan、ollama-cloud、litellm。

## 5.6 错误处理与重试

OCR 在 SDK 层依赖官方 client 的 `WithMaxRetries(5)`，不再自己包 backoff——两个 SDK 都用指数退避处理 429/500/瞬时网络错误。**业务层不做单 LLM 调用 retry**，原因是上层 `RunPerFile` 已经有"工具调用循环 + 上下文压缩"的天然重入点；调用失败直接 `return false, fmt.Errorf("LLM completion error: %w", err)`，被 agent 标为 subtask_error。

唯一例外：`agent.executePlanPhase` 失败时**不阻断 main**，只是把 `planResult = ""`，让 main task 在没有 plan 的情况下继续——plan 是优化不是必要。

## 5.7 何时选哪个协议

给上层使用者一个决策参考：

- 你的网关只暴露 OpenAI 兼容 `/chat/completions` → 用 `openai`。
- 你的网关是 OpenAI 真 Responses API → `openai-responses`（可获得 cache key、reasoning items）。
- 你直连 Anthropic 或厂商走原生 Messages API → `anthropic`（可获得 prompt cache 折扣）。

preset provider 列表里每一项都标了 `Protocol` 字段，没有自动探测——你必须配 `protocol` 字。`ocr config provider` TUI 会按 preset 自动填，自定义时记住设 `protocol`。
