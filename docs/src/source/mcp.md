# 15. MCP 客户端扩展

`internal/mcp/` 让 OCR 作为 **MCP 客户端**（不是 server）去连外部 MCP server，把 server 暴露的工具注册进 OCR 的工具注册表，从而让 review Agent 能用**你自己定义的任何工具**——比如查内部工单、读部署平台状态、搜私有知识库。

## 15.1 文件清单

| 文件 | 职责 |
|------|------|
| `client.go` | `Client`：stdio/remote 两种连接 + `CallTool` |
| `provider.go` | `RegisterAll`：把 MCP server 的 tools 注册进 OCR 的 `tool.Registry` |
| `stdio_test.go` / `client_test.go` | 测试 |

## 15.2 两种 transport

### stdio（本地子进程）

`client.go:27 NewClient`：

```go
cmd := exec.Command(command, args...)
cmd.Env = append(os.Environ(), env...)
if dir != "" { cmd.Dir = dir }

client := mcp.NewClient(&mcp.Implementation{Name: "open-code-review", Version: version}, nil)
transport := &mcp.CommandTransport{Command: cmd}
session, err := client.Connect(ctx, transport, nil)
...
toolsResult, err := session.ListTools(ctx, nil)
```

- 用官方 `github.com/modelcontextprotocol/go-sdk` 的 `CommandTransport` 起子进程。
- `cmd.Env = append(os.Environ(), env...)`——server 进程继承 OCR 的环境，外加你配置的 env。
- ctx 只管初始化超时（`review_cmd.go` 里 30s），**子进程生命周期**由 `Close()` 管理。
- `NewClient` 立刻 `ListTools` 拿全部工具列表缓存进 `Client.tools`。

### remote（Streamable HTTP）

`client.go:68 NewRemoteClient`：

```go
// headers 支持 $ENV_VAR 展开
expanded[k] = os.Expand(v, os.Getenv)
if expanded[k] == "" { return error "header expanded to empty value" }

httpClient := &http.Client{Transport: &headerTransport{base: http.DefaultTransport, headers: expanded}}
transport := &mcp.StreamableClientTransport{Endpoint: url, HTTPClient: httpClient}
```

- **header 环境变量展开**：`Authorization: "Bearer $MY_TOKEN"` → 展开 `MY_TOKEN`。空值直接报错，防止"静默发空 token"。
- `headerTransport.RoundTrip` 特殊处理 401/403，把 MCP server 的认证错误转成可读的 Go error（`client.go:139`）。
- 用官方 Streamable HTTP transport 连远程 MCP 服务器。

## 15.3 `RegisterAll`：工具桥

`provider.go` 里（化简）：

```go
func RegisterAll(reg *tool.Registry, mc *Client, filterNames []string) error {
    for _, t := range mc.Tools() {
        name := t.Name
        if filterNames != nil && !contains(filterNames, name) { continue }  // 只注册允许的工具
        if tool.IsReserved(name) { continue }   // 不能覆盖内置六件套

        reg.Register(MCPToolProvider{mc: mc, name: name})
    }
    return nil
}
```

`MCPToolProvider.Execute` 调 `mc.CallTool(ctx, name, args)`：

```go
func (c *Client) CallTool(ctx, name, args) (string, error) {
    result, err := c.session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
    if err != nil { return "", fmt.Errorf("call MCP tool %q: %w", name, err) }
    if result.IsError {
        return fmt.Sprintf("MCP tool %q returned an error: %s", name, contentToText(result.Content)), nil
    }
    return contentToText(result.Content), nil
}
```

`contentToText` 只认 `*mcp.TextContent`，其它类型输出 `[unsupported content type: %T]`。

## 15.4 与内置工具的交互

在 `llmloop.executeToolCall`（`loop.go:279`）里：

```go
if !t.IsKnown() {
    p, ok := r.deps.Tools.Get(call.Function.Name)
    if !ok { return tool.Of(NotAvailableMsg) }
    ...
    result, err := p.Execute(ctx, dynArgs)   // ← MCP 工具在这里被执行
    ...
}
```

MCP 注册的工具走的是"未知工具"分支。所以：

1. MCP 工具**不区分 plan/main 阶段**——`RegisterAll` 全部注册，但 `review_cmd.go:161` 会把 MCP tool defs 同时 append 进 `PlanToolDefs` 和 `MainToolDefs`，所以 LLM 在 plan 阶段也能看到（plan 阶段不执行，只是 reference）。
2. **tool call schema 从 MCP server 拿**：`mcp.CollectToolDefs(mcpClients, tools)` 把 server 的工具 schema 转成 OCR 的 `llm.ToolDef`（OpenAI 风格）。
3. **`tool.IsReserved` 防冲突**：MCP 不能注册 `task_done`/`code_comment` 等保留名。

## 15.5 config.json 里的 MCP 配置

`Config.MCPServers` 字段，每条：

```json
{
  "mcp_servers": {
    "my-tools": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@myorg/mcp-tools"],
      "env": { "MY_TOKEN": "$MY_TOKEN" },
      "tools": ["search_issues"],           // 可选：只注册这几个
      "setup": "npm ci"                     // 可选：启动前跑
    },
    "remote-ai": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer $REMOTE_MCP_TOKEN" },
      "tools": ["gen_review"]
    }
  }
}
```

`review_cmd.go:338 initMCPClients` 的启动逻辑：

- 按名字排序（确定性顺序）。
- `remote`：URL 必须非空；连接失败只 WARNING 跳过（不阻塞 review）。
- `stdio`：`command` 必须非空；`setup` 先跑（`shellCommand` + 5 分钟超时 + `configureProcessGroup`），失败跳过该 server 但 review 继续。
- 每个 server 连上后 `mcp.RegisterAll(tools, mc, serverCfg.Tools)` 注入。

> 注意：所有 MCP server 的**启动失败都是软失败**——OCR 不因 MCP 挂掉而挂掉整次 review。这是刻意的降级设计。

## 15.6 坑点

1. **stdio server 必须能自启动**：它被 `exec.Command` 以 OCR 的环境跑，`command` 必须是 PATH 里的可执行文件，或者给绝对路径。`setup` 步骤用于首次构建依赖。
2. **MCP 工具执行慢会拖 LLM 循环**：内置工具都是毫秒级，MCP 工具如果调远程 API 可能秒级——LLM 每一轮都要等它。如果你加一个慢工具，考虑在 prompt 层面（rule/background）告诉模型"谨慎调用"。
3. **`$ENV_VAR` 展开是 `os.Expand`**：`$VAR` 和 `${VAR}` 都支持，但 `$$` 会被解析成空+字面量（`os.Expand` 语义）。
4. **不要注册敏感工具**：MCP 工具把参数直接透传给 server，如果你注册了 `git push` 类工具，LLM prompt injection 可能利用它（尤其 CI 场景，见 33 章安全）。

## 15.7 何时用 MCP

- **私有数据**：内部工单/发布/部署状态 → 暴露成 MCP 工具，review Agent 才能读到。
- **审查特殊生态**：你的仓有领域特定工具（如专有 linter 检查器）。
- **让 review 更懂业务**：把"这个 service 的 owner 是谁"、"这个 API 是否 deprecated"这类业务事实暴露成工具。

OCR 本身不提供服务端实现——要暴露你自己的工具，需要你自己写一个 MCP server（任意语言，符合 MCP 协议即可）。
