# 9. diff：Git diff 解析、行号定位与重定位

`internal/diff/` 是 OCR 的"必备基础设施"：解析 git diff 文本、定位代码评论在 diff 里的行号、兜底重定位、gitignore 处理、工作树读取。它是源码级和落地级都极重要的一个包，因为它直接决定了——**用户拿到的评论能不能挂在对的代码行上**。

## 9.1 文件清单

| 文件 | 职责 |
|------|------|
| `git.go` | `Provider`：获取 workspace/commit/range 三种 diff 的 git 子进程调用 |
| `parser.go` | `ParseDiffText`：把 unified diff 文本切成 `[]model.Diff` |
| `hunk.go` | `ParseHunks` / `Hunk` / `HunkLine`：单文件 diff 的 hunk 结构 |
| `resolver.go` | `ResolveComment` / `ResolveLineNumbers`：行号匹配 |
| `relocation.go` | `ReLocateComment`：当匹配失败时调 LLM 重新生成 existing_code |
| `gitignore.go` | 加载 / 应用 `.gitignore` + 内置 ExcludedDirs 黑名单 |
| `workspace_file.go` | 读工作树文件（带安全限制） |

## 9.2 git diff 来源：`Provider`

`git.go` 三种构造：

```go
func NewWorkspaceProvider(repoDir, runner) *Provider  // git diff HEAD + untracked
func NewCommitProvider(repoDir, commit, runner) *Provider
func NewProvider(repoDir, from, to, runner) *Provider // merge-base(from,to)..to
```

各自对应的 git 命令（`git.go:110 GetDiff`）：

| 模式 | git 命令 |
|------|---------|
| workspace | `git diff HEAD --find-renames -U3 --` + `git ls-files --others --exclude-standard`（未跟踪合并进来） |
| commit | `git show --find-renames -U3 <commit>` |
| range | `git diff -U3 --find-renames mergeBase <to> --` |

公共 flag：`--no-ext-diff`（禁外部 diff 驱动，避免 tokenizable），`--no-textconv`（不下二进制），`--src-prefix=a/ --dst-prefix=b/`（保证 diff 头格式统一），`--no-color`，`-U3`（3 行上下文，`DiffContextLines=18`）。

`--end-of-options` 在每个 ref 前用，是 #112 安全修复的一部分——避免 ref 像 `--upload-pack=...` 一样被解释成选项。

### 9.2.1 `parse.go`：手工解析 unified diff

`parser.go:30 ParseDiffText` 是一个状态机扫行：

- 识别 `diff --git a/x b/y` 头 → 前一个 diff flush
- `@@` → `inHunk=true`
- `inHunk` 下 `+` → `insertions++`，`-` → `deletions++`（注意 `++i` 这种内容行被错看成 `+++i` 头部仍按行计，靠 `inHunk` 守门）
- `new file mode` / `deleted file mode` → `IsNew` / `IsDeleted`
- `rename from/to` → `OldPath` / `NewPath` 修正（含空格路径更可靠）
- `Binary files ... differ` → `IsBinary=true`

`finalizeDiff` 用 `os.ReadFile(repoDir newPath)` 或 `git show ref:newPath` 取**新文件全文**存进 `Diff.NewFileContent`——这是行号 fallback 定位的弹药。

### 9.2.2 内置忽略目录

`git.go:21 providerDirIgnoreDirs`：

```
.idea/ .vscode/ .svn/ .git/ vendor/ node_modules/
target/ .happypack/ .cachefile/ _packages/ rpm/ pkgs/
```

不管 gitignore，这些目录的 diff 一律被剥离。这是 Jessica Alba 在 Alibaba 内部看到 N 次大仓库浪费 LLM token 后加的硬黑名单。

## 9.3 行号定位：双层回退

`resolver.go` 是 OCR "评论不飘"的核心。两条路径：

### 9.3.1 `resolveFromHunk`：从 diff 匹配（首选）

`resolver.go:82`：

1. `ParseHunks(d.Diff)` 拆 hunk；
2. `splitAndNormalize(cm.ExistingCode)` 把 LLM 给的 `existing_code` 拆行+清洗（去 `+`/`-` 前缀、去空白）；
3. `extractSideLines(hunk, newSide=true)`：抽 hunk 里**新侧**（context+added 行带新文件行号）；
4. `matchConsecutive(sideLines, targetLines)`：滑窗找连续匹配；
5. 失败再试 `newSide=false` 老 side（context+deleted + 老文件行号）。

### 9.3.2 `resolveFromFileContent`：从全文件扫（fallback）

`resolver.go:169`：

1. 逐行 normalize `d.NewFileContent`，跳空；
2. 滑窗找 `existing_code` 在新文件**全文**里连续匹配；
3. 首命中→ `cm.StartLine = fileLineNums[i]`、`cm.EndLine = fileLineNums[i+L-1]`。

这一路径处理"diff hunk 上下文不够展示 comment 指向的代码"的场景——比如 LLM 引用了不在 hunk 3 行上下文里但属于新文件的代码。

### 9.3.3 `ResolveComment` 在 llmloop 中的作用

每条 `code_comment` 调用触发一次 `diff.ResolveComment(cm, d)`（`llmloop.go:375`）。如果两条路径都不命中：

- 配置了 `ReLocationTask` → 触发 `ReLocateComment`（下一节）
- 否则 `cm` 没有 `StartLine/EndLine`，在 `emitRunResult` 里的 `ResolveLineNumbers` 还会再试一次（如果 diff 没动过），但基本会以 0 行号返回——可能被前端 UI 弃或标"line N/A"

## 9.4 重定位：LLM 救场

`relocation.go:ReLocateComment` 是 OCR "工程不行就让 LLM 救"模式的一个清晰示范。流程：

```go
func ReLocateComment(ctx, cm, d, client, task, modelName, maxTokens):
    if task == nil || len(task.Messages) == 0 { return false, nil, nil }

    // 渲染 re_location_task 的 prompt，占位符单 {} 而非 {{}}
    for _, m := range task.Messages {
        content = strings.ReplaceAll(content, "{diff}", d.Diff)
        content = strings.ReplaceAll(content, "{existing_code}", cm.ExistingCode)
        content = strings.ReplaceAll(content, "{suggestion_content}", cm.Content)
        messages = append(messages, ...)
    }

    resp, err := client.CompletionsWithWat(...)
    code := extractCodeBlock(resp.Content())       // 抽 ```...``` 第一个 fence

    if code == "" { return false, resp, messages }
    original := cm.ExistingCode
    cm.ExistingCode = code                          // 用 LLM 给的新 snippet 重试
    if ResolveComment(cm, d) { return true, resp, messages }
    cm.ExistingCode = original                      // 还原，避免污染
    return false, resp, messages
```

prompt 的精髓（见第 14 章 `re_location_task_system.md`）：

> "Given a unified diff and a review comment's `existing_code`, find the lines in the diff that the comment refers to. Output only a fenced code block containing the snippet."

整个调用是**单轮** LLM 完成（不在 agent loop 里），失败时 **`cm.ExistingCode` 还原**——这是 OCR 工程化的克制：宁愿要错位置的评论，也不要把模型瞎写的 snippet 永久污染 LlmComment。

## 9.5 `ResolveLineNumbers`：终极兜底

`resolver.go:12` 在 `emitRunResult` 末尾再跑一次全文扫描，覆盖两种情况：

1. LLM 在多轮里多次 code_comment 写了同一评论但 cm.StartLine 没被填（评论池有时会重 dup）；
2. scan 模式下 `d.Diff` 为空（合成 Diff 只有 NewFileContent），fallback 路径生效，行号靠 `resolveFromFileContent` 全文扫出来。

> **scan 模式怎么定位行号**：`scan.Agent.lookupDiff(path) → *AsDiff()` 返回一个合成 Diff，`NewFileContent = it.Content`（整文件内容），`Diff = ""`。`resolveFromHunk` 因 `ParseHunks("")` 返回空而失败，**自动走** `resolveFromFileContent` 在全文件里滑窗找 LLM 给的 `existing_code`。这是 `DiffLookup` 抽象跨 diff-review / full-scan 的精妙之处（`internal/scan/agent.go:275`）。

## 9.6 `gitignore.go`

加载 `.gitignore`：

- 文件存在性优先，pattern 解析支持 `!` 否定、目录前缀、相对路径。
- 加上内置 ExcludedDirs 黑名单（同 `git.go`）。
- review 路径用得不多（git diff 自带 gitignore 语义）；scan 路径 `listFilesViaWalk` 依赖它来过滤非 git 目录。

## 9.7 `workspace_file.go`

`readWorkspaceFileForDiff(repoDir, newPath)` 把路径做：

- `filepath.Join` + `filepath.Clean`
- 防 `..` 路径穿越（`filepath.Rel` 后必须不返回 `..`）
- 实际读：
  - 如果文件已被 `git status` 探测到是 working copy 改动 → 读 work tree
  - 其它情况走 `git show HEAD:path`

这个细节是为了避免 workspace 模式下读到 stash/未 stage 但 staged 之外的"中间态"——OCR 拿到的就是用户当前真正能看到的代码。

## 9.8 小结：行号工程的层次

把行号定位这条链画一下：

```
LLM 给 existing_code
     │
     ▼
A. ResolveComment (resolveFromHunk)
     │ 命中? → done
     ▼ 否
B. resolveFromFileContent (全文扫)
     │ 命中? → done
     ▼ 否
C. ReLocateComment (调 LLM 重新生成 existing_code)
     │  过程里再跑一次 A+B
     │  命中? → done
     ▼ 否
D. emitRunResult.ResolveLineNumbers (终极兜底)
     │  对所有没行号的 cm 再跑一次 A+B
     │  命中? → done
     ▼
最终没命中 → cm.StartLine=0，前端弃
```

四层防御，是 OCR "评论不飘"的工程内功。每一层都克制：

- A/B 不调 LLM 省钱；
- C 还原 `existing_code` 不污染；
- D 是兜底但只用于 fallback。这套机制让大部分定位都在 token-free 的算法层完成，少数难例才用 LLM 补救。
