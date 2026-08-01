# 31. 从源码构建与发布制品

## 31.1 环境

- Go 1.25.5+（`go.mod`）
- Git ≥ 2.41（运行时依赖）
- 交叉编译无需 CGO（`CGO_ENABLED=0`）

## 31.2 Makefile 目标

| 目标 | 说明 |
|------|------|
| `make build` | 本地构建 `dist/opencodereview` |
| `make test` | 跑全部测试（`-race`，`LC_ALL=C` 防 locale 干扰） |
| `make coverage` | 覆盖率（阈值 80%） |
| `make vet` / `make fmt` / `make check` | 静态检查 |
| `make build-all` | 6 平台交叉编译 |
| `make dist` | clean → build-all → sha256sum |
| `make version-info` | 打印版本注入信息 |

## 31.3 版本注入

`Makefile:17-22`：

```make
LD_FLAGS := \
    -X main.Version=$(VERSION) \
    -X main.GitCommit=$(GIT_COMMIT) \
    -X main.BuildDate=$(BUILD_DATE)
```

`VERSION` = `git describe --tags --abbrev=0`，无 tag 时 `v0.0.0-<sha>`。这三个变量在 `cmd/opencodereview/version.go` 里被读，`llm.AppVersion` 引用它作 User-Agent。

## 31.4 测试情况

`internal/*` 每个包都有配套 `*_test.go`，`Makefile` 的 `PACKAGES` 排除了 `extensions/`。覆盖率门槛 80%（`coverage` target）。

几个值得看的测试（理解设计意图的好材料）：
- `internal/llmloop/runner_test.go` / `compression_test.go`：压缩三区行为。
- `internal/diff/relocation_test.go` / `resolver_test.go`：行号定位。
- `internal/scan/dedup_test.go`：dedup 严格性。
- `internal/agent/coverage_test.go` / `budget_test.go`：预算 gate。
- `internal/config/rules/*_test.go`：规则解析。
- `cmd/opencodereview/*_test.go`：命令装配、输出 schema、git ref 安全。

## 31.5 发布制品矩阵

`make build-all` 产出（`release/asset_naming_test.go` 验证命名）：

| 平台 | 文件名 |
|------|--------|
| linux-amd64 | `opencodereview-linux-amd64` |
| linux-arm64 | `opencodereview-linux-arm64` |
| darwin-amd64 | `opencodereview-darwin-amd64` |
| darwin-arm64 | `opencodereview-darwin-arm64` |
| win32-amd64 | `opencodereview-windows-amd64.exe` |
| win32-arm64 | `opencodereview-windows-arm64.exe` |

`make dist` 再生成 `sha256sum.txt`。

### 三套分发通道

1. **npm**：根 `package.json` 的 `optionalDependencies`（6 个 per-platform 包）+ `bin/ocr.js` + `scripts/install.js` 从 GitHub Releases 下载二进制。`.npmignore` 排除源码只发 wrapper。
2. **GitHub Releases**：release workflow（`.github/workflows/release.yml`）跑 `make dist` 上传二进制 + sha256sum。`install.sh`/`install.ps1` 从这里下载。
3. **官方 Action**：`action.yml` 引用 `@alibaba-group/open-code-review` npm 包（`ocr_version` 可选）。

## 31.6 二次开发注意

1. **`internal/` 是 Go 的 internal 包**：只能被 module 内引用。想复用 OCR 的 diff/agent 逻辑，要么 fork 后在 module 内 import，要么把代码复制出去。
2. **改 prompt 需重编译**：`internal/config/template/prompts/*.md` 是 embed，改完 `make build` 才生效。
3. **加新 tool**：`internal/config/toolsconfig/tools.json` 加 schema → `internal/tool/` 加 Provider → `cmd/opencodereview/shared.go buildToolRegistry` 注册 → `llmloop.executeToolCall` 决定是否特殊处理。
4. **加新 provider**：`internal/llm/providers.go` 的 `registry` 加一条即可（Protocol/BaseURL/AuthHeader/EnvVar/Models）。
5. **测试运行 locale 敏感**：`Makefile` 用 `LC_ALL=C` 是因为有测试断言依赖 C locale 的排序/输出（尤其 `git` 输出）。

## 31.7 版本升级流程（fork 场景）

```bash
git remote add upstream https://github.com/alibaba/open-code-review
git fetch upstream
git merge upstream/main          # 解决冲突主要在 embedded prompts / go.mod
make check && make test
```

升级时最可能冲突的文件：`internal/config/template/prompts/*.md`、`internal/config/template/task_template.json`、`internal/config/rules/system_rules.json`、`go.mod`。
