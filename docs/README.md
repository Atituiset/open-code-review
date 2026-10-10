# Open Code Review 源码解读文档

基于 [alibaba/open-code-review](https://github.com/alibaba/open-code-review) 源码的深度解读文档，使用 [VitePress](https://vitepress.dev/) 构建。

## 目录结构

```
docs/
├── package.json       # VitePress 依赖与脚本
├── index.md           # 首页（layout: home）
├── .vitepress/        # VitePress 配置与主题
│   ├── config.mts     # 站点配置（新增章节需同步 sidebar）
│   └── theme/         # 自定义主题（DocMeta / custom.css）
├── public/            # 静态资源（favicon、notes.js）
├── preface.md         # 序言
├── reading-path.md    # 阅读路径
├── overview/          # 概览：定位、架构、概念
├── source/            # 源码级深度剖析（各 internal 包）
├── flow/              # 端到端流程追踪
├── deployment/        # 落地指南
├── pitfalls/          # 坑点与最佳实践
└── appendix/          # 附录（文件树、env、flags、术语、benchmark 核查）
```

## 前置条件

- Node.js ≥ 20（建议 22）

## 常用命令

```bash
# 在 docs/ 目录内
cd docs

# 安装依赖
npm install

# 本地预览（默认 http://localhost:5173，自动监听改动）
npm run docs:dev

# 构建静态站点到 .vitepress/dist
npm run docs:build

# 预览构建产物
npm run docs:preview
```

## 维护约定

- **新增章节**：在对应分节目录下建 md 文件，并同步登记到 `.vitepress/config.mts` 的 `sidebar`。
- **引用源码**：尽量用 `文件路径:行号` 形式（如 `internal/agent/agent.go:195`），便于跳转。
- **构建产物**：`.vitepress/dist` 与 `.vitepress/cache` 已加入 `.gitignore`，不提交。
