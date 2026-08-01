# 25. 自定义审查规则

## 25.1 规则体系的 4 层

```
高  --rule <file>                         仅本次命令
 │   <repo>/.opencodereview/rule.json     仓库级（团队共享）
 │   ~/.opencodereview/rule.json          用户级（个人）
低   内置 system_rules.json + rule_docs/* 二进制内嵌
```

匹配规则：**先匹配者赢**，且用户规则默认**替换**系统规则；设 `merge_system_rule: true` 则拼接。

## 25.2 仓库级规则文件

在仓库根目录放 `.opencodereview/rule.json`：

```json
{
  "rules": [
    {
      "path": "src/**/*.go",
      "rule": "重点检查错误处理：所有返回 error 的地方必须被调用方处理；禁止静默吞 err。",
      "merge_system_rule": true
    },
    {
      "path": "api/**/*.py",
      "rule": "所有 API 入口必须参数校验；禁止用 eval() 或 pickle 反序列化不可信输入。"
    }
  ],
  "include": ["src/**/*.go"],
  "exclude": ["src/generated/**", "src/vendor/**"]
}
```

### `rule` 字段的两种写法

1. **内联文本**：直接写规则内容（多行也行）。
2. **引用文件**：值形如 `./team-rules/go.md`（无空格、扩展名 `.md/.txt/.markdown`），OCR 会读文件内容替换：
   - 相对路径基于**仓库根目录**解析，且**不能路径穿越**出仓（`system_rules.go:512`）。
   - 大小上限 512 KB、符号链接解析后检查扩展名。

### `merge_system_rule` 语义

默认用户规则**整体替换**该路径的规则（包括 Go 通用规则）。设 `true` 后变为拼接：

```
## System-Specific Rules (Mandatory)

<系统 go.md 全部内容>

---

## User-Specific Rules (Mandatory)

<你的规则>
```

**推荐团队做法**：写业务特定规则时设 `merge_system_rule: true`，保留 OCR 的通用质量底线。

## 25.3 include / exclude 语义

- `exclude`：匹配的路径直接跳过（不审）。
- `include`：只审匹配的路径；**且 include 可以绕过扩展名白名单**（#371）——你想审 `.ftl`/`.vue` 等默认不支持的扩展时靠它。
- 优先级判定顺序（`agent.go whyExcluded`）：
  1. binary → 跳过
  2. 用户 exclude → 跳过
  3. 配置了 include 且匹配 → 放行（即使扩展名不在白名单）
  4. 扩展名不在白名单 → 跳过
  5. 默认排除路径（测试文件等）→ 跳过

> 坑：`include` 与 `exclude` 的 glob 用 doublestar 语法（支持 `**`、`{a,b}`），且大小写不敏感。

## 25.4 全局规则文件

`~/.opencodereview/rule.json` 结构与项目文件相同。适用：个人常用规则（如"所有 Go 代码必须处理 err"）。

## 25.5 `--rule` 临时规则

```bash
ocr review --rule /tmp/special-rules.json --from main --to feature
```

用于一次性特殊审查（如"只查安全问题"）。

## 25.6 系统内置规则（默认值）

`internal/config/rules/rule_docs/*.md` 是 33 个语言/技术专属规则，全在二进制里：

| 文件 | 覆盖 | 内容要点 |
|------|------|---------|
| `go.md` | `**/*.go` | errors/panics、context/goroutine、nil/接口、slice/map 边界、并发安全 |
| `java.md` | `**/*.java` | NPE、switch fall-through、线程安全、N+1 查询 |
| `python.md` | `**/*.py` | 可变默认参数、`==` vs `is`、异常链、async 阻塞、安全反序列化 |
| `ts_js_tsx_jsx.md` | `**/*.{ts,js,tsx,jsx}` | React hooks、`===`、异步错误、XSS |
| `default.md` | 其它 | 通用 Correctness/Security/Performance/Maintainability/Test |

**自定义系统规则的替代思路**：与其 fork 改 `rule_docs/*.md`，不如用项目 `rule.json` + `merge_system_rule: true` 追加你的规则——既保留官方基线，又能注入团队要求。

## 25.7 规则影响范围：只进 prompt

规则文本通过 `{{system_rule}}` 占位符注入每文件的 main_task_user / plan_task_user prompt。它**只影响 LLM 注意力**，不改变 OCR 的工程行为（文件选择/定位/过滤）。所以：

- 想让某类文件被审 → 改 `include`（工程层）。
- 想让 LLM 关注某类问题 → 改 `rule`（prompt 层）。

## 25.8 校验规则

```bash
ocr rules check                    # 校验内置规则完整性（一般不需要）
ocr delegate rule src/a.go src/b.go   # 看某文件最终会命中哪条规则 + 分组
```

`ocr delegate rule` 是预览"这条规则会不会影响这文件"最快的工具——它显示每个文件命中的 source/pattern/rule 文本。

## 25.9 坑点

1. **规则文件解析失败会清空该条**：`resolveRuleEntries` 读文件失败会把 `Rule` 置空并 warning——你写 `"rule": "./team-rules/go.md"` 但路径不存在时，这条规则静默消失。
2. **相对路径基于仓库根**：规则文件在子目录，但 `rule` 引用按仓库根解析（#287 后 RepoDir 锚定 toplevel）。
3. **项目规则文件必须在仓根**：`.opencodereview/rule.json` 只读仓根那份，monorepo 子目录的不会被读（`system_rules.go:352` 注释明确）——要放子项目规则用 `--rule` 或在仓根合并。
4. **扩展名白名单默认不含 `.ftl`/`.vue`**：想审记得用 include 放行（见 25.3）。
5. **`merge_system_rule` 只对命中的 entry 生效**：没命中就不拼接。
