# 27. 编程代理集成（Claude Code / Codex / Cursor / OpenCode）

OCR 除了 CLI 和 CI，还有 4 个编程代理的插件：**Claude Code / Codex / Cursor / OpenCode**。它们的共同点：把 `ocr review` 变成 IDE 里可调用的 slash command / skill / tool。这在"让开发者审自己的分支"场景特别有用。

## 27.1 总览

`plugins/open-code-review/` 目录结构：

```
plugins/open-code-review/
├── README.md                     ← 四种集成的统一说明
├── claude-code/
│   ├── .claude-plugin/plugin.json
│   └── commands/
│       ├── review.md             ← /open-code-review:review
│       └── delegate-review.md    ← /open-code-review:delegate-review
├── .codex-plugin/plugin.json     ← Codex 市场
├── .cursor-plugin/plugin.json    ← Cursor 本地插件
├── skills/
│   ├── open-code-review/SKILL.md        ← 审查 skill（OCR-managed）
│   └── open-code-review-delegate/SKILL.md ← 委派 skill
└── opencode/
    ├── open-code-review.ts        ← OpenCode 原生插件
    └── ...
```

另外仓根的 `skills/` 有同内容的两份 SKILL.md（与 plugins 副本同步，改一边要同步另一边——源码注释也提醒了）。

## 27.2 前置条件（四种通用）

- Git ≥ 2.41
- `ocr` CLI 已装（`npm i -g @alibaba-group/open-code-review`）
- LLM 已配好（`ocr config provider` / `ocr llm test`）——**除非**用委派模式（delegate）

## 27.3 Claude Code 插件

安装：

```
/plugin marketplace add alibaba/open-code-review
/plugin install open-code-review@open-code-review
```

两个 slash command：

- `/open-code-review:review`：跑 `ocr review --audience agent`，然后按 High/Medium/Low 置信度过滤评论，High 的直接自动修。
- `/open-code-review:delegate-review`：`ocr delegate preview` → `ocr delegate rule` → `git diff` → 宿主 Claude 自己审。

## 27.4 Codex / Cursor 插件（SKILL 驱动）

- **Codex**：`.codex-plugin/plugin.json` 市场安装，`interface.capabilities: ["Read"]`，暴露 `skills/open-code-review/SKILL.md`。调用：`@Open Code Review review my current changes`。
- **Cursor**：手动复制整个 `plugins/open-code-review/` 到 `~/.cursor/plugins/local/open-code-review/`（manifest 在 `.cursor-plugin/plugin.json`）。

### SKILL.md 内容精华（`skills/open-code-review/SKILL.md`）

- 前置：`ocr llm test`。
- 工作流：Gather Business Context → `ocr review --audience agent --background <context>` → 按 High/Medium/Low 分级 → Fix。
- 常见调用表：`--commit`、`--from/--to`、`--background`、`--background-file`、`--preview`。
- **Gotchas 明确列出**：
  - LLM 必须配置；
  - 工作目录必须是 git 仓根（OCR 锚定 toplevel）；
  - workspace 模式包含未跟踪文件；
  - MAX_TOKENS=58888；
  - 变更 ≥50 行才触发 plan phase；
  - 默认并发 8 worker；
  - **never pass `--audience human`**（给 agent 用要 `--audience agent`）。

## 27.5 OpenCode 插件

`plugins/open-code-review/opencode/open-code-review.ts`（11 KB TypeScript）暴露两个原生工具 + 两个 slash command：

| 工具/命令 | 说明 |
|-----------|------|
| `ocr_review` | 跑 review，返回结构化 JSON（`--audience agent`，15 分钟超时，10 MiB 输出上限） |
| `ocr_health` | 显示版本 + 测试 LLM 连通性 |
| `/ocr-review` | slash command 包装 |
| `/ocr-health` | slash command 包装 |

安装：全局 `~/.config/opencode/plugins/` 或项目 `.opencode/plugins/`。

关键实现：工具调用用 `shell:false` 参数防止 shell 注入，带超时和输出上限，工具取消时 kill 进程（`process cancellation on tool cancel`）。

## 27.6 两种 LLM 执行模型回顾

| | OCR-managed（默认） | 委派模式 |
|--|-------------------|---------|
| 谁调 LLM | `ocr`（用 OCR 配的 LLM） | 宿主 Agent（用 Agent 自己的 LLM） |
| 配置需求 | `ocr config provider` | 不需要 OCR LLM key |
| 命令 | `ocr review` | `ocr delegate preview/rule` + 宿主审 |
| 评论质量 | 固定 prompt 调优过 | 依赖宿主 Agent 的 prompt |
| 适用 | 想统一审查标准 | 想用自己的 Agent 深度联动 |

## 27.7 坑点

1. **agent 模式下别用 `--audience human`**：SKILL 明确警告，human 模式会把进度行混进 JSON 之外的消息，破坏结构化输出。
2. **目录必须是 git 仓根**：OCR 锚定 toplevel，在子目录跑 review 会基于仓根解析（monorepo 子目录项目规则文件读不到，见 25.9）。
3. **workspace 模式含未跟踪文件**：审查"未提交"时，未跟踪文件也在范围内（`git ls-files --others`）。
4. **Agent 自动修 High 评论的边界**：SKILL 建议 High 置信度自动修，但这是 Agent 行为，不是 OCR 保证——需人工 review Agent 的 patch。
5. **插件与 skills 双份同步**：改 `plugins/open-code-review/skills/` 记得同步根 `skills/`，反之亦然。
