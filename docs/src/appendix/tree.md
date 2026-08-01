# A. 文件树速查

按"看懂代码从哪里开始"组织的核心文件树（去掉测试与翻译冗余）。

```
open-code-review/
├── cmd/opencodereview/              ★ CLI 入口与装配
│   ├── main.go                      main：ldflags 注入 + telemetry init + rootCmd.Execute
│   ├── root.go                      Cobra root
│   ├── review_cmd.go                ocr review：装配链 + MCP 初始化 + agent 启动
│   ├── scan_cmd.go                  ocr scan：scan 模板 + scan.Agent 启动
│   ├── delegate_cmd.go              ocr delegate preview/rule（无 LLM）
│   ├── session_cmd.go               ocr session list/show/remove
│   ├── viewer_cmd.go                ocr viewer
│   ├── config_cmd.go                ocr config set/get（~/.opencodereview/config.json）
│   ├── provider_cmd.go / provider_tui.go   ocr config provider（bubbletea TUI）
│   ├── llm_cmd.go                   ocr llm test（连通性）
│   ├── rules_cmd.go                 ocr rules check
│   ├── shared.go                    loadCommonContext / loadLLMRuntime / emitRunResult
│   ├── shared_flags.go              公共 flag 注册
│   └── version.go                   Version/GitCommit/BuildDate

├── internal/
│   ├── agent/                       ★ diff-review 编排
│   │   ├── agent.go                 Agent.Run / dispatchSubtasks / executeSubtask / review_filter
│   │   ├── preview.go               --preview 文件列表
│   │   └── estimate.go              token 成本估算
│   ├── scan/                        ★ 全文件审查
│   │   ├── agent.go                 ScanAgent.Run / batch dispatch / dedup / summary
│   │   ├── provider.go              文件枚举（git ls-files / WalkDir）
│   │   ├── batch.go                 by-language / by-directory 分组
│   │   ├── estimate.go / preview.go
│   ├── llmloop/                     ★★ 共享 LLM 工具循环（核心）
│   │   ├── loop.go                  Runner.RunPerFile / executeToolCall / addNextMessage
│   │   ├── compression.go           三区上下文压缩
│   │   └── pool.go                  CommentWorkerPool（code_comment 异步）
│   ├── llm/                         ★ LLM 客户端抽象
│   │   ├── client.go                LLMClient 接口 + OpenAI/Anthropic client + tiktoken
│   │   ├── responses_client.go      OpenAI Responses API
│   │   ├── resolver.go              endpoint 四策略解析
│   │   ├── providers.go             18 个内置 provider
│   │   ├── protocol.go              anthropic/openai/openai-responses
│   │   └── embedded_loader.go       BPE 词表内嵌
│   ├── tool/                        ★ 六件套工具 + 注册表
│   │   ├── definitions.go           Tool / Provider / Registry
│   │   ├── code_comment.go          code_comment 解析
│   │   ├── file_read.go / filereader.go   file_read
│   │   ├── code_search.go           code_search
│   │   ├── file_read_diff.go        file_read_diff
│   │   ├── file_find.go             file_find
│   │   ├── comment_collector.go     线程安全评论收集
│   │   └── response_message.go      工具结果 → LLM 消息
│   ├── diff/                        ★ diff 解析 + 行号定位
│   │   ├── git.go                   Provider（workspace/commit/range）
│   │   ├── parser.go                ParseDiffText
│   │   ├── hunk.go                  Hunk 结构
│   │   ├── resolver.go              ResolveComment / ResolveLineNumbers
│   │   ├── relocation.go            ReLocateComment（LLM 重定位）
│   │   ├── gitignore.go / workspace_file.go
│   ├── delegate/                    ★ 委派模式
│   │   ├── rulegroup.go             GroupRules（按 source|pattern|text 分组）
│   │   └── format.go                RuleGroupsMarkdown
│   ├── session/                     ★ 会话持久化 + 续审
│   │   ├── persist.go               jsonlWriter
│   │   ├── history.go               SessionHistory
│   │   ├── resume.go                ResumeState（fingerprint 索引）
│   │   └── list.go                  session list/show/remove
│   ├── config/
│   │   ├── rules/                   system_rules.go + system_rules.json + rule_docs/*.md
│   │   ├── allowlist/               allowed_ext.go + supported_file_types.json + default_exclude_patterns.json
│   │   ├── template/                template.go + task_template.json + scan_template.json
│   │   │   └── prompts/*.md         10 个 diff-review prompt
│   │   ├── toolsconfig/             tools.json + toolsconfig.go
│   │   └── testconnection/          task.json（ocr llm test 用）
│   ├── mcp/                         MCP 客户端（stdio/remote）+ RegisterAll
│   ├── viewer/                      viewer Web 服务 + hostguard
│   ├── telemetry/                   OTel（config/provider/exporter/metrics/span/events/shutdown）
│   ├── gitcmd/                       git 子进程并发限流器
│   ├── model/                       Diff / LlmComment / ScanItem / ExcludeReason
│   ├── pathutil/  stdout/  suggestdiff/  release/   辅助

├── examples/                        ★ CI 集成示例
│   ├── github_actions/  gitlab_ci/  bitbucket_pipelines/
│   ├── gerrit_ci/  gitflic_ci/  codeup_ci/
├── plugins/open-code-review/        ★ 编程代理插件
│   ├── claude-code/  .codex-plugin/  .cursor-plugin/
│   ├── skills/  opencode/
├── extensions/vscode/               ★ VS Code 扩展（Preact WebView + CLI）
├── pages/                           官方文档站（React/Webpack，非 Astro）
├── scripts/                         install.js / update.js / github-actions/post-review-comments.js
├── npm/<platform>/                  6 个 per-platform 包
├── action.yml                       ★ GitHub Action（composite）
├── install.sh / install.ps1         独立安装脚本
├── Makefile                         构建/测试/交叉编译
└── skills/                          根级 SKILL 副本（与 plugins 同步）
```

## 阅读顺序建议

1. `internal/llmloop/loop.go`（核心循环）
2. `internal/agent/agent.go`（diff-review 编排）
3. `internal/llm/client.go`（协议抽象）
4. `internal/diff/resolver.go`（行号定位）
5. `internal/config/template/prompts/main_task_user.md`（prompt）
6. `cmd/opencodereview/review_cmd.go`（装配链）
