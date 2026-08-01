# 13. config & rules：配置体系与规则匹配

`internal/config/` 是 OCR 的运行期"基因库"。一切 prompt、规则、工具 schema、provider preset 都通过 `//go:embed` 进二进制；用户可覆盖的部分，分多个层级叠加到一起。本章给一份源码级的规则匹配器与配置解析器剖析。

## 13.1 目录与文件一览

```
internal/config/
├── rules/
│   ├── system_rules.go      ← Resolver 接口 + composedResolver + LoadDefault
│   ├── system_rules.json    ← path_rule_map (32 模式)
│   ├── rule_docs/*.md       ← 33 个语言/技术专属规则文本
│   └── *_test.go
├── allowlist/
│   ├── allowed_ext.go       ← IsAllowedExt / IsExcludedPath
│   ├── supported_file_types.json   ← 82 扩展名
│   └── default_exclude_patterns.json  ← 17 排除 globs
└── template/
    ├── template.go          ← TaskTemplate / ScanTemplate 解析 + Validate + ApplyLanguage
    ├── task_template.json   ← diff-review task config
    ├── scan_template.json   ← scan task config
    ├── toolsconfig/         ← tools.json + ToolConfigEntry
    ├── testconnection/      ← task.json (ocr llm test)
    └── prompts/*.md         ← 10 个 diff-review prompt 文本
```

## 13.2 Config 主文件

用户主配置存于 `~/.opencodereview/config.json`。`cmd/opencodereview/config_cmd.go` 定义结构（化简）：

```go
type Config struct {
    Provider        string                     `json:"provider,omitempty"`
    Model           string                     `json:"model,omitempty"`
    Providers       map[string]ProviderEntry   `json:"providers,omitempty"`
    CustomProviders map[string]ProviderEntry   `json:"custom_providers,omitempty"`
    Llm             LlmConfig                  `json:"llm,omitempty"`
    Language        string                     `json:"language,omitempty"`
    Telemetry       *TelemetryConfig           `json:"telemetry,omitempty"`
    MCPServers      map[string]MCPServerConfig `json:"mcp_servers,omitempty"`
}
```

`Providers` vs `CustomProviders`：Providers 是对预设 provider 的"局部覆盖"（如设了 `dashscope.api_key` 而不写 base_url）；CustomProviders 是全新 provider，需要 `url`+`protocol`。Llm 是 legacy 块（旧用户常用），resolver 优先级是先看 `Provider`+`Providers.*` 再 fallback 到 `Llm`。

`setConfigValue`（`config_cmd.go:349`）支持点分路径：

```
provider
model
providers.<name>.<field>           field ∈ {api_key, url, model, protocol, models, auth_header, timeout_sec, extra_body, extra_headers}
custom_providers.<name>.<field>    必填 url+protocol
llm.<field>                        兼容旧
mcp_servers.<name>.<field>        type/command/args/env/url/headers/tools/setup
language                           "English"/"Chinese"等
telemetry.{enabled,exporter,otlp_endpoint,content_logging}
```

protocol 三态：`anthropic` / `openai` / `openai-responses`。

**写路径**：`defaultConfigPath()` 始终返回 `~/.opencodereview/config.json`，即使 `OCR_CONFIG_PATH` 设了——后者只影响**读**，防 OCR_CONFIG_PATH 重定向写入。

## 13.3 Endpoint resolver：四策略瀑布

`internal/llm/resolver.go` 的 `ResolveEndpointWithModelOverride` 顺序四策略：

| # | 策略 | 来源 | 三件齐？ |
|---|------|------|---------|
| 1 | tryOCRConfig | config.json `providers.<provider>` 或 `llm.*`，或 provider preset env fallback | URL+Token+Model |
| 2 | tryOCREnv | `OCR_LLM_URL`+`OCR_LLM_TOKEN`+`OCR_LLM_MODEL`（+可选 `OCR_LLM_PROTOCOL`/`OCR_LLM_AUTH_HEADER`/`OCR_LLM_EXTRA_HEADERS`） | 全 |
| 3 | tryCCEnv | `ANTHROPIC_BASE_URL`+`ANTHROPIC_AUTH_TOKEN`+`ANTHROPIC_MODEL`（兼容 Claude Code 已登录） | 全 |
| 4 | tryShellRC | grep `~/.zshrc` 等 `export ANTHROPIC_BASE_URL=...` 行 | regex 抽 |

失败提示比较友好：报"哪个 strategy 缺哪件"。

## 13.4 18 个内置 provider

`internal/llm/providers.go` 注册了下列预设（用 `LookupProvider(name)` 查找）：

| Name | Protocol | 默认 BaseURL | EnvVar |
|------|---------|------------|--------|
| `anthropic` | anthropic | api.anthropic.com | `ANTHROPIC_API_KEY` |
| `openai` | openai | api.openai.com/v1 | `OPENAI_API_KEY` |
| `edenai` | openai | api.edenai.run/v3 | `EDENAI_API_KEY` |
| `dashscope` | openai | dashscope.aliyuncs.com/compatible-mode/v1 | `DASHSCOPE_API_KEY` |
| `dashscope-tokenplan` | openai | token-plan.cn-beijing.maas.aliyuncs.com/... | `DASHSCOPE_TOKENPLAN_KEY` |
| `volcengine` | openai | ark.cn-beijing.volces.com/api/v3 | `ARK_API_KEY` |
| `deepseek` | openai | api.deepseek.com/v1 | `DEEPSEEK_API_KEY` |
| `tencent-tokenhub` | openai | hunyuan.tencent.com/api/v1 | `TENCENT_TOKENHUB_API_KEY` |
| `hy-tokenplan` | openai | hy.tencentcloudapi.com | `TENCENT_HUNYUAN_TOKENPLAN_KEY` |
| `iflytek` | openai | spark-api-open.xf-yun.com/v1 | `SPARK_API_KEY` |
| `kimi` | openai | api.moonshot.cn/v1 | `MOONSHOT_API_KEY` |
| `z-ai` | openai | api.z.ai/api/paas/v4 | `Z_AI_API_KEY` |
| `z-ai-coding` | openai | api.z.ai/api/paas/v4 | `Z_AI_CODING_API_KEY` |
| `mimo` | openai | api.mimogpt.com/v1 | `MIMO_API_KEY` |
| `minimax` | openai | api.minimaxi.com/v1 | `MINIMAX_API_KEY` |
| `baidu-qianfan` | openai | qianfan.baidubce.com/v2 | `QIANFAN_API_KEY` |
| `ollama-cloud` | openai | 127.0.0.1:11434/v1 | （无） |
| `litellm` | openai | localhost:4000/v1 | `LITELLM_API_KEY` |

每个 provider 含 `Models` 列表（provider_tui 会列出供选）。

## 13.5 四层规则合成

第 3 章讲过 `system_rules.go:252 NewResolver` 的层级。这里回顾优先级并讲 "merge" 细节：

| Priority | Source | 文件 | 加载 |
|----------|--------|------|-----|
| 1 custom | `--rule <path>` | 任意 JSON | `loadRuleFile` |
| 2 project | `<repo>/.opencodereview/rule.json` | JSON | `loadProjectRule` |
| 3 global | `~/.opencodereview/rule.json` | JSON | `loadGlobalRule` |
| 4 system | embed `system_rules.json` + `rule_docs/*` | binary | `LoadDefault` |

`composedResolver.Resolve`（`system_rules.go:372`）顺序遍历前三层，每层 `matchProjectRuleEntry`。**第一命中者赢**，且默认**直接返回 entry.Rule 的内容**（替换系统规则）。

当 entry 设了 `merge_system_rule=true` 时调 `mergeWithSystemRule`：

```
## System-Specific Rules (Mandatory)

<systemRule>

---

## User-Specific Rules (Mandatory)

<userRule>
```

这样模型同时看到两套；适合"保留通用 default 行为 + 加几条业务特定规则"。

## 13.6 `system_rules.json` 结构

只有两个顶层 key：

```json
{
  "default_rule": "default.md",
  "path_rule_map": {
    "**/Cargo.toml": "cargo_toml.md",
    ".github/workflows/**/*.{yaml,yml}": "github_workflows.md",
    "**/*{mapper,dao}*.xml": "mapper_dao_xml.md",
    "**/*.go": "go.md",
    "...": "..."
  }
}
```

`path_rule_map` 虽是 JSON 对象，但通过自定义 `UnmarshalJSON` 用 streaming decoder 保序（`system_rules.go:33-81`），所以"声明顺序决定优先级"才能保证。Go map 反序列化是无序的，OCR 这里特意写了自定义 UnmarshalJSON 留住 JSON 文件里的顺序。

`LoadDefault`（`system_rules.go:87`）把每个 path 的 `<file>.md` filename 替换成 `rule_docs/<file>` 的实际文本内容。这一步通过 `//go:embed rule_docs/*` 在编译时嵌入，运行期不读盘。

### 32 个 path pattern 概览

- 主流语言：`**/*.go`、`**/*.java`、`**/*.py`、`**/*.rs`、`**/*.{kt}`
- TS/JS：`**/*.{ts,js,tsx,jsx}`
- C/C++：`**/*.{cpp,cc,hpp}`、`**/*.c`
- 其它：`**/*.{php,phtml}`、`**/*.ets` (HarmonyOS ArkTS)
- IaC：`**/*.tf`、`**/*.bicep`、`**/*.hcl`
- Schema：`**/*.proto`、`**/*.graphql`、`**/*.prisma`
- 构建：`**/Cargo.toml`、`**/package.json`、`**/pom.xml`、`**/build.gradle`、`**/composer.json`
- 模板：`**/*.ftl`（freemarker）、`**/*.astro`
- 配置 / 元数据：`**/*.json`、`**/*.yaml`、`**/*.yml`、`**/*.properties`
- GitHub：`.github/workflows/**/*.{yaml,yml}`、`.github/**/*.{yaml,yml}`
- MyBatis：`**/*{mapper,dao}*.xml`
- Julia、i18n：`**/*.jl`、`**/*.po`、`**/*.pot`

## 13.7 rule_docs 文本：规则真正内容

`rule_docs/*.md` 是规则的实质文本（system_rules.json 只是 pattern→md 的索引）。例：

- `go.md`（最长，~10.8 KB）：errors/panics、context/goroutines、slices/maps/Numeric Boundaries、安全敏感边界、并发场景。特别叮嘱"先 file_read 或 code_search 确认 reachability 再报"。
- `java.md`：NPE、switch fall-through、线程安全、double-checked locking。
- `python.md`：可变默认参数、`==` vs `is`、`bare except`、async 阻塞。
- `ts_js_tsx_jsx.md`：React hooks 规则、`===`、`Promise.all`、XSS。
- `default.md`：fallback 通用类，Correctness / Security / Performance / Maintainability / Test 5 段。

这些 markdown 文本最终通过 `{{system_rule}}` 占位符注入 LLM 的 main_task_user / plan_task_user 提示词。

## 13.8 Allowlist：扩展名白名单 + 默认排除

`internal/config/allowlist/allowed_ext.go` 提供：

- `IsAllowedExt(ext)`：80 个白名单扩展（`.go`/`.java`/`.py`/.../`.vue`/`.svelte`/`.astro`/`.tf`/.../.proto）。case-insensitive。
- `IsExcludedPath(path)`：17 个排除 glob，主要针对**测试文件**：`**/*_test.go`、`**/src/test/java/**/*.java`、`**/*.test.{js,jsx,ts,tsx}`、`**/__tests__/**`、`**/*_test.py`、`**/*_spec.rb`、`**/*Test.java`、`**/oh_modules/**`（HarmonyOS）、...。

`//go:embed supported_file_types.json` + `default_exclude_patterns.json` 进二进制。

### 用户 include 可绕过 allowlist

`agent.go` 的 `whyExcluded` 顺序：

1. binary → drop
2. user exclude → drop
3. **HasInclude && IsUserIncluded → 优先放行**（#371）
4. 不在 IsAllowedExt → drop
5. IsExcludedPath → drop

所以如果你的项目要审 `.ftl` Freemarker（不在默认白名单），可以写 `.opencodereview/rule.json`：

```json
{ "include": ["**/*.ftl"], "rules": [{"path": "**/*.ftl", "rule": "<custom rule text>"}] }
```

`include` 把它显式放进去，绕过白名单限制。

## 13.9 template 加载与 ApplyLanguage

`template.go`：

- `LoadDefault()`：embed `task_template.json` + 用 `prompts/*.md` 文件填充每个 conversation 的 message content。
- `LoadScanDefault()`：embed `scan_template.json`（prompt 文本**内联**在 json 里，不再 read prompts/*.md）。
- `Validate()`：`MAX_TOKENS > 0`、`MAX_TOOL_REQUEST_TIMES > 0`、`MAIN_TASK.messages` 非空。
- `ApplyLanguage(lang)`：对 MAIN_TASK/PLAN_TASK/MEMORY_COMPRESSION_TASK 的最后一个 system message 追加 `"\n\nAlways respond in <Language>."`，默认 English。

设计上 prompt 是"基础模板 + 后期加语言 hint"分离的，这样不用为每种语言维护一份 prompt 文件。

## 13.10 工程取舍

读完这一章你应该看到 OCR 的配置体系刻意做了几件工程取舍：

1. **JSON 保序**：自定义 UnmarshalJSON 留住 entry 顺序，让"declaration order = priority"在 Go 里能成立。
2. **用户 include 可绕 allowlist**：保证深度定制能力，不被白名单卡死。
3. **二进制内嵌**：所有 prompt/rule/tool schema 在编译时入 binary，运行不读盘、不联网下载。
4. **两套 prompt 体系**：diff-review / scan 各自独立，可同步演进不互相污染。
5. **兼容 Claude Code env**：`tryCCEnv` 让 CC 用户零配置可跑 OCR。

下一章讲这些 prompt 文本里的具体内容。
