# 序言

> 本文档基于 `alibaba/open-code-review`（简称 **OCR**，CLI 名为 `ocr`）源码仓做的深度解读，目标是同时回答两类问题：
>
> 1. **源码级**：这套工具到底是怎么实现的？数据流从入口到出口走了哪些包/函数？关键技术决策（确定性工程 × Agent 混合、三区上下文压缩、行号重定位等）是怎么落地的？
> 2. **落地级**：在生产/CI/IDE 中怎么用？引入步骤、配置项、踩过的坑、性能成本怎么算？

本文档用 [mdBook](https://rust-lang.github.io/mdBook/) 管理，源在 `docs/src/`，构建产物在 `docs/book/`。所有源码引用均带 `路径:行号` 形式（如 `internal/agent/agent.go:195`），可直接跳转。

## 仓的基本信息

| 项目 | 值 |
|------|------|
| 上游仓库 | <https://github.com/alibaba/open-code-review> |
| 作者 | Alibaba Group（内部孵化两年后开源） |
| 语言 | Go 1.25.5（主程序）+ TypeScript（VS Code 扩展 / OpenCode 插件 / 文档站） |
| 协议 | Apache-2.0 |
| 发版 | npm `@alibaba-group/open-code-review` + GitHub Releases 二进制 + GH Action + VS Code 扩展 |
| 主入口 | `cmd/opencodereview/main.go` → `cmd/opencodereview/root.go` |

## 这份解读不重复官方文档

`pages/` 子目录里已经有一份官方 Astro/React 英日中三语文档站（`open-codereview.ai/docs`），主要面向"怎么用"。本文档聚焦**怎么实现 + 怎么稳落地**，与官方文档互补，不重叠。

## 阅读建议

- **只想快速接入**：跳到第四部分落地指南，按 *安装 → 配置 LLM → 第一次审查* 三步走。
- **想理解架构再决定深度定制**：先读第 2 章架构总览，再按需挑第二部分章节。
- **要在 CI 里大规模铺**：第 26 章 + 第 32~34 章的坑点必读。
- **要做二次开发 / 贡献上游**：第二部分全读，并配合 `CONTRIBUTING.md`。

## 版本与时效

本文档截稿时上游 `main` 在 `80a5794`（Cobra 迁移后），Go 1.25.5，依赖 OpenAI SDK v3、Anthropic SDK v1.55、tiktoken-go、modelcontextprotocol/go-sdk。后续若上游结构变化，部分 `file:line` 锚点可能漂移，但架构与数据流的叙述仍然有效。
