# 18. 辅助包：gitcmd / model / pathutil / stdout / suggestdiff / release

这些小包构成 OCR 的地基工具层。逐个过一遍，然后你就会发现它们都很小、很专一——这也是 Go 项目该有的样子。

## 18.1 `internal/gitcmd` — git 子进程并发限流器

`runner.go` 是整个 OCR 唯一的 git 子进程通道。核心：

```go
const defaultMaxConcurrent = 16

type Runner struct { sem chan struct{} }

func New(maxConcurrent int) *Runner  // <=0 → 16

func (r *Runner) Run(ctx, repoDir, args...) (string, error)          // stdout+stderr 合并
func (r *Runner) Output(ctx, repoDir, args...) ([]byte, error)       // stdout only
func (r *Runner) RunSplit(ctx, repoDir, args...) (stdout, stderr string, err error)
func (r *Runner) Stream(ctx, repoDir, consume func(io.Reader) error, args...) error
```

三个函数全部经过 `acquire(ctx)` 信号量（最多 16 个并发 git 进程），避免 `code_search` 的 `git grep` 和 `file_read_diff` 等同时炸机器。

`Stream` 的注意点：`consume` 必须**完整 drain** stdout reader，否则 `cmd.Wait()` 会 block 或 broken pipe（`runner.go:88` 注释）。

## 18.2 `internal/model` — 领域模型

纯数据定义，无逻辑。四个文件：

- `diff.go`：`Diff`（OldPath/NewPath/Diff/NewFileContent/Insertions/Deletions/IsNew/IsDeleted/IsRenamed/IsBinary）+ `Hunk`/`HunkLine`。
- `review.go`：`LlmComment`（Path/Content/ExistingCode/SuggestionCode/Thinking/Category/Severity/StartLine/EndLine）+ `ExcludeReason` enum + `ReviewMode`。
- `scan.go`：`ScanItem`（Path/Content/IsBinary/LineCount）+ `AsDiff()` 合成 Diff 方法。
- `preview.go`：`DiffPreview` / `ScanPreview`。

`ExcludeReason` 枚举值：`ExcludeNone / ExcludeUserRule / ExcludeExtension / ExcludeDefaultPath / ExcludeBinary`。

## 18.3 `internal/pathutil` — 跨平台路径

`path.go` 提供跨平台路径处理工具（Windows/Linux 分离符统一、相对转绝对、路径合法性校验）。被 `scan/provider.go` 和 `diff` 等使用，处理 `\`/`/` 差异。

## 18.4 `internal/stdout` — stdout 静音开关

`stdout.go` 提供全局 stdout 门控，让 `--audience agent` / `--format json` 时能把 `[ocr] ...` 进度行静音：

```go
func Quiet() func()   // 全局静音，返回恢复函数（幂等）
func Writer() io.Writer // 静音时返回 io.Discard，否则 os.Stdout
```

`cmd/opencodereview/shared.go:220 newQuietHandle` 包了一层"Restore 幂等"的句柄，确保 defer 安全。

这是 OCR "human 有进度条，agent 只要干净 JSON" 的关键实现——所有 `fmt.Fprintf(stdout.Writer(), ...)` 的进度行都走它。

## 18.5 `internal/suggestdiff` — suggestion 渲染

`diff.go` 实现：把 `LlmComment.SuggestionCode`（新代码片段）和 `ExistingCode` 渲染成标准的 unified diff hunk，用于 GitHub/Gerrit 等平台展示 "suggested change" 时保持格式。测试很全（`diff_test.go`）。

它把评论的"现有代码 → 建议代码"转成一个可贴进 diff review 的代码块。VS Code 扩展的 `ocr.comment.apply` 也依赖它做代码替换预览。

## 18.6 `internal/release` — 发布资产命名

`asset_naming_test.go` 验证跨平台二进制命名（`opencodereview-linux-amd64` / `-darwin-arm64` / `-windows-amd64.exe`...）的一致性，与 Makefile 的 `build-all` 和 npm per-platform 包、`install.sh`/`install.ps1` 的下载路径对齐。

## 18.7 `internal/delegate/format.go`

（第 11 章已讲）`RuleGroupsMarkdown` 渲染 delegate 模式的分组规则文本。

## 18.8 小结

这些辅助包都很薄，但每一个都体现了"小而专"的原则：

- `gitcmd` 用信号量保护 git 进程；
- `model` 让上层不依赖 proto/struct 细节；
- `stdout` 让输出层可静音；
- `suggestdiff` 让建议代码能进 diff 平台；
- `release` 保证跨平台命名不漂移。

它们加起来构成了 OCR 可以被"二次开发复用"的地基——你如果想在自己的工具链里用 OCR 的 diff 解析或 git 限流器，直接 import 这些 internal 包就行（Go 的 internal 约束：只能在 module 内用，但 OCR 已开源，你可以 fork）。
