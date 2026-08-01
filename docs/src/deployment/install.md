# 22. 安装方法与选型

## 22.1 前置条件

- **Git ≥ 2.41**：OCR 依赖 git 的 diff / search / ref 操作，版本过老会导致某些 flag（如 `--end-of-options`）行为异常。
- 一个可用的 LLM endpoint（delegate 模式除外）。

## 22.2 四种安装方式对比

| 方式 | 命令 | 适用 | 注意 |
|------|------|------|------|
| npm 全局 | `npm install -g @alibaba-group/open-code-review` | 主力，团队统一 | 依赖 Node ≥14（仅安装期需要，运行时用 Go 二进制） |
| install.sh | `curl -fsSL https://raw.githubusercontent.com/alibaba/open-code-review/main/install.sh \| sh` | Linux/macOS 无 Node 环境 | `sudo` 需要 |
| install.ps1 | `irm https://raw.githubusercontent.com/alibaba/open-code-review/main/install.ps1 \| iex` | Windows | PowerShell 5.1+ |
| 源码编译 | `go build ./cmd/opencodereview` | 开发者/想改源码 | 需 Go 1.25+ |

### npm 安装的内部机制（源码解读）

根 `package.json`：

```json
{
  "name": "@alibaba-group/open-code-review",
  "bin": { "ocr": "bin/ocr.js" },
  "optionalDependencies": {
    "@alibaba-group/ocr-darwin-arm64": "0.0.0",
    "@alibaba-group/ocr-linux-x64": "0.0.0",
    ...
  },
  "scripts": { "postinstall": "node scripts/install.js" }
}
```

- `postinstall` 的 `scripts/install.js` 从 GitHub Releases 下载当前平台的二进制（`ocrConfig.urlPattern`，带 SHA256 校验）。
- 每平台独立 optionalDependency 让 npm 只装当前 OS/arch 的包。
- `bin/ocr.js` 是薄包装：找到二进制 → 检查 `~/.opencodereview/update-available` 提示升级 → 默认 18 分钟一次后台检查更新（`OCR_NO_UPDATE=1` 关）→ `spawnSync` 执行。

**坑**：npm 安装后如果 `ocr: command not found`，多半是 optionalDependencies 安装失败（公司镜像过滤）。看 `npm config get optional`，用 `npm i -g @alibaba-group/open-code-review --no-optional=false`，或直接改走 install.sh。

## 22.3 版本策略

- `@latest` 是滚动版，行为可能随大版本变化。
- CI 里建议**锁版本**：`npm install -g @alibaba-group/open-code-review@1.7.12`（或你想用的版本）。GitHub Action 有 `ocr_version` input。
- 查看当前版本：`ocr --version`。

## 22.4 验证安装

```bash
ocr --version       # 版本信息
ocr --help          # 命令列表
```

### 连通性自检

```bash
ocr config provider   # 交互式配 LLM（会做连通性测试）
# 或直接：
ocr llm test          # 跑 testconnection/task.json 的一个最小对话
```

`ocr llm test` 会解析你的 endpoint 配置，发一条"One sentence to answer who you are."，期待模型正常回复——这是排查"为什么 review 报 LLM error"最快的一步。

## 22.5 选择建议

| 你的场景 | 推荐 |
|----------|------|
| 本地 Mac/Linux 个人用 | npm 全局 或 install.sh |
| 团队 CI | npm 全局 + 锁版本 + GitHub Action/GitLab 模板 |
| Windows 开发者 | install.ps1 或 npm |
| 想二次开发 | 源码编译 + `make build` |
| 无 Node 的容器 | install.sh / 直接 COPY release 二进制 |
| 隔离网环境 | 预下载二进制 + SHA256 校验，放进 base image，禁用 OCR 更新检查（`OCR_NO_UPDATE=1`） |
