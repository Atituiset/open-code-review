# 28. VS Code 扩展

`extensions/vscode/` 是 OCR 的 GUI 前端：**Preact WebView + 薄 Extension Host**，底层仍然是 `ocr` CLI。它把 review 结果渲染成侧边栏卡片 + 原生 CommentThreads。

## 28.1 基本信息

| 项 | 值 |
|----|----|
| name | `open-code-review-vscode` |
| 版本 | 0.1.2 |
| engines.vscode | `^1.74.0` |
| 入口 | `./out/extension.js`（webpack 编译） |
| 激活 | `onStartupFinished` |
| 前端 | Preact 10 + Webpack + ts-loader |
| 打包 | `vsce package` → `.vsix` |
| 本地化 | `package.nls.json` + `package.nls.zh-cn.json` |

## 28.2 功能清单（README）

- **三种审查模式**：workspace（当前改动）/ `--from --to` 分支比较 / `--commit`。
- **文件预览**：审查前列出当前 git 状态的所有改动文件。
- **流式日志 + 取消**：尾部日志跟随，可随时 cancel（`ocr.review.cancel`）。
- **结果渲染**：侧边栏卡片 + 原生 VS Code CommentThread，每条评论可直接 `apply` / `discard` / 标记 `falsePositive`，**双向同步**（改 comment 状态回写）。
- **空/取消/失败状态** + 重试按钮。
- **扩展内配置管理**：`ocr config set` 持久化到 `~/.opencodereview/config.json`。
- **状态栏模型切换 + LLM 连通性测试**。

## 28.3 命令

| command | 说明 |
|---------|------|
| `ocr.review.start` | 发起审查（三种模式） |
| `ocr.review.cancel` | 取消进行中的审查 |
| `ocr.config.open` | 打开扩展配置 |
| `ocr.comment.apply` | 应用评论建议（suggestion_code 替换代码） |
| `ocr.comment.discard` | 丢弃评论 |
| `ocr.comment.falsePositive` | 标记误报 |

菜单：`apply`/`discard` 出现在 `commentController == ocr-review && commentThread == pending` 的评论线程标题栏。

## 28.4 架构

```
src/
├── extension/       ← Extension Host 侧：CLI 子进程管理、git、fs、评论同步
├── webview/         ← Preact SPA：侧边栏 UI
└── shared/          ← postMessage 协议类型定义
```

`apply` 依赖 `internal/suggestdiff` 的思路——评论的 `suggestion_code` 被应用到对应 `existing_code` 位置，生成 diff 预览。

## 28.5 安装

```bash
cd extensions/vscode
npm install
npm run package      # 产出 .vsix
code --install-extension open-code-review-0.1.2.vsix
```

或从 VS Code marketplace 搜索 `open-code-review-vscode`。

## 28.6 坑点

1. **依赖全局 `ocr` CLI**：扩展不内置二进制，必须已 `npm i -g @alibaba-group/open-code-review` 且 `ocr` 在 PATH。`ocr_health` 逻辑会检查。
2. **WebView 与 Extension Host 通信走 postMessage**：调试时注意 vscode devtools 里看 `src/shared` 的消息协议。
3. **评论线程状态回写是单向的**：`falsePositive` 标记只是本地/评论生命周期管理，不反向影响 OCR 的 session JSONL（`discard` 会从当前线程移除，但 JSONL 记录还在）。
4. **锁版本对齐 CLI**：扩展 0.1.2 与 CLI 版本无关，但行为依赖 CLI 输出 schema（`--format json`），升级 CLI 后扩展如异常先看 CLI 单独跑的结果。
5. **自动化测试**：`npm run test` 用 jest 跑 `src` 单测；无 E2E。

## 28.7 何时用

- 本地开发者想"改代码 → 一键 review → 在编辑器里直接看评论并 apply"。
- 适合个人/小团队，不替代 CI（CI 负责守门，IDE 扩展负责开发时自查）。
