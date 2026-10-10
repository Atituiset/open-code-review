---
layout: home

hero:
  name: Open Code Review
  text: 源码级解读
  tagline: 对 alibaba/open-code-review 仓的深度源码解读与落地指南——从架构总览、internal 包逐包剖析，到端到端时序追踪、部署落地与坑点最佳实践
  actions:
    - theme: brand
      text: 开始阅读
      link: /preface
    - theme: alt
      text: 阅读路径
      link: /reading-path

features:
  - title: 一 概览
    details: 项目定位与设计哲学、顶层架构总览、核心概念词典。
    link: /overview/project
  - title: 二 源码级深度剖析
    details: CLI、LLM 客户端、Agent 编排、llmloop、Tool、diff、scan、session、prompt 模板等 15 个 internal 包的源码解剖。
    link: /source/cli
  - title: 三 端到端流程追踪
    details: ocr review / ocr scan / 委派模式三条全链路时序，逐帧还原一次审查的完整生命周期。
    link: /flow/review-trace
  - title: 四 落地指南
    details: 安装选型、LLM 提供商配置、CI/CD 与编程代理集成、VS Code 扩展、可观测性接入、源码构建。
    link: /deployment/install
  - title: 五 坑点与最佳实践
    details: 常见踩坑清单、性能与成本调优配方、安全注意事项、调试与排障手册。
    link: /pitfalls/checklist
  - title: 附录
    details: 文件树速查、环境变量与 CLI 标志总览、术语表、benchmark 外部核查时间线。
    link: /appendix/tree
---
