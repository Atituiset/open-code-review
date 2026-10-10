# E. benchmark 的外部核查与质疑时间线

> 定位：**全水平（速查）** ｜ 只记录公开可查的第三方复测与官方回应，不重复官方口径（见 [1.5](../overview/project.md)）。读 benchmark 数字前先看这里，校准预期。

## E.1 仓库内展示的 benchmark 数字（先对齐事实）

项目官网的 benchmark 表格（[`pages/src/components/BenchmarkSection.tsx:39`](https://github.com/alibaba/open-code-review/blob/main/pages/src/components/BenchmarkSection.tsx#L39)）里，最好的一行是 **Claude-4.6-Opus + OCR**：

| 模型 | 来源 | F1 | Precision | Recall |
|------|------|----|-----------|--------|
| Claude-4.6-Opus | Open Code Review | 25.10% | 33.90%（301/889） | 20.00%（301/1505） |
| Claude-4.6-Opus | Claude Code | 11.57% | 7.23%（435/5980） | 28.90%（435/1505） |

仓库自己展示的数字本身**并不虚高**：最高 F1 也只有 25.1%，走的是"**高 precision、低 recall**"路线——官方 README 也明说 Recall 低于通用 Agent 是有意取舍。与 Claude Code 的对比只在**同一底模**下成立（precision 33.9% vs 7.2%，F1 25.1% vs 11.6%），不是绝对意义上的"高精度审查器"。

## E.2 Hacker News 上的第三方复测与质疑

2026-06-05 在 [Hacker News 帖子 #48406358](https://news.ycombinator.com/item?id=48406358) 上，OCR 发布后引发了公开的 benchmark 复测与质疑，关键节点如下：

### 1. eranation：Martian benchmark 复测，结果与官方口径冲突

评论 [#48408272](https://news.ycombinator.com/item?id=48408272)：用 **Martian benchmark** 复测 OCR，只跑了子集（50 个 PR 中的 10 个），得到 **recall ~74%、precision ~12%、F1 ~20%**——与官方"precision 显著更高"的表述明显冲突（高 recall 低 precision，而不是反过来）。

### 2. eranation：质疑 ground-truth 标注的主观性

评论 [#48411375](https://news.ycombinator.com/item?id=48411375)：进一步质疑 benchmark 的 golden 标注（1,505 条 ground-truth）本身主观——代码审查"什么算真问题"没有客观标准，标注者口径不一致会直接放大/缩小 precision。

### 3. 官方回应：测试版本存在关键 tool call 异常

官方成员 lizhengfeng101 在评论 [#48472124](https://news.ycombinator.com/item?id=48472124) 中回应：承认第三方复测所用的测试版本存在**关键 tool call 异常**，导致大量误报（FP 偏高），官方已复现并修复。

### 4. jayphen：独立跑全量 50 个 PR

评论 [#48426352](https://news.ycombinator.com/item?id=48426352)：另一位用户用全量 50 个 PR 独立复测，得到 **precision 43.0% / recall 35.8% / F1 39.0**，与 CodeRabbit 等同类工具大致持平——比 eranation 的子集结果好很多，但依然远低于"高 precision"的直觉印象。

## E.3 如何解读这些差异

同一产品出现三组差异巨大的数字（官方 33.9%/20.0%、子集 12%/74%、全量 43.0%/35.8%），原因拆开看其实很清晰：

1. **测试版本不同**：官方承认早期版本有 tool call 异常，第三方复测的版本与官方 benchmark 的版本不一定一致。
2. **跑分范围不同**：10/50 子集 vs 50/50 全量，PR 难易分布不同，precision/recall 都会显著漂移。
3. **ground-truth 口径不同**：标注主观性在代码审查 benchmark 里是结构性问题，跨 benchmark（OCR 自建 vs Martian）对比时尤其明显。
4. **召回定义不同**：Martian 等 benchmark 的"问题清单"粒度与 OCR 自建 1,505 条的粒度不同，直接比 recall 没有意义。

结论：**官方自报数字不应被当作绝对质量承诺**，它只证明"同一底模下，OCR 的 precision/F1 比裸 Claude Code 更高"。要验证当前版本的真实水平，正确做法是用自己仓库的 PR 跑一遍，再人工抽样标注 precision（社区踩坑清单见 [第 32 章](../pitfalls/checklist.md)）。
