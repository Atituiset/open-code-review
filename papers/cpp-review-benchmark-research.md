# C/C++ Code Review 评测集建设：深度调研报告

> 调研日期：2026-08-14。目标：为建设一个 **PR 级、带 golden comments 的 C/C++ 代码审查评测集**（形态对齐 Martian Code Review Bench）做文献调研，评估现有 C/C++ 漏洞数据集与代码审查评测方法的可复用性。
>
> 所有原版论文 PDF 已下载至本目录（Big-Vul 除外，IEEE 付费不可得，以官方数据仓库替代分析）。

## 0. 材料清单

| 论文/数据集 | 来源 | 本地文件 | 获取方式 |
|---|---|---|---|
| Meta CQS（代码审查系统+评测方法） | arXiv 2508.02732 | `cqs-meta-2508.02732.pdf` | 全文精读 |
| CVEfixes | arXiv 2107.08760 | `cvefixes-2107.08760.pdf` | 全文精读 |
| DiverseVul | arXiv 2304.00409 | `diversevul-2304.00409.pdf` | 全文精读 |
| Devign | arXiv 1909.03496 | `devign-1909.03496.pdf` | 全文精读 |
| PrimeVul（数据集质量审计） | arXiv 2403.18624 | `primevul-2403.18624.pdf` | 全文精读 |
| SecVulEval | arXiv 2505.19828 | `secvuleval-2505.19828.pdf` | 全文精读 |
| CASTLE | arXiv 2503.09433 | `castle-2503.09433.pdf` | 全文精读 |
| Big-Vul | MSR 2020（IEEE 付费） | 无 | 官方仓库 README + 摘要页 |

## 1. 逐篇精读要点

### 1.1 Meta CQS（arXiv 2508.02732）— 唯一的工业级 code review 评测方法论

Meta 的 Code Quality Score 系统，5000+ 工程师在用，是"代码审查评测"唯一有完整方法论的工业论文。与本任务直接相关的部分：

**评测集构建流水线（第 4 节）：**
1. 采 200 个 diff，7 种语言，以 C++/PHP/Python 为主，与训练集严格隔离；
2. 用 GPT-4o / Claude 3.7 Sonnet / Gemini-2.5-pro 三个前沿模型分别生成候选 review，**取并集以最大化问题覆盖**；
3. 每个 diff 由 ≥2 名工程师独立标注，**只保留两人在 issue tag + 行号 + rationale 三维度全部一致的问题**，分歧项直接丢弃；
4. 200 diff → 约 80 个 (diff, review) 对，每个含 2~4 条共识问题。

**评估协议（semi-deterministic verification）：** issue tag 先精确匹配，rationale 再用轻量 LLM（Llama 3.1-8B）做语义判等，外加人工抽查 sanity check。

**论文自报的三个偏差（本任务必须修正的）：**
- ground truth 由被测模型生成 → 评测数据偏向 GPT/Claude/Gemini；
- 标注时工程师**能看到候选问题来自哪个模型** → 进一步放大偏差；
- 只让标注者验证"模型找到的问题对不对"，**没让他们找"模型漏掉的问题"** → recall 分母不完整。

**其他可借鉴工序：** issue schema（tag / 文件 / 行号 / 函数名 / rationale）；LLM 对人类评论打"good/bad"分并改写为 rationale；LLM-judge + 规则过滤将 precision 从 13.5% 提到 78.2%（recall 掉到 1.2%——证明纯靠后过滤压 precision 的代价）。

### 1.2 CVEfixes（arXiv 2107.08760）— 结构化程度最高的种子池

- **管线**：NVD JSON feed 取 CVE/CWE/CVSS → CVE 记录的 reference 里找修复 commit hash → PyDriller 临时 clone 仓库提取前后代码。全自动可重跑，全量约 15 小时。
- **规模**：5,365 CVE / 1,754 项目 / 5,495 修复 commit / 50,322 方法 / 180 种 CWE（首版，截至 2021-06）。
- **粒度**：CVE→repo→commit→file→method 五级关系库；含 `code_before`/`code_after`、原始 diff、解析后增删行、圈复杂度。标签零人工，继承 NVD 的 CWE/CVSS。
- **自报局限**：tangled commit（修复混入无关改动）未做 untangling；CWE 有 noinfo/other 兜底类；类别极不平衡（top-10 CWE 覆盖 55.6%，Linux 一家 973 个 CVE）。
- **第三方审计**：PrimeVul 实测其函数级标签准确率仅 **51.7%**；测试集与训练集精确重复率 **18.9%**（同类最高）。

### 1.3 DiverseVul（arXiv 2304.00409）— 覆盖最广，但标签只有六成准

- **管线特色**：数据源不是 NVD 直采而是**安全 issue 网站**（snyk.io、bugzilla.redhat.com），commit 锚点质量更高；用 "introduced/first included" 关键词剔除引入漏洞的 commit，改动 ≥10 函数的 commit 全量人工复核。
- **规模**：7,514 commit / 797 项目 / 18,945 漏洞函数 + 330,492 非漏洞函数 / 150 CWE——C/C++ 部分是 CVEfixes 的两倍多。
- **自报标签准确率仅 60%**，错误三分法：漏洞跨多函数（10%）、修复相关但函数本身不脆弱（12%）、完全无关改动（18%）。MD5 去重前未做代码归一化。
- **关键实验**：按**项目**留出 95 个 unseen projects 后，所有模型 F1 从 49% 暴跌至 **9.4%**——实证了"随机切分导致同项目泄漏"会严重高估性能。

### 1.4 Devign（arXiv 1909.03496）— 人工标注的反面教材

- **管线**：Git commit message 安全关键词预筛 → 4 名安全研究员、约 600 人时、两轮标注 + 交叉验证判 VFC/non-VFC → commit 修改过的函数取修复前版本打 0/1 标签。
- **规模**：Linux/QEMU/Wireshark/FFmpeg 四项目，仅公开 FFmpeg+QEMU 子集约 2.7 万函数。
- **教训**：虽然号称人工标注，PrimeVul 实测其标签正确率仅 **24%**（"commit 是修复 ⟹ commit 里所有函数都是漏洞"的粗粒度假设是主因）；自证在 10% 漏洞比例的不平衡设定下 F1 骤降至 27~42——**平衡集指标虚高**。
- **结论**：人工标注 ≠ 高质量，标注协议（粒度、共识规则）比标注者身份更关键。

### 1.5 PrimeVul（arXiv 2403.18624）— 数据集质量审计的标杆，质控方法论可直接抄

对现有数据集的审计数字（每集抽 50 个漏洞函数人工核验）：

| 数据集 | 标签正确率 | 训练/测试精确重复率 |
|---|---|---|
| Devign / CodeXGLUE | **24%** | — |
| Big-Vul | **25%** | 12.7% |
| VulnPatchPairs | 36% | — |
| CrossVul | 47.8% | — |
| CVEfixes | 51.7% | **18.9%** |
| DiverseVul | 60% | 3.3% |

**性能幻觉实证**：StarCoder2-7B 在 Big-Vul 上 F1=68.26%，在 PrimeVul 上仅 **3.09%**；GPT-4+CoT 的 pair-wise 判断正确率 12.94%，**低于随机基线 22.70%**。

**质控工序（本任务直接继承）：**
- **OneFunc** 规则（commit 只改一个函数才采信，86% 准确）+ **NVDCheck** 规则（NVD 描述显式提及函数/文件名，92% 准确）做初筛，再人工复核；
- 去空白归一化后 MD5 双重去重；
- **按 commit 日期时间序切分**（80/10/10），同一 commit 不跨集合——杜绝"用未来训练测过去"；
- 5,480 对 (vulnerable, fixed) 配对样本（仅保留字符串重叠 ≥80% 的难样本对）。
- 论文自己也承认：**函数级粒度假设本身可疑**，判断漏洞常需跨函数上下文——这正是 PR 级 review 评测要超越的。

### 1.6 SecVulEval（arXiv 2505.19828）— 元数据最全、语句级标注

- **规模**：5,867 CVE / 707 项目 / 145 CWE / 25,440 函数（10,998 漏洞 + 14,442 非漏洞），时间跨度 1999–2024。
- **过滤管线**（四步，可直接复用）：剔除非 C/C++ 文件 → 剔除多 commit 修复 → 剔除无函数变更的 commit → 启发式去 tangled changes（只保留唯一被改函数或被 CVE/commit message 显式提及的函数）。
- **语句级而非行级标注**：批评行级标签在 C/C++ 中无语义（一条语句常跨多行）——与 review comment 锚定"有语义代码单元"的诉求一致。
- 含 GPT-4.1 自动提取的五类上下文（参数/外部函数/类型声明/全局量/执行环境），但人工验证准确率仅 82.98%——**LLM 自动生成的上下文/标注不能免检**。

### 1.7 CASTLE（arXiv 2503.09433）— 校准件的正确形态

- 250 个专家手写 C 微基准，25 CWE × 每类 10 例（6 正 + 4 负，刻意平衡测 FP/FN）；每文件恰好 0 或 1 个漏洞；必须可无错编译。
- **行级标注格式**：`// {!LINE}` 注释 + YAML 元数据头（CWE、描述、编译命令）——与 golden comment 的"文件+行+CWE"结构天然对齐。
- 自报局限：微基准 ≠ 真实软件，LLM 在 400+ 行文件上 FP 增多、检出率骤降——**微基准分数不能外推到 PR 级**。
- 竞品缺陷清单（其 Table 1）：多数数据集不可编译、正例率 3%~7%、类别不平衡——可作差异化论证素材。

### 1.8 Big-Vul（MSR 2020）— 原料矿，非标尺

- 3,754 漏洞 / 91 类 / 348 项目 / CVE 2002–2019；CSV 含 21 字段（cve_id、cwe_id、CVSS 全家桶、commit_id、前后版本、files_changed、summary），函数级有 `func_before`/`func_after` + diff 行——**字段骨架最接近 PR 级评测需求**。
- 全自动启发式标注（patch 触及的函数=漏洞），零人物质检。Croft et al.（ICSE 2023）抽查：**标签准确率仅 54.3%，约 17% 重复代码**；PrimeVul 复测仅 25%。DiverseVul 作者因质量问题直接弃用它。

## 2. 横向结论：四个残酷事实

1. **所有现成 C/C++ 漏洞数据集的标签都不可信**（正确率 24%~60%）。"fix commit 碰过的函数=漏洞函数"这一启发式是噪音主源。结论：**它们的标签只能当初筛，golden 标注必须人工重做**。
2. **泄漏是系统性的**：重复率 3.3%~18.9%、同项目随机切分（F1 49%→9.4%）、时间穿越。对策：归一化去重 + 按项目/时间切分 + 采新 CVE。
3. **性能幻觉真实存在**：Big-Vul F1 68% → PrimeVul 3%。任何"高分"都必须先问数据集质量。我们自己的评测集发布时应附标签正确率审计报告（PrimeVul 的做法：每类抽 50 样本人工核验）。
4. **粒度不匹配**：这批数据集全是函数级/语句级、二分类、无 review 文本。PR 级 review 评测需要的 diff 上下文、行级锚点、自然语言 rationale、严重度，**全都缺**——这正说明业内没有现成 C/C++ review 评测集的原因，也是我们要补的工序。

## 3. 建设方案（落地版）

### 3.1 总体架构：三层金字塔

```
        ┌─────────────────────────┐
        │  L3 校准层 (~300 样本)    │  CASTLE 式手写微基准 + Juliet 子集
        │  smoke test / FP 校准     │  标签 100% 精确，防 pipeline 回归
        ├─────────────────────────┤
        │  L2 主评测集 (~100 PR)    │  真实 C/C++ 修复 commit 构造的
        │  golden comments, 双人共识 │  PR 级样本，~300 条 ground truth
        ├─────────────────────────┤
        │  L1 种子池 (~数千 commit)  │  CVEfixes/DiverseVul/SecVulEval
        │  自动管线 + 启发式初筛      │  合并去重，2023 年后优先
        └─────────────────────────┘
```

### 3.2 L1 种子池构建（工序来源已标注）

1. **合并三个源**：CVEfixes（NVD 直采，结构化最好）、DiverseVul（issue 站锚点，CWE 覆盖最广）、SecVulEval（过滤管线最严、语句级标注、元数据全）。Big-Vul 只作字段 schema 参照，不直接采（质量垫底）。
2. **初筛规则**（继承 PrimeVul OneFunc/NVDCheck + SecVulEval 四步过滤）：
   - 单 commit 修复；改动函数 ≤3 个；
   - commit 非 merge/revert/纯重构；
   - CVE 描述显式提及被改函数名或文件名者优先（NVDCheck，92% 准确率）；
   - 仅保留 C/C++ 源文件变更。
3. **去重防泄漏**（PrimeVul 工序）：去空白归一化 → MD5 双重去重 → 同 commit 不跨集 → 记录 commit 日期供时间序切分。
4. **时间过滤**：优先 2023 年后的 CVE（晚于主流模型训练截止日）；SecVulEval 已覆盖到 2024，可直接取其尾部。
5. **负样本**：取同项目的非安全 commit（重构、特性开发）构造"无问题 PR"——测 FP 率。注意不能沿用"未被 patch 触碰=安全"的假设（Big-Vul 教训）。

### 3.3 L2 主评测集构造

**采样**：从 L1 按 CWE × diff 大小 × 项目领域分层抽 100~150 个 commit。CWE 类目取 DiverseVul 分布的头部 20~25 类（对齐 MITRE Top 25，参考 CASTLE 的选取逻辑），强制覆盖 C/C++ 特有类：CWE-119/125/787（内存越界）、CWE-416（UAF）、CWE-415（double free）、CWE-401（泄漏）、CWE-476（空指针）、CWE-362（竞争）、CWE-190（整数溢出）。

**样本形态**（每个样本）：
- 输入：修复 commit 的 parent 版本 + diff（即"一个待审查的 PR"）；
- golden comment schema（融合 CQS 与 CASTLE）：`{cwe_tag, severity, file, 语句级锚点, function, rationale, cve_summary改写稿}`；
- 锚点用**语句级**而非行号（SecVulEval 论证：C/C++ 行无语义；同时允许 ±行容差）。

**标注协议**（CQS 双人共识 + 修正其三个偏差）：
1. 两名资深 C/C++ 工程师**独立**标注（≥5 年系统编程/安全经验；CQS/Devign 都证明标注者质量是瓶颈，Devign 600 人时是参考量级）；
2. **盲标**：隐去 CVE 编号、CWE 标签、commit message 中的安全关键词——标注者只看到自己能找到什么（修正 CQS 的"看得见模型名"偏差，同时补齐"模型漏掉的问题"，修全 recall 分母）；
3. 共识规则：CWE tag + 函数 + 语句锚点三维一致才进 golden set；**分歧项不丢弃**，降级为 hard case 子集（带双方意见，用于难度分层）；
4. CVE 描述改写为 review 风格 rationale（借 CQS 的 LLM 改写 + 人工确认工序——SecVulEval 证明 LLM 自动产出需人工抽检，82.98% 准确率不可免检）；
5. 标注完成后**审计**：每 CWE 类抽 50 样本人工复核，公布标签正确率（PrimeVul 标准动作）。

**规模预期**：对齐 CQS（80 diff × 2~4 问题 ≈ 200~300 条 ground truth）。投入估算：两名资深工程师各 1~2 周（含培训与口径校准，可用 Devign 的 FFmpeg/QEMU 公开子集做标注前练兵）。

### 3.4 L3 校准层

- 从 CASTLE 的 250 个微基准中取 C/C++ 相关 CWE 子集（它本身就是 C 语言、带 `// {!LINE}` 行级标注、可编译）；
- 作用：(a) pipeline smoke test——检出率异常低说明评测管线有 bug；(b) FP 校准——6:4 正负配比可直接测误报；(c) 工具间快速横评；
- 不混入主指标（CASTLE 自证微基准分数不能外推）。

### 3.5 评估协议

- **两层匹配**（CQS 协议）：CWE tag 精确匹配 → 语句锚点/函数规则匹配 → rationale 用轻量 LLM 语义判等；judge 模型固定版本并写入结果元数据（Martian 做法）。
- **指标**：precision / recall / F1，**按 CWE 分层报告**（C/C++ 工具能力方差大，聚合分掩盖问题）；另报 VD-S 式"限定 FP 率下的漏报率"（借自 PrimeVul，对 CI 落地更有决策价值）。
- **防泄漏**：主评测集按 commit 时间序切 dev/test；配套 online 轨道持续采新 CVE（对齐 Martian 双轨设计）；评测前对被测工具公开其 dev 集即可，test 集保持私有或定期轮换。
- **基线**：发布时跑 GPT / Claude / Gemini + 1~2 个静态分析器（Clang SA / Infer / Semgrep）作参照系——CQS 和 CASTLE 都证明静态分析器基线对解读 LLM 分数必不可少。

### 3.6 各数据集的最终分工

| 数据集 | 角色 |
|---|---|
| CVEfixes | L1 主源：CVE→commit 溯源管线 + CWE/CVSS 标签体系 |
| DiverseVul | L1 补充源：CWE 头部类目分布依据 + 错误三分法质检分类 |
| SecVulEval | L1 过滤管线模板 + 语句级锚点粒度 + 2023-24 新 CVE 来源 |
| PrimeVul | 全流程质控方法论（初筛规则/去重/时间切分/审计） |
| Devign | 反面教材（粗粒度标签）+ 标注团队练兵数据 |
| Big-Vul | 字段 schema 参照，不直接采用 |
| CASTLE / Juliet | L3 校准层，smoke test 与 FP 基线 |
| Meta CQS | L2 标注协议与评估协议的骨架（修正其三个偏差后使用） |

## 4. 风险与开放问题

- **标注成本是硬约束**：C/C++ 资深工程师双人标注是全流程最贵的环节；若预算不足，宁可缩规模（50 PR）不可降标注标准——Devign 证明"人工标注但协议粗"比自动标注更误导。
- **CWE 共识的天然难度**：部分分歧是语言语义层面的（实现定义行为、编译器差异），hard case 子集可能比预期大。
- **时间过滤 vs 样本量的张力**：2023 年后的 C/C++ CVE 数量有限，可能需要放宽到 2022 并辅以 canary 检测。
- **judge 模型漂移**：语义判等依赖的轻量 LLM 换代会导致历史分数不可比，需固定 judge 版本 + 保留人工抽检通道。
