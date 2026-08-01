# Summary

- [序言](./preface.md)

# 第一部分 — 概览

- [1. 项目定位与设计哲学](./overview/project.md)
- [2. 顶层架构总览](./overview/architecture.md)
- [3. 核心概念词典](./overview/concepts.md)

# 第二部分 — 源码级深度剖析

- [4. CLI 层与命令树](./source/cli.md)
- [5. LLM 客户端与多协议抽象](./source/llm.md)
- [6. Agent 编排层 (diff-review)](./source/agent.md)
- [7. llmloop：LLM 工具调用循环与上下文压缩](./source/llmloop.md)
- [8. Tool：六件套工具体系](./source/tools.md)
- [9. diff：Git diff 解析、行号定位与重定位](./source/diff.md)
- [10. scan：全文件审查管线](./source/scan.md)
- [11. delegate：委派模式 (无 LLM)](./source/delegate.md)
- [12. session：会话持久化与断点续审](./source/session.md)
- [13. config & rules：配置体系与规则匹配](./source/config-rules.md)
- [14. prompt 模板：提示词工程内幕](./source/prompts.md)
- [15. MCP 客户端扩展](./source/mcp.md)
- [16. viewer：会话回看 Web 服务](./source/viewer.md)
- [17. telemetry：OpenTelemetry 可观测性](./source/telemetry.md)
- [18. 辅助包：gitcmd / model / pathutil / stdout / suggestdiff / release](./source/auxiliary.md)

# 第三部分 — 端到端流程追踪

- [19. `ocr review --from A --to B` 全链路时序](./flow/review-trace.md)
- [20. `ocr scan` 全链路时序](./flow/scan-trace.md)
- [21. 委派模式三步走时序](./flow/delegate-trace.md)

# 第四部分 — 落地指南

- [22. 安装方法与选型](./deployment/install.md)
- [23. 配置 LLM 提供商](./deployment/config-llm.md)
- [24. 第一次审查](./deployment/quickstart.md)
- [25. 自定义审查规则](./deployment/custom-rules.md)
- [26. CI/CD 集成（GitHub Actions / GitLab / Gerrit 等）](./deployment/cicd.md)
- [27. 编程代理集成（Claude Code / Codex / Cursor / OpenCode）](./deployment/agents.md)
- [28. VS Code 扩展](./deployment/vscode.md)
- [29. Session Viewer 与断点续审](./deployment/viewer-resume.md)
- [30. 可观测性接入](./deployment/telemetry.md)
- [31. 从源码构建与发布制品](./deployment/build.md)

# 第五部分 — 坑点与最佳实践

- [32. 常见踩坑清单](./pitfalls/checklist.md)
- [33. 性能与成本调优配方](./pitfalls/tuning.md)
- [34. 安全注意事项](./pitfalls/security.md)
- [35. 调试与排障手册](./pitfalls/debug.md)

# 附录

- [A. 文件树速查](./appendix/tree.md)
- [B. 环境变量总览](./appendix/env-vars.md)
- [C. CLI 标志总览](./appendix/flags.md)
- [D. 术语表](./appendix/glossary.md)
