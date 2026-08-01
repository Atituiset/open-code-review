# 26. CI/CD 集成（GitHub Actions / GitLab / Gerrit 等）

OCR 官方提供了完整的多平台 CI 集成，全部遵循同一个模式：**用 npm 装 `ocr` → 配 LLM（env 或 config set）→ `ocr review --format json --audience agent` → 用脚本把 JSON 翻译成平台评论**。

## 26.1 统一模式

```
步骤 1: npm install -g @alibaba-group/open-code-review
步骤 2: 配置 LLM（环境变量 或 ocr config set）
步骤 3: ocr review --from <base> --to <head> --format json --audience agent > result.json
步骤 4: python post_review.py result.json   ← 平台专属脚本，把 JSON 贴成 inline comments
```

`examples/` 目录给了 6 个平台的完整示例 + README。下面逐个讲关键点。

## 26.2 GitHub Actions（推荐）

`examples/github_actions/ocr-review.yml`（123 行）+ `action.yml`（官方 composite action）。

### 官方 Action 用法

```yaml
name: OpenCodeReview
on:
  pull_request_target:
    types: [opened, synchronize, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: alibaba/open-code-review@main
        with:
          llm_url: ${{ secrets.LLM_URL }}
          llm_auth_token: ${{ secrets.LLM_AUTH_TOKEN }}
          llm_model: ${{ secrets.LLM_MODEL }}
          llm_use_anthropic: 'false'
```

### Action 关键输入

| input | 默认 | 说明 |
|-------|------|------|
| `llm_url` / `llm_auth_token` / `llm_model` / `llm_use_anthropic` | 必填 | 映射到 OCR_LLM_* env |
| `language` | English | `ocr config set language` |
| `base_ref` / `head_sha` | PR 事件自动取 | issue_comment 触发时需显式传 |
| `ocr_version` | latest | 建议锁版本 |
| `review_concurrency` / `background` / `rule` | | 透传给 review |
| `incremental` | 'false' | 只追加非重叠评论（增量模式） |
| `sticky_summary` | 'true' | 摘要评论就地更新（不重复发） |
| `route_severity_below` / `route_categories` | | 分级路由（见下） |
| `upload_artifacts` | 'true' | 上传 result.json / stderr 到 Actions artifacts |

### Action 的安全细节（源码 `action.yml`）

- **checkout base，不 checkout head**：用 `actions/checkout` 检 base（可信），PR head 用 `git fetch origin pull/<num>/head` 单独拉 blob——**不可信文件不被 materialize**，防恶意 PR 的 `.github/workflows` 覆盖本 workflow。
- **fork-safe**：`issue_comment` 触发器下用 `github-script` 解析 PR 号、从 comment 推断 base/head。
- **`route_*` 路由**：`route_severity_below: high` 意味着 severity < high 的评论不进 PR 线程，而进入 summary 路由。`route_categories` 同理。**fail-open**：never drops，只是路由。
- **失败即 fail job**：`OCR_EXIT_CODE` 非零则 job 失败，保证不"看起来过了其实没审"。

### 输出

`comments_total` / `comments_inline` / `comments_skipped`（增量重叠）/ `comments_routed` / `comments_failed` / `summary_comment_url`。

## 26.3 GitLab CI

`examples/gitlab_ci/.gitlab-ci.yml`：

```yaml
review:
  stage: review
  image: node:20
  resource_group: mr-review-$CI_MERGE_REQUEST_IID   # 按 MR 串行，防重复审
  variables:
    GIT_DEPTH: 0
  script:
    - npm i -g @alibaba-group/open-code-review
    - ocr config set llm.url "$LLM_URL"
    - ocr config set llm.auth_token "$LLM_AUTH_TOKEN"
    - ocr config set llm.model "$LLM_MODEL"
    - ocr config set llm.use_anthropic false
    - ocr config set llm.extra_body '{"thinking":{"type":"disabled"}}'
    - ocr review --from origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME --to $CI_COMMIT_SHA --format json --audience agent > /tmp/ocr-result.json
    - python3 post_review.py /tmp/ocr-result.json    # 把评论贴成 GitLab MR discussions
```

要点：
- `resource_group: mr-review-$MR_IID` 让同一 MR 的 job 串行（防止并发重复审）。
- `GIT_DEPTH: 0` 全量克隆，确保 merge-base 可靠。
- `post_review.py` 是仓库内自带的脚本，把 OCR JSON 转成 GitLab discussions（含旧侧行号换算）。
- 可用重试/限速环境变量（`OCR_RETRY_BASE_DELAY`、`OCR_MAX_RETRIES`）。

## 26.4 Gerrit（Jenkins）

`examples/gerrit_ci/Jenkinsfile`：由 Gerrit Trigger 插件触发，用 Jenkins credentials（`ocr-llm-auth-token` + `gerrit-http`），显式 refspec 检出 `$GERRIT_PATCHSET_REVISION`，装 `@1.7.12` 锁版本，跑 review 后 `post_review.py` 贴到 Gerrit change。**注意 Jenkins 里 extra_body 没有环境变量通道**（GitHub 示例用 `config set` 才写入）。

## 26.5 Bitbucket Pipelines / GitFlic / Codeup（Alibaba Cloud Flow）

- **Bitbucket**：`examples/bitbucket_pipelines/bitbucket-pipelines.yml`，anchored step 复用，`git fetch origin +refs/heads/<dest>:...` 物化目标分支后 `--from origin/<dest> --to $BITBUCKET_COMMIT`。
- **GitFlic**：`examples/gitflic_ci/gitflic-ci.yaml`，需 `OCR_LLM_URL/AUTH_TOKEN` + `GITFLIC_TOKEN`，API 默认 `api.gitflic.ru`。
- **Codeup**：`examples/codeup_ci/codeup-flow.yml`，阿里云 Flow，`mergeRequestOpen/mergeRequestUpdate` 触发。

## 26.6 通用 CI 模板（自己搭）

```yaml
# 任意 CI
steps:
  - name: Checkout
    uses: actions/checkout@v4
    with: { fetch-depth: 0 }

  - name: Install OCR
    run: npm install -g @alibaba-group/open-code-review@<锁版本>

  - name: Configure LLM
    env:
      OCR_LLM_URL: ${{ secrets.LLM_URL }}
      OCR_LLM_TOKEN: ${{ secrets.LLM_AUTH_TOKEN }}
      OCR_LLM_MODEL: ${{ secrets.LLM_MODEL }}
    run: |
      ocr config set language Chinese
      # 如果网关需要关闭 thinking
      ocr config set llm.extra_body '{"thinking":{"type":"disabled"}}'

  - name: Run Review
    id: review
    run: |
      ocr review --from origin/$BASE_REF --to $HEAD_SHA \
        --format json --audience agent \
        --concurrency 8 --timeout 5 \
        > /tmp/ocr-result.json || echo "OCR_EXIT=$?" >> "$GITHUB_ENV"
      cat /tmp/ocr-result.json

  - name: Post comments
    run: python3 .github/scripts/post-review.py /tmp/ocr-result.json   # 平台自己写
```

## 26.7 CI 集成坑点汇总

1. **必须 `fetch-depth: 0`**：merge-base 需要完整历史，`--shallow` 克隆会让 `--from/--to` 找不到 base。
2. **锁 OCR 版本**：`@latest` 会滚动，prompt/工具集变化会导致评论风格漂移。CI 锁版本，本地可升级。
3. **并发去重**：多 job 触发（push+PR）会并发审同一 diff，浪费 token。用 GitLab `resource_group` 或 GitHub `concurrency`。
4. **`llm_use_anthropic` 用布尔判断协议**：GitHub Action 的 `llm_use_anthropic: 'false'` 会设 `OCR_LLM_USE_ANTHROPIC=false`。有些网关（DashScope 等）只认 OpenAI 协议，别设反。
5. **`thinking` 模型**：若你的模型默认开 thinking 且消费高，加 `extra_body: {"thinking":{"type":"disabled"}}`（只走 config set，无 env 通道）。
6. **评论区限流**：一次性贴 100+ inline comments 可能触发平台限制。用 `route_severity_below` 分流或 `incremental` 增量模式。
7. **fork PR 的 secrets**：`pull_request_target` 用 repo secrets（安全），但 head 分支代码不可信——OCR 只审 diff 不执行 head 代码，相对安全。但 post-review 脚本要防头注入（只读 diff 文本）。
8. **`--audience agent` 忘加**：不加的话 stdout 会混入 `[ocr]` 进度行，`--format json` 也救不回（静音机制靠 audience）。**CI 里两个都要**。
