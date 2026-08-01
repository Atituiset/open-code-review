# 33. 性能与成本调优配方

OCR 成本 = **token 消耗 × 模型单价 + LLM 延迟 × 并发**。本章给可落地的调优手段，每一条都指向源码层原理。

## 33.1 成本结构拆解

一次 `ocr review --from A --to B` 的成本主要来自：

1. **每文件 Main loop**：初始 prompt（system + rules + diff + change_files + plan_guidance）+ 每轮工具结果回灌 + 每轮 assistant 回复。工具调用越多，context 膨胀越快（**这是最大的变量**，#409 实测 300× 膨胀）。
2. **plan phase**：变更 ≥50 行的文件额外 1 次调用。
3. **review_filter**：每文件 1 次调用。
4. **memory compression**：长对话超 60%/80% 阈值时触发，本身也是 1 次 LLM 调用。

## 33.2 削成本的杠杆（按性价比排序）

### 1. 缩小审查范围（最有效）

```bash
# 只审关键路径
ocr review --exclude '**/generated/**,**/testdata/**,**/fixtures/**'
# 或按目录定向
ocr review --path ... # review 不支持 --path，用 exclude 或跑 scan --path

# 规则层排除
# .opencodereview/rule.json
{ "exclude": ["**/generated/**", "**/testdata/**", "**/migrations/**"] }
```

**原理**：`filterDiffs` 在 LLM 之前就砍掉文件，一分 token 都不花。

### 2. 用 prompt cache（Anthropic 尤其划算）

- `anthropic` client 自动给 system + tools 打 `cache_control: ephemeral`（`client.go:748/752`）。同仓连续 review 命中缓存，输入 token 价按 cache-read 算，便宜 90%+。
- **不要**频繁改 prompt/规则——缓存 key 会失效。
- 并发文件数一致时缓存命中率最高（scan 按语言分组批量相邻就为此）。

### 3. 控制工具调用膨胀

- `MAX_TOOL_REQUEST_TIMES` 默认 30 次/文件。工具滥用多的模型（较弱的模型更容易疯狂调 `file_read`/`code_search`）会烧 token。
  注意 `--max-tools` **只能上抬**（`shared.go:54`：`maxTools > 模板值` 才生效），**不能收紧**；要压低轮数得改 `tools.json`/模板。
- 换更强的模型通常**少调工具**（一次 code_search 顶十次 file_read）。
- 在规则/background 里提醒"避免重复调用同一工具"（`scan_template.json` 的 MAIN_TASK 就显式这么写）。

### 4. 预算兜底

```bash
ocr review --max-tokens-budget 1500000    # 1.5M tokens 封顶
```

超预算返回 `status: budget_exceeded` + partial comments（`agent.go:419` gate），不会整单崩。

### 5. 关 thinking 模型消耗

```bash
ocr config set llm.extra_body '{"thinking":{"type":"disabled"}}'
```

DeepSeek-R1 / o1 系 if 默认开 thinking，review 里思考 token 可能翻倍。review 场景通常不需要长链思考。

### 6. plan phase 阈值（不可配置，知道就行）

`PLAN_MODE_LINE_THRESHOLD=50` 写死在 `task_template.json`。小改动不触发 plan，省一次调用。

### 7. 用 delegate 省一份 LLM

如果团队已有 Agent，`ocr delegate preview + rule` 不花 OCR 侧 LLM 钱（宿主用自己的配额）。

## 33.3 性能（延迟）调优

### 并发与限速

```bash
ocr review --concurrency 8        # 默认；网关限速时降 2-4
ocr review --timeout 5            # 单文件子任务超时兜底（分钟，默认 10）
```

### 延迟关键路径

```
单文件延迟 ≈ max(LLM 调用延迟) × 轮数 + 工具延迟 + 评论处理(异步)
整体延迟 ≈ 文件数 / 并发 × 单文件延迟
```

- **每轮 LLM 延迟**由模型决定（Haiku 级 vs Opus 级，差异很大）。review 场景精度优先可选强模型，但延迟敏感可用小模型 + 高精度工程（OCR 的定位/过滤是确定性的，不依赖模型）。
- **评论处理异步化**：`code_comment` 异步（`llmloop.go:399`），LLM 主循环不等评论行号解析。这是延迟优化的关键设计。
- **file_read 截断 500 行**：模型要读大文件需多次调用，延迟上升。用 `--max-tools` 放开或换大 context 模型。

### scan 的延迟

scan 是 batch 串行（batch 内文件并发），`by-language` 策略让相邻文件同语言 → prompt cache 命中率高 → 后续文件更快。**batch 内并发默认 8**，可用 `--concurrency` 调。

## 33.4 预算表格（估算参考）

| 场景 | 大致 tokens/文件 | 说明 |
|------|-----------------|------|
| 小改动（<50 行） | 3k-8k | 无 plan，1-2 轮 main + 1 filter |
| 大改动（100-300 行） | 10k-30k | 有 plan，2-4 轮 main |
| 超大文件（近 58888） | 50k+ | 接近 MaxTokens，会被 filterLargeDiffs 拦 |
| scan 2000 行文件 | 20k-50k | 整文件进 prompt + 工具膨胀 |

**注意**：以上是"不膨胀"的乐观值。带大量工具调用的复杂 review 可能 ×10-100。真值看 API `usage`（session JSONL 里有逐条记录）。

## 33.5 监控

```bash
# 每次 review 后看 token 摘要（human 模式自动打印）
# 或 JSON 输出里 total_input_tokens / total_output_tokens

# 长期监控
OCR_ENABLE_TELEMETRY=1 + OTLP → Prometheus 看 ocr.llm.tokens_used by model
```

## 33.6 结论性配方

```
稳定优先（CI 门槛）：  锁版本 + fetch-depth:0 + --audience agent + 并发4 + --timeout 5 + max-tokens-budget
                      + route_severity_below high（评论分流）+ incremental
性价比优先（本地）：  强模型 + prompt cache（Anthropic）+ 规则聚焦 + 工具轮数保持默认
成本极敏：            弱模型 + 关 thinking + 缩小范围 + delegate 复用宿主 LLM（`--max-tools` 只能上抬不能收紧）
```
