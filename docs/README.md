# Open Code Review 源码解读文档

基于 [alibaba/open-code-review](https://github.com/alibaba/open-code-review) 源码的深度解读文档，使用 [mdBook](https://rust-lang.github.io/mdBook/) 管理。

## 目录结构

```
docs/
├── book.toml        # mdBook 配置
├── src/             # 文档源码（markdown）
│   ├── SUMMARY.md   # 章节导航（新增章节需同步更新）
│   ├── overview/    # 概览：定位、架构、概念
│   ├── source/      # 源码级深度剖析（各 internal 包）
│   ├── flow/        # 端到端流程追踪
│   ├── deployment/  # 落地指南
│   ├── pitfalls/    # 坑点与最佳实践
│   └── appendix/    # 附录（文件树、env、flags、术语）
└── book/            # 构建产物（已 gitignore，不提交）
```

## 前置条件

- [mdBook](https://rust-lang.github.io/mdBook/guide/installation.html) ≥ 0.4.52
  - `cargo install mdbook` 或 `brew install mdbook`

## 常用命令

> 注意：`book.toml` 位于 `docs/` 下，因此**请在 `docs/` 目录内执行命令**，或在仓库根目录显式指定 `docs`。

```bash
# 在 docs/ 目录内
cd docs

# 构建静态站点到 book/
mdbook build

# 本地预览（默认 http://localhost:3000，自动监听改动）
mdbook serve

# 指定端口
mdbook serve -p 4000
```

或在仓库根目录：

```bash
mdbook build docs
mdbook serve docs
```

## 发布到 GitHub Pages

```bash
mdbook build docs                      # 生成 book/ 静态站
git add docs/src docs/book.toml        # 只提交源码，不提交 book/
```

如需 CI 自动构建部署到 Pages，可添加类似 workflow：

```yaml
name: docs
on:
  push:
    branches: [main]
    paths: ['docs/**']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: peaceiris/actions-mdbook@v2
        with: { mdbook-version: '0.4.52' }
      - run: cd docs && mdbook build
      - uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./docs/book
```

## 维护约定

- **新增章节**：在 `src/<section>/` 下建 md 文件，并同步登记到 `src/SUMMARY.md`。
- **引用源码**：尽量用 `文件路径:行号` 形式（如 `internal/agent/agent.go:195`），便于跳转。
- **构建产物**：`book/` 已加入 `.gitignore`，不提交。
