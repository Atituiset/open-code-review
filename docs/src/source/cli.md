# 4. CLI 层与命令树

所有 `cmd/opencodereview/*.go` 是 OCR 唯一的可执行入口包。它只做三件事：**装配依赖、解析参数、调用 `internal/...`**。本层几乎不含业务逻辑，但它是理解整个产品交互和初始化顺序的钥匙。

## 4.1 入口点

`cmd/opencodereview/main.go:13` 是整个程序的 `main`：

```go
func main() {
    llm.AppVersion = Version      // ldflags 注入，详见 version.go
    llm.InitEmbeddedLoader()      // 初始化内嵌 tiktoken BPE 词表（见 5.4）
    ctx := context.Background()
    if telemetry.Init(ctx) {      // OpenTelemetry 初始化
        defer telemetry.ShutdownWithTimeout(ctx, 5*time.Second)
    }
    if err := rootCmd.Execute(); err != nil {
        fmt.Fprintf(os.Stderr, "Error: %v\n", err)
        os.Exit(1)
    }
}
```

注意三件事：
1. **`llm.InitEmbeddedLoader()`** 把 BPE 词表（`internal/llm/bpe_data/*`）开机就加载进 tiktoken。这意味着 OCR 的 token 计数**不依赖联网下载**，离线可用。
2. **`telemetry.Init`** 静默读 `~/.opencodereview/config.json` 的 `telemetry.enabled` 与 `OCR_ENABLE_TELEMETRY=1`；不开就什么都不做。
3. `Version`/`GitCommit`/`BuildDate` 是 ldflags 注入的包级变量（`cmd/opencodereview/version.go`），Makefile 里通过 `-X main.Version=...` 别给 `cmd/opencodereview`？——其实注入给的是 `cmd/opencodereview.Version`，再被 `llm.AppVersion` 引用作为 User-Agent。

## 4.2 命令树（Cobra）

`root.go` 注册根 `rootCmd`，子命令通过 `init()` 各自 `rootCmd.AddCommand(...)`。最近一次提交 `80a5794` 从 hand-rolled flag parser 迁到 Cobra，主要为了拿 shell completion。

| 子命令 | 文件 | 说明 |
|--------|------|------|
| `ocr review` | `review_cmd.go:46` | 主战场，diff-review |
| `ocr scan` | `scan_cmd.go:44` | 全文件审查 |
| `ocr delegate` | `delegate_cmd.go:29` | 委派模式（含 `preview`/`rule` 子子命令）|
| `ocr session` | `session_cmd.go` | `list`/`show`/`remove` 子命令 |
| `ocr viewer` | `viewer_cmd.go` | 启动会话 Web 回看 |
| `ocr config` | `config_cmd.go` | `set`/`get` 管理 `~/.opencodereview/config.json` |
| `ocr provider` (alias of `config provider`) | `provider_cmd.go` + `provider_tui.go` | bubbletea 交互式选 provider/model 并测连 |
| `ocr llm test` | `llm_cmd.go` | 跑 `testconnection/task.json` 的简单对话验证连通性 |
| `ocr rules check` | `rules_cmd.go` | 校验规则文件覆盖度 |

## 4.3 共享前置：`loadCommonContext`

`cmd/opencodereview/shared.go:49` 是 `review`/`scan`/`delegate` 共用的初始化函数，它顺序做了五件事——理解这个顺序很重要，因为它决定了你的 `--repo`/`--rule`/`--max-tools` 这些 flag 的生效时机：

```go
func loadCommonContext(repoDirInput, rulePath string, maxTools, maxGitProcs int, requireGit bool) (*commonContext, error) {
    tpl, err := template.LoadDefault()         // 1. 解 embed 的 task_template.json
    if maxTools > tpl.MaxToolRequestTimes {
        tpl.MaxToolRequestTimes = maxTools      // 2. --max-tools 仅"上抬"
    }
    tpl.Validate()                              // 3. MAX_TOKENS>0 等不变量

    repoDir, isGit, err := resolveWorkingDir(repoDirInput, requireGit) // 4. 工作目录锚定
    resolver, fileFilter, err := rules.NewResolver(repoDir, rulePath) // 5. 4 层规则合成

    return &commonContext{
        Template: tpl, RepoDir: repoDir, Resolver: resolver,
        FileFilter: fileFilter, GitRunner: gitcmd.New(maxGitProcs),
        IsGitRepo: isGit,
    }, nil
}
```

### `resolveWorkingDir`：cwd 锚定到 git toplevel

`shared.go:84` 的细节关键：

- 不带 `--repo` 时默认 `os.Getwd()`。
- **如果 cwd 在 git 仓内**：调 `git rev-parse --show-toplevel` 把 `RepoDir` 锚到仓根。理由（注释 #287）：`git diff`/`git show HEAD:path` 用的是**仓根相对路径**，所以 OCR 也必须以仓根为基准去读文件。否则在 monorepo 子目录跑 `ocr review`，会把 git 的根相对路径当成 cwd 相对路径，找不到文件。
- **如果 cwd 不在 git 仓内且 `requireGit=true`**：报错。`scan` 的 `requireGit=false`，于是 `IsGitRepo=false`，枚举走 `filepath.WalkDir`。

### `resolveWorkingDir` 的副作用：scan 行为

注意 `requireGit` 的语义差异：
- `review` 路径 `requireGit=true`：锚到 toplevel；
- `scan` 路径 `requireGit=false`：保持 CWD，所以 `ocr scan --path internal/agent` 从子目录跑就只扫那个子目录。

## 4.4 LLM 运行时：`loadLLMRuntime`

`shared.go:144` 是 `review`/`scan` 都在调的第二步，但 `delegate` **不调用**它（这就是"委派无 LLM"的代码证据）：

```go
func loadLLMRuntime(tpl *template.Template, toolConfigPath, modelOverride string) (*llmRuntime, error) {
    toolEntries, _ := toolsconfig.Load(toolConfigPath)        // tools.json
    planToolDefs := agent.BuildToolDefs(toolEntries, true)     // plan 阶段可见的工具
    mainToolDefs := agent.BuildToolDefs(toolEntries, false)    // main 阶段可见的工具

    cfgPath, _ := defaultConfigPath()                          // ~/.opencodereview/config.json
    appCfg, _ := LoadAppConfig(cfgPath)
    tpl.ApplyLanguage(langOrDefault)                           // 把"Always respond in <Lang>"补进所有 system

    ep, _ := llm.ResolveEndpointWithModelOverride(cfgPath, modelOverride)
    return &llmRuntime{
        Client: llm.NewLLMClient(ep), Model: ep.Model,
        PlanToolDefs: ..., MainToolDefs: ...,
        Collector: tool.NewCommentCollector(),
        AppCfg: appCfg,
    }, nil
}
```

关键点：
- `BuildToolDefs`（`agent.go:1026`）按 phase filter `tools.json`，把 `definition` 字段反序列化成 `llm.ToolDef`。如果某个工具的 JSON schema 解析失败只 `WARNING` 不退出。
- `--model` 覆盖走 `ResolveEndpointWithModelOverride`。
- `tpl.ApplyLanguage` **就地修改** `tpl`，所以 review/scan 各自持有 template 值副本即可。

## 4.5 `ocr review` 装配链

`review_cmd.go:95 executeReview` 的顺序是 OCR 最重要的初始化序列，附录 C 给了完整 flag。这里只列**装配动作**清单：

1. `loadCommonContext(..., requireGit=true)` —— 五件套。
2. `applyCLIExcludes` —— `--exclude` 追加到 `FileFilter.Exclude`。
3. `validateReviewRefs` —— **安全检查 #112**：`--from/--to/--commit` 的值用 `git rev-parse --verify --end-of-options <ref>^{commit}` 验证，且不允许以 `-` 开头，避免参数注入到 git 子进程。
4. `--commit` 单提交时自动把 commit message 注入 `--background`（`getCommitMessage`）。
5. `--background-file` 解析（相对 `RepoDir`）：合并到 `background` 字符串。
6. `--preview`：直接跑 `runPreview` 返回文件列表，不继续。
7. `loadReviewResumeState` —— 校验 `--resume <id>` 的会话元数据匹配当前 range/commit。
8. `loadLLMRuntime` —— LLM 客户端 + 工具 schema。
9. `buildToolRegistry` —— 注册 5 个内置工具到 `tool.Registry`（`code_comment` 是 `CodeCommentProvider{Collector}`，本身没有 Execute 之外的 IO）：
   ```go
   reg.Register(tool.NewFileRead(fr))
   reg.Register(tool.NewFileFind(fr))
   reg.Register(tool.NewFileReadDiff(tool.DiffMap{}))  // 占位，下面 injectDiffMap 填充
   reg.Register(tool.NewCodeSearch(fr))
   reg.Register(&tool.CodeCommentProvider{Collector: collector})
   ```
10. `initMCPClients` —— 把 config.json 里 `mcp_servers` 全起来，`mcp.RegisterAll` 注入 `tools`，并把 MCP tool defs 追加到 `rt.PlanToolDefs` / `rt.MainToolDefs`。
11. `agent.New(agent.Args{...})` —— 注入所有依赖。
12. 静音 stdout（`newQuietHandle`，json/agent 模式触发）。
13. 起 trace span、记 traceId。
14. `ag.Run(ctx)` —— 进入 `internal/agent`，详见第 6 章。

## 4.6 Provider TUI（bubbletea）

`cmd/opencodereview/provider_tui.go` 实现了 `ocr config provider` 的交互选择器（`provider_tui.go:1` 起的 `tfa-model`）。基于 `charm.land/bubbletea/v2` + `lipgloss/v2`。流程：

```
列出内置 providers (排序) → 用户选 → 列该 provider 的 models → 用户选
→ 提示输入 API key (masked) → "Test connectivity" (跑 testconnection/task.json)
→ 成功则写入 config.json (provider/model/api_key/url)
```

关键细节：
- API key 输入框是 `password` 模式，不回显。
- 测试连通性失败会显示错误但不退出，允许用户修正。
- 写入的 JSON 字段是嵌套的 `providers.<name>.<field>` 或 `custom_providers.<name>.<field>`，由 `setConfigValue` 解析点分路径（`config_cmd.go:349`）。

## 4.7 输出层：`emitRunResult`

`shared.go:276 emitRunResult` 是 `ocr review`/`ocr scan` 共享的终点：接受任何实现了 `ResultProvider` 接口（`shared.go:240`，含 `Diffs/FilesReviewed/TotalTokensUsed/Warnings/ProjectSummary/ToolCalls/SessionID/BudgetExceeded`）的 agent，统一做：

1. `diff.ResolveLineNumbers(comments, ag.Diffs())` —— 对所有 comment 做最后一次行号定位（如果 LLM 主循环里的 `ResolveComment` 已经填了行号，这里会跳过）。
2. 记 telemetry、打印 trace 摘要（agent-text 模式会先 `q.Restore()` 把 stdout 唤醒）。
3. 按 `outputFormat` 走 JSON 或文本。JSON 输出包含 `comments / warnings / files reviewed / token 4 件 / duration / project_summary / tool_calls / trace_id / resume_info / session_id / budget_exceeded` 等字段，是 CI 消费端看到的 schema。

## 4.8 小结：CLI 层的克制

`cmd/` 层刻意保持轻量：不持有 LLM 状态、不做策略决策、不维护会话，只做装配。所有可复用逻辑都被推到 `internal/` 里。这让你做二次开发时，如果想把 OCR 嵌入到自己的 Runner（如内部 CI），可以直接复用 `internal/agent`/`internal/scan` 的导出 API，而不需要 fork CLI 解析逻辑——这是 OCR 设计上对可移植性的诚意。
