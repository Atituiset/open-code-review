import { defineConfig } from 'vitepress'

const base = '/open-code-review/'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  lang: 'zh-CN',
  title: 'Open Code Review 源码级解读',
  titleTemplate: '对 alibaba/open-code-review 仓的深度源码解读与落地指南',
  description:
    '对 alibaba/open-code-review 仓的深度源码解读与落地指南：从项目定位与架构总览，到 CLI/Agent/llmloop/Tool/diff/scan 等 internal 包的源码级剖析、端到端流程追踪、部署落地与坑点最佳实践。',

  base,
  lastUpdated: true,
  cleanUrls: true,
  srcExclude: ['README.md'],

  markdown: {
    // shiki 3.x 不再内置 cuda 语法, 用 cpp 高亮兜底
    languageAlias: { cuda: 'cpp' },
  },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['meta', { name: 'theme-color', content: '#2e7d5b', media: '(prefers-color-scheme: light)' }],
    ['meta', { name: 'theme-color', content: '#18191c', media: '(prefers-color-scheme: dark)' }],
    ['meta', { property: 'og:title', content: 'Open Code Review 源码级解读' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          '对 alibaba/open-code-review 仓的深度源码解读与落地指南：源码级剖析、端到端流程追踪、部署落地与坑点最佳实践。',
      },
    ],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
    // 学习笔记悬浮组件（localStorage），VitePress SPA 路由切换由 theme/index.ts 通知其重挂载
    ['script', { src: `${base}notes.js` }],
  ],

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: '/favicon.svg',

    nav: [
      { text: '首页', link: '/' },
      { text: '序言', link: '/preface' },
      { text: '源码剖析', link: '/source/cli' },
      { text: '落地指南', link: '/deployment/install' },
    ],

    sidebar: [
      { text: '序言', link: '/preface' },
      { text: '阅读路径：入门级 vs 进阶级', link: '/reading-path' },
      {
        text: '第一部分 — 概览',
        collapsed: false,
        items: [
          { text: '1. 项目定位与设计哲学', link: '/overview/project' },
          { text: '2. 顶层架构总览', link: '/overview/architecture' },
          { text: '3. 核心概念词典', link: '/overview/concepts' },
        ],
      },
      {
        text: '第二部分 — 源码级深度剖析',
        collapsed: false,
        items: [
          { text: '4. CLI 层与命令树', link: '/source/cli' },
          { text: '5. LLM 客户端与多协议抽象', link: '/source/llm' },
          { text: '6. Agent 编排层 (diff-review)', link: '/source/agent' },
          { text: '7. llmloop：LLM 工具调用循环与上下文压缩', link: '/source/llmloop' },
          { text: '8. Tool：六件套工具体系', link: '/source/tools' },
          { text: '9. diff：Git diff 解析、行号定位与重定位', link: '/source/diff' },
          { text: '10. scan：全文件审查管线', link: '/source/scan' },
          { text: '11. delegate：委派模式 (无 LLM)', link: '/source/delegate' },
          { text: '12. session：会话持久化与断点续审', link: '/source/session' },
          { text: '13. config & rules：配置体系与规则匹配', link: '/source/config-rules' },
          { text: '14. prompt 模板：提示词工程内幕', link: '/source/prompts' },
          { text: '15. MCP 客户端扩展', link: '/source/mcp' },
          { text: '16. viewer：会话回看 Web 服务', link: '/source/viewer' },
          { text: '17. telemetry：OpenTelemetry 可观测性', link: '/source/telemetry' },
          { text: '18. 辅助包：gitcmd / model / pathutil / stdout / suggestdiff / release', link: '/source/auxiliary' },
        ],
      },
      {
        text: '第三部分 — 端到端流程追踪',
        collapsed: false,
        items: [
          { text: '19. ocr review --from A --to B 全链路时序', link: '/flow/review-trace' },
          { text: '20. ocr scan 全链路时序', link: '/flow/scan-trace' },
          { text: '21. 委派模式三步走时序', link: '/flow/delegate-trace' },
        ],
      },
      {
        text: '第四部分 — 落地指南',
        collapsed: false,
        items: [
          { text: '22. 安装方法与选型', link: '/deployment/install' },
          { text: '23. 配置 LLM 提供商', link: '/deployment/config-llm' },
          { text: '24. 第一次审查', link: '/deployment/quickstart' },
          { text: '25. 自定义审查规则', link: '/deployment/custom-rules' },
          { text: '26. CI/CD 集成（GitHub Actions / GitLab / Gerrit 等）', link: '/deployment/cicd' },
          { text: '27. 编程代理集成（Claude Code / Codex / Cursor / OpenCode）', link: '/deployment/agents' },
          { text: '28. VS Code 扩展', link: '/deployment/vscode' },
          { text: '29. Session Viewer 与断点续审', link: '/deployment/viewer-resume' },
          { text: '30. 可观测性接入', link: '/deployment/telemetry' },
          { text: '31. 从源码构建与发布制品', link: '/deployment/build' },
        ],
      },
      {
        text: '第五部分 — 坑点与最佳实践',
        collapsed: false,
        items: [
          { text: '32. 常见踩坑清单', link: '/pitfalls/checklist' },
          { text: '33. 性能与成本调优配方', link: '/pitfalls/tuning' },
          { text: '34. 安全注意事项', link: '/pitfalls/security' },
          { text: '35. 调试与排障手册', link: '/pitfalls/debug' },
        ],
      },
      {
        text: '附录',
        collapsed: false,
        items: [
          { text: 'A. 文件树速查', link: '/appendix/tree' },
          { text: 'B. 环境变量总览', link: '/appendix/env-vars' },
          { text: 'C. CLI 标志总览', link: '/appendix/flags' },
          { text: 'D. 术语表', link: '/appendix/glossary' },
          { text: 'E. benchmark 的外部核查与质疑时间线', link: '/appendix/benchmark' },
        ],
      },
    ],

    outline: {
      level: [2, 3],
      label: '本页大纲',
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '无法找到相关结果',
            resetButtonTitle: '清除查询条件',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },

    editLink: {
      pattern: 'https://github.com/Atituiset/open-code-review/edit/main/docs/:path',
      text: '在 GitHub 上编辑此页',
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/Atituiset/open-code-review' }],

    docFooter: { prev: '上一页', next: '下一页' },

    lastUpdated: {
      text: '最后更新于',
      formatOptions: { dateStyle: 'short', timeStyle: 'short' },
    },

    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    skipToContentLabel: '跳转到内容',

    footer: {
      message: '基于 Apache-2.0 许可发布',
      copyright: 'Copyright © 2026 Open Code Review 源码级解读',
    },
  },
})
