# WorkBuddy × DeepSeek Harness 接入开发文档

> 把 WorkBuddy 的订阅模型接进 DSH，让 DSH 的 agent loop 用 WorkBuddy 的模型跑。
> 形态：`dsh 插件`（bundle：llm-pi-ai 手写网关路由 + 安装器）+ `workbuddy 插件`（会话捕获/桥的控制面）。
>
> 文档版本：0.4 · 2026-10-19 · 对应 DSH 0.2.1-rc.2（desktop）/ WorkBuddy 5.6.x
>
> **0.4 变更**：新增设置页（`settings.section`），把「装 mitmproxy / 装 CA / 开抓包 / 还原代理」搬进 UI，见 §9.7。
>
> **0.3 变更**（本机实测后修正）：
> 1. DSH 的 `llm-pi-ai` 本身就支持**手写网关**（`api` / `baseURL` / `models` / `headers` / `apiKeyEnv`），
>    不需要自研 `LlmAdapter`。插件形态因此从"适配器包"改为"**bundle 补丁 + 安装器**"。
> 2. 凭证引用走 harness 的 `credentials` 服务（`$DSH_HOME/.credentials.yaml` 的 `refs:`），
>    比塞进环境变量更稳，且支持热更新。
> 3. 已在真实运行时上跑通：DSH agent loop → `llm-pi-ai` → bridge → SSE → 回复（见 §11.3）。
>
> **0.2 变更**：凭证从「官方 API Key 优先」改为「本机抓包 + 转发优先」。
> 不申请 API Key、不调用官方 API、不解密登录文件。

---

## 0. 结论先行

四个关键判断：

1. **WorkBuddy 上游本身就是 OpenAI Chat Completions 协议**（`POST /v2/chat/completions`），
   所以不需要"翻译协议"，只需要"拿到鉴权 + 补标识头 + 收敛请求结构"。
2. **鉴权拿不到磁盘上的明文**。WorkBuddy 5.6.0 起登录文件是 AtRest（AES-256-GCM）信封，
   密钥只在客户端进程内，进程外读取必失败（本机实测确认，见 §6.1）。
   所以走**本地抓包**：客户端自己发请求时带着 `Authorization`，把它截下来复用。
3. **不能直连上游，但也不需要写适配器**。上游强制 `User-Agent`、`X-User-Id` 等一组标识头，
   DSH 的归属头会覆盖配置里的同名头——所以中间必须有一个本地网关负责注入。
   而 DSH 的 `llm-pi-ai` 已经提供"手写网关"路由，**协议转换、流式解析、工具调用分片、
   重试、用量账本全由它负责**，我们只写配置。
4. **插件的价值在"装得对 + 桥在跑"**：把路由补丁写进 profile、把令牌登记进凭证服务、
   保证 bridge 常驻。这三件事用一个 bundle + 一个安装器解决。

需要说清楚的一点：**"不调用 API"指的是不申请、不使用 API Key**。桥仍然会向
`copilot.tencent.com` 发请求，只是带着从客户端抓来的同一组会话头——这在语义上是
**转发/复用会话**，不是以独立身份调用 API，也不会额外开一份配额。

最终形态：

```
DSH agent loop
   └─ ctx.llm.stream()                  ← DSH 的模型接缝
        └─ @deepseek-ai/dsh-llm-pi-ai   ← DSH 自带适配器（api: openai-completions）
             └─ HTTP 127.0.0.1:8790/v1
                  └─ bridge             ← 薄网关：会话复用 + 结构归一化 + 流式转发
                       └─ https://copilot.tencent.com/v2/chat/completions
                              ▲
                              │ 只读请求头（旁路）
                    mitmproxy 8899
                              ▲
                    WorkBuddy 客户端自己的请求
```

`workbuddy 插件` 不承载模型流量，只做控制面：会话开始时确保 bridge 在跑、
提供 `capture_status` / `bridge_health` / `bridge_models` 三个只读 MCP 工具。

现有可直接借鉴的开源实现（详见 §15）：

| 项目 | 形态 | 关键点 |
|---|---|---|
| `Ianzhyh/workbuddy-to-dsh` | 本地桥 + DSH 原生插件 | 8790 端口、AtRest 解密（借客户端原生绑定）、三协议 |
| `Acoder416/dsh-plugin-workbuddy-gateway` | DSH 插件内嵌网关 | 18088 端口、多账号、积分/签到、限流冷却 |
| `@magpie-community/opencode-workbuddy-auth` | OpenCode 认证插件 | 上游必需头的权威清单、`/v3/config` 模型目录 |

---

## 1. 目标与非目标

### 1.1 目标

- DSH 的模型选择器里出现 `workbuddy` 路由，可选当前账号下的模型。
- **凭证零申请**：不创建 API Key，不解密登录文件，靠本机抓包拿到会话。
- 流式输出、工具调用（function calling）、推理内容（reasoning）三条链路都可用。
- 设置页能看到会话是否抓到、什么时候过期、模型目录；出问题能定位到具体错误码。
- 单机、单账号、只监听回环地址。

### 1.2 非目标

- 多账号池化、转售、对外提供 API 服务。
- embedding / rerank（上游没有，固定返回 501）。
- 图片输入（除显式声明的多模态模型外，默认按纯文本处理）。
- 修改 WorkBuddy 客户端的任何文件。
- 绕过登录/鉴权：抓包只复用**已登录客户端**自己发出的会话。

---

## 2. 技术事实（调研结论）

| # | 事实 | 影响 |
|---|---|---|
| 1 | 上游是 `POST https://copilot.tencent.com/v2/chat/completions`（国际版 `https://www.workbuddy.ai/v2`） | 协议层是薄转发，不是翻译 |
| 2 | 鉴权用 `Authorization: Bearer <token>`；token 来自客户端登录会话 | 抓包即可获得 |
| 3 | 必需业务头：`X-User-Id`、`X-Domain`、`X-Product: SaaS`、`X-IDE-Type: WorkBuddy`、`User-Agent: WorkBuddy/5.5.6`；缺失返回 **10085** | 必须整组复用，不能只拿 token |
| 4 | 上游**拒绝非流式**请求 | 强制 `stream: true` |
| 5 | 上游**没有** `/models`、没有 embeddings、没有 Responses/Anthropic 协议 | 模型目录要自己维护；协议要自己转 |
| 6 | 模型目录来自 `GET /v3/config`（含上下文、图片输入、推理档位） | 动态目录 + 静态兜底 |
| 7 | 桌面登录文件在 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\` | 只做兜底，且通常不可读 |
| 8 | WorkBuddy 5.6.0 起登录文件是 AtRest AES-256-GCM 信封，密钥只在进程内 | 进程外读不到 → 抓包成为主路径 |
| 9 | token 有效期：桌面约 45 天，浏览器授权约 1 小时；客户端会自行刷新 | 抓包可自动跟随刷新 |
| 10 | DSH 的模型接缝是 `ctx.llm.stream()`；provider 路由由适配器注册。`llm-pi-ai` 支持手写网关，不必自研 | 只需写配置 |
| 11 | DSH 的 `StreamChunk` 是封闭联合：`block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish` | 映射目标明确 |
| 12 | DSH 的 `llm-pi-ai` 支持 provider 级 `headers`，但 **User-Agent 由 harness 决定，自定义同名头会被过滤** | 决定性约束 |
| 13 | 插件包 = `package.json` 的 `dsh.bundle` + `cordis.patch.yml` + host/client 两半 | 打包方式明确 |

### 2.1 30 秒验证抓包是否成功

```bash
# 1) bridge 已启动
curl -s http://127.0.0.1:8790/health | jq '.auth, .capture'

# 2) 在 WorkBuddy 里发一条消息，然后看会话
curl -s http://127.0.0.1:8790/capture/status
# 期望：{"captured":true,"source":"mitmproxy","expiresAt":"...","userId":"..."}
```

`captured: true` 就说明整组头已经拿到，剩下的都是本地逻辑。

---

## 3. 三条路线怎么选

| 路线 | 做法 | 优点 | 问题 | 结论 |
|---|---|---|---|---|
| A. 纯配置直连 | DSH 设置里加自定义 provider + `headers`，`baseURL` 指向上游 | 零代码 | UA 被 harness 归属头覆盖；跨域/证书/标识头组合校验过不去 | 不可行 |
| B. 自研 LLM 适配器 | 插件里 `registerAdapter`，自己发请求 | 完全掌控 | 要自己实现九条 adapter 契约、九类 StreamChunk 映射、工具分片、重试 | 不必要 |
| C. 本地网关 + 抓包 | 127.0.0.1 起 OpenAI 兼容服务，复用抓到的会话 | 任何客户端都能用，协议归一化集中一处 | 多一个进程 | **采用** |
| D. 本地网关 + DSH 手写网关路由 | C + `llm-pi-ai` 的 `providers.workbuddy` | 复用 DSH 全部原生管线，插件只剩配置 | 模型目录要显式列出 | **采用** |

实际采用 **D = C + 配置**：C 做地基（会话复用、请求归一化、错误映射集中在一处），
D 让 DSH 用它自带的适配器把 bridge 包装成一条 provider route。
B 被放弃的原因见 §9.1——`llm-pi-ai` 已经把适配器该做的事做完了。

---

## 4. 总体架构

```
┌──────────────────────────── DSH 进程 ────────────────────────────┐
│                                                                  │
│  agent loop ──► ctx.llm.stream({provider:'workbuddy', model, ...})│
│                        │                                         │
│                        ▼                                         │
│         @deepseek-ai/dsh-llm-pi-ai  （DSH 自带）                  │
│         └─ providers.workbuddy（本插件写入的配置）                 │
│              api: openai-completions                             │
│              baseURL: http://127.0.0.1:8790/v1                   │
│              apiKeyEnv: WORKBUDDY_BRIDGE_TOKEN                   │
│                        │                                         │
└────────────────────────┼─────────────────────────────────────────┘
                         │ HTTP 127.0.0.1:8790
┌────────────────────────▼─────────────────────────────────────────┐
│  workbuddy-llm-bridge（独立进程，零依赖）                          │
│  ├─ 本地令牌校验                                                  │
│  ├─ 会话复用：抓包来的 Authorization / X-* / Cookie                │
│  ├─ 请求归一化：developer→system / tool_choice / 首条 system       │
│  ├─ 模型目录：/v3/config 解析 + 静态兜底                           │
│  └─ SSE 原样转发（不缓冲、不改帧）                                 │
└───────────────────────────────────────────────┬──────────────────┘
                                                │ HTTPS
                                                ▼
                              copilot.tencent.com/v2/chat/completions
                                                ▲
                                                │ 客户端自己的请求（只读头，不改内容）
┌───────────────────────────────────────────────┴──────────────────┐
│  mitmproxy 127.0.0.1:8899  ──POST /capture/session──►  bridge     │
└───────────────────────────────────────────────▲──────────────────┘
                                                │
                                     WorkBuddy 客户端（已登录）
```

### 4.1 为什么桥不直接返回 StreamChunk

桥要说 OpenAI 协议——这样 Claude Code、Codex、opencode 也能复用；
DSH 的 `StreamChunk` 是 harness 私有词汇，只应出现在 DSH 内部的适配器里。
**协议转换放在最靠近消费者的地方**，桥保持"通用网关"的身份。

### 4.2 为什么抓包只"抄头"而不是"代理整条会话"

把 DSH 的请求塞进客户端的同一条 TLS 连接在工程上既不可控也不可靠
（HTTP/2 多路复用由客户端调度，拿不到句柄）。可靠且等价的做法是：
**抄下客户端当时用的整组请求头，用新的连接发同样的请求**。
对上游来说，这是同一个账号、同一套标识，与客户端自己发的请求没有区别。

### 4.3 进程模型

| 模式 | 谁拉起桥 | 适用 |
|---|---|---|
| 托管（默认） | DSH 插件用 `spawn` 拉起，卸载时 `kill` | 单机日常使用 |
| 独立 | 用户/计划任务常驻，插件只连 | 多客户端共用、需要长期在线 |
| 离线 mock | `WORKBUDDY_MOCK=1` | 联调链路时不需要真账号 |

插件启动时先探 `/health`：通了就复用，没通才拉起。

---

## 5. 上游协议契约（WorkBuddy 侧）

### 5.1 端点

| 用途 | 方法/路径 | 说明 |
|---|---|---|
| 对话 | `POST /v2/chat/completions` | 只接受 `stream: true` |
| 模型目录 | `GET /v3/config` | 返回 CLI agent 的产品配置，含模型能力 |
| 余额 | 客户端内部接口 | 非必需，做用量展示时才接 |
| embeddings | 无 | 返回 501 |

### 5.2 请求头

```
Authorization: Bearer <token>          ← 抓包获得
Content-Type: application/json
Accept: text/event-stream
User-Agent: WorkBuddy/5.5.6            ← 抓包获得（版本号跟随客户端）
X-Product: SaaS
X-IDE-Type: WorkBuddy
X-Domain: copilot.tencent.com
X-User-Id: <uid>
Cookie: ...                            ← 有则带上
```

**整组复用**比"只复制 token"稳：上游对 UA 版本、X-User-Id、Cookie 的组合有校验，
单独补 token 很容易 10085 或 401。

### 5.3 请求体归一化

上游比 OpenAI 规范更严，下面每一条都对应一个真实报错：

| 输入 | 处理 | 不处理的后果 |
|---|---|---|
| `role: developer` | 改写成 `system` | 400 / 11128 |
| 首条不是 `system` | 前插一条默认 system | 400 / 11128 |
| `tool_choice` 是对象 | 收敛成 `auto` / `required` / `none` 字符串 | 400 |
| `stream: false` | 强制 `true` | 上游拒绝 |
| `max_completion_tokens` | 删除，统一用 `max_tokens` | 参数冲突 |
| 空 `tools: []` | 删除该字段 | 部分模型报错 |
| `stream_options` | 删除 | 不识别 |

实现见 `packages/bridge/server.mjs` 的 `normalize()`。

### 5.4 流式响应

```json
{"id":"...","choices":[{"index":0,"delta":{"content":"你"},"finish_reason":null}]}
{"id":"...","choices":[{"index":0,"delta":{"reasoning_content":"思考..."}}]}
{"id":"...","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"read_file","arguments":"{\"pa"}}]}}]}
{"id":"...","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}
data: [DONE]
```

三个要点：

1. `reasoning_content` 是独立字段，不能混进 `content`。
2. `tool_calls[].index` 是**上游的工具调用序号**，必须映射成 DSH 的块 index，不能直接用。
3. `usage` 可能出现在最后一个 chunk，也可能单独一帧——`llm-pi-ai` 会缓冲到流结束再发。

### 5.5 模型目录

`GET /v3/config` 返回的模型带 `contextWindow`、`input`、推理档位。桥把它转成
OpenAI `/v1/models` 形状；抓取失败时回退到静态清单：

```
deepseek-v4-flash / deepseek-v4-pro / glm-5.3 / glm-5.3-flash
kimi-k3 / minimax-m3 / hy3 / hy4-preview
```

模型名**全小写**，大小写不对会 11102。

### 5.6 错误码映射

| 上游 | 含义 | 桥返回 | 路由侧 code | 处置 |
|---|---|---|---|---|
| 401 | 会话失效 | 401 | `AUTH` | 重新抓包（发一条消息） |
| 403 | 无权限 | 403 | `FORBIDDEN` | 换账号/换模型 |
| 429 / 6004 | 限流 | 429 | `RATE_LIMIT` | 读 `Retry-After`，退避 |
| 10085 | 标识头缺失 | 401 | `AUTH` | 检查 UA / X-* 是否整组复用 |
| 11102 | 模型不可用 | 502 | `MODEL_NOT_FOUND` | 校正模型 id |
| 11128 | 请求结构不认 | 502 | `BAD_REQUEST` | 回到归一化 |
| 11140 | 账号被风控 | 502 | `ACCOUNT_RESTRICTED` | 只能联系官方 |
| 502/503/504 | 上游网关故障 | 502 | `SERVER` | 重试/换模型 |

---

## 6. 会话捕获（核心）

### 6.1 为什么必须抓包

三条路，只有一条通：

| 路径 | 结果 |
|---|---|
| 读登录文件 | 5.6.0+ 是 AES-256-GCM 信封，密钥只在客户端进程内 → 读不到 |
| 申请 API Key | 用户明确要求不走这条 |
| **抓客户端自己的请求** | 头就在明文 HTTP 里，侧路可读 → **可行** |

本机实测（`packages/bridge/credentials.mjs` 对加密文件的处理）：

```
{"ok":false,"error":"登录文件已加密（AtRest），无法直接读取: ...workbuddy-desktop.info"}
```

### 6.2 三种抓法

| 方式 | 成本 | 稳定性 | 适用 |
|---|---|---|---|
| **MITM 代理（推荐）** | 装一次 CA、重启一次客户端（注入 `HTTP_PROXY`） | 高，能看到完整头 | 日常 |
| CDP 远程调试 | 客户端要以 `--remote-debugging-port` 启动 | 中，取决于版本是否允许 | 不想装 CA 时 |
| 手工复制 | 从 DevTools/Charles 复制 cURL | 低，只能一次性 | 应急验证 |

本仓库实现第 1 种（`packages/capture/mitm_addon.py`），第 3 种用
`curl -X POST /capture/session` 也能手工灌入。

### 6.3 抓什么

只抓两类请求，命中即上报一次：

- `*/v2/chat/completions`（对话，必带 Authorization）
- `*/v3/config`（模型目录，顺带拿 UA 版本）

字段白名单（`session.mjs` 的 `ALLOWED`）：
`authorization / cookie / user-agent / x-user-id / x-domain / x-product / x-ide-type /
x-request-id / x-trace-id / x-client-version / x-tenant-id / origin / referer / accept-language`。

**不带** `content-length`、`host`、`accept-encoding`——重放时由新的连接自己决定，
带过去反而会出错。

### 6.4 上报与存储

```
mitmproxy addon ──POST /capture/session──► bridge
                 header: x-capture-key
                 body: { headers, source, path }
```

- 上报必须带 `x-capture-key`（`packages/bridge/.capture-key`，0600）。它只防同机误用。
- 会话**默认只存内存**；`WORKBUDDY_PERSIST=1` 才落盘到 `.session.json`（0600）。
- `expiresAt` 从 JWT 的 `exp` 解析；解析不到就标记为 `null`，由上游 401 兜底。
- 同一个 token 只上报一次（addon 内做 sha256 去重），不会每个请求都打一次本地 HTTP。

### 6.5 过期与刷新

| 来源 | 有效期 | 失效表现 | 处理 |
|---|---|---|---|
| 桌面登录 token | 约 45 天 | 401 | 再抓一次（客户端发消息即触发） |
| 浏览器授权 token | 约 1 小时 | 401 | 客户端刷新时自动重新捕获 |

客户端刷新 token 时会发新请求，addon 的 401 回调会清掉去重缓存，下一次请求自动重新上报。
所以只要客户端在正常使用，会话基本不会断；长期闲置后回客户端发一条消息即可。

### 6.6 安全边界

- 抓包层与桥都只监听 `127.0.0.1`。
- 抓包层只读请求头，**不修改**请求和响应，不写 pcap、不落盘正文。
- 日志只记元数据（状态码、模型、耗时、token 数），不记 prompt / completion / token。
- `/health` 与 `/capture/status` 只回长度、来源、过期时间，绝不回明文。
- 这套做法依赖未公开接口，客户端升级可能失效；不要外传 token，不要在截图里露出请求头。

---

## 7. WorkBuddy 侧插件：控制面

### 7.1 为什么是 MCP + Hook，而不是"插件里跑服务"

WorkBuddy 插件（`.codebuddy-plugin/plugin.json`）的扩展点是
`commands / skills / hooks / agents / mcpServers`，没有"常驻 HTTP 服务"这一项。
所以正确分工是：

- **bridge**：独立 Node 进程（零依赖），承载所有模型流量。
- **capture**：独立 mitmproxy 进程，只在上报时写一次本地 HTTP。
- **workbuddy 插件**：`SessionStart` 钩子确保 bridge 在跑；MCP 提供只读诊断；
  skill 写排查路径；command 提供 `/bridge` 快捷入口。

这样插件本身很轻，不会因为 WorkBuddy 的插件生命周期被反复启停而影响正在跑的对话。

### 7.2 目录结构

```
workbuddy-plugin/
├── .codebuddy-plugin/plugin.json     # 插件清单
├── hooks/hooks.json                  # SessionStart → ensure-bridge
├── hooks/ensure-bridge.mjs           # 探活 + 后台拉起
├── mcp/server.mjs                    # stdio MCP：三个只读工具
├── skills/workbuddy-bridge/SKILL.md  # 排查知识
└── commands/bridge.md                # /bridge
```

### 7.3 清单要点

```json
{
  "name": "workbuddy-llm-bridge",
  "hooks": "./hooks/hooks.json",
  "skills": "./skills",
  "commands": "./commands",
  "mcpServers": {
    "workbuddy-bridge": {
      "command": "node",
      "args": ["${CODEBUDDY_PLUGIN_ROOT}/mcp/server.mjs"],
      "env": { "WORKBUDDY_BRIDGE_URL": "http://127.0.0.1:8790" },
      "defer_loading": true
    }
  }
}
```

`defer_loading: true` 让 MCP 工具按需加载，不占用每轮上下文。

### 7.4 工具边界

| 工具 | 读什么 | 返回 |
|---|---|---|
| `capture_status` | `/capture/status` | 是否抓到、来源、过期时间、uid |
| `bridge_health` | `/health` | 模式、上游、凭证类型、错误原文 |
| `bridge_models` | `/v1/models` | 模型 id 列表 |

全部只读；不提供"启动抓包""注入会话"这类写操作——写操作只允许人来做。

---

## 8. Bridge 实现

### 8.1 端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | 无 | 状态、模式、凭证摘要（无明文） |
| GET | `/capture/status` | 无 | 会话是否已捕获、过期时间 |
| POST | `/capture/session` | capture key | 抓包上报入口 |
| DELETE | `/capture/session` | capture key | 撤销当前会话 |
| GET | `/v1/models` | 本地令牌 | 模型目录 |
| POST | `/v1/chat/completions` | 本地令牌 | 流式对话 |
| POST | `/v1/embeddings` | — | 固定 501 |

### 8.2 两把本地钥匙

| 钥匙 | 文件 | 用途 |
|---|---|---|
| 本地访问令牌 | `.bridge-token` | DSH ↔ 桥 |
| 抓包上报密钥 | `.capture-key` | mitmproxy ↔ 桥 |

都是首次启动随机生成、0600、只防同机误用。**不是**上游凭证。

### 8.3 流式转发

```js
const upstream = await fetch(`${UPSTREAM_BASE}/chat/completions`, {
  method: 'POST',
  headers: upstreamHeaders(auth),   // 抓包头 + 兜底头
  body: JSON.stringify(normalize(body)),
  signal: ac.signal,
})

res.writeHead(200, {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  'x-accel-buffering': 'no',       // 关键：别让任何反代缓冲
})

for await (const chunk of upstream.body) res.write(chunk)
```

三条纪律：

1. **不聚合、不改帧**。任何"攒一攒再发"都会让首 token 延迟从百毫秒变成秒级。
2. **流开始后不能改状态码**。此时出错只能写一个 `data: {"error":...}` 再 `end()`。
3. **`AbortSignal` 要跟着客户端断开走**。`res.on('close')` 里 abort 上游，否则用户点了停止，
   上游还在烧额度。

### 8.4 超时

默认 600 秒（长任务、大文件重构）。用 `AbortController` + `setTimeout` 实现，
不要用 `fetch` 的默认超时——它会让长输出在中途断掉。

---

## 9. DSH 侧插件

### 9.1 为什么不用自研适配器

DSH 的 `@deepseek-ai/dsh-llm-pi-ai` 是官方的多提供方适配器，它支持三类路由：
pi-ai 目录里已有的提供方、**手写网关**、以及自托管服务。手写网关的配置面足够覆盖我们的场景：

| 字段 | 我们用它的地方 |
|---|---|
| `api: openai-completions` | 上游就是 OpenAI Chat Completions |
| `baseURL` | 指向 bridge `http://127.0.0.1:8790/v1` |
| `apiKeyEnv` | 引用 bridge 的本地令牌（经 harness 凭证服务解析） |
| `models[].id` | WorkBuddy 的真实模型 ID（`auto` / `deepseek-v4.1-flash` …） |
| `compat.thinkingFormat: deepseek` | 上游把思考放在 `reasoning_content`，按 deepseek 方言解析 |
| `headers` | 预留：需要在 DSH 侧直接补头时用 |

也就是说——流式分片解析、工具调用按 index 组装、usage 账本、重试策略、KV 缓存友好性，
这些原本要自己写、还要满足九条 adapter 契约的东西，**全部由 DSH 自带代码承担**。
我们只需要写一份正确的配置，并保证 bridge 活着。

> 本机实测（§11.3）证明这条路走得通：一次 `headless` 请求完整跑过
> `agent loop → llm-pi-ai → bridge → SSE → 回复`。

### 9.2 包结构

```
dsh-plugin-workbuddy/
├── package.json          # dsh.bundle.patch + locale/icon 显示资源
├── cordis.patch.yml      # 路由补丁（托管块，可被安装器整块替换）
├── models.json           # 模型目录（sync-models 可重新抓取）
├── lib/route.mjs         # 渲染/合并补丁块（安装器与同步脚本共用）
├── install.mjs           # 桌面版安装器：桥 + 凭证 + 补丁，可 --uninstall
├── sync-models.mjs       # 从 bridge /v1/models 重新生成模型目录
├── locale/{zh,en}.json   # Plugin Manager 里显示的名称与描述
└── icon.svg
```

`package.json` 的关键字段：

```json
{
  "exports": {
    "./route": "./lib/route.mjs",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

bundle 是**纯补丁包**，不导出 Host 插件：没有 `apply()`，也就没有模块导入失败的风险，
只会往组合树里插一行配置。这是最小攻击面。

### 9.3 补丁长什么样

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      workbuddy:
        displayName: 'WorkBuddy'
        api: openai-completions
        baseURL: 'http://127.0.0.1:8790/v1'
        apiKeyEnv: 'WORKBUDDY_BRIDGE_TOKEN'
        compat:
          thinkingFormat: deepseek
        models:
          - id: 'auto'
            name: 'Auto（自动选择）'
          - id: 'deepseek-v4.1-flash'
            name: 'DeepSeek V4.1 Flash'
```

三条必须知道的规则：

1. **不要 `insert` 第二行 `llm-pi-ai`**。同一条 route 被两个适配器注册会让 profile 加载失败，
   必须用 `- id: llm-pi-ai` **覆盖**已有那一行（base bundle 里它已挂载，默认零 route）。
2. **覆盖是整块替换**，不是合并。所以安装器会检测补丁里有没有别人写的 `llm-pi-ai`，
   有就要求 `--force`，避免悄悄覆盖用户已有的 provider。
3. **新 profile 的 `cordis.patch.yml` 是裸 `[]`**。直接在其后追加 `- id:` 会变成两个 YAML 根节点，
   解析直接失败（实测量到的坑）。安装器会先摘掉这行再追加。

### 9.4 凭证：用 harness 的凭证服务，不用环境变量

`apiKeyEnv` 是**凭证引用**，由 `ctx.credentials` 按请求解析，解析顺序是：

```
$DSH_HOME/.credentials.yaml 的 refs:  →  启动环境变量  →  项目 .env  →  $DSH_HOME/.env
```

所以安装器把 bridge 令牌写进凭证文件的 `refs:` 段：

```yaml
version: 1
records:
  ...
refs:
  WORKBUDDY_BRIDGE_TOKEN: wb_a6e2...
```

好处：桌面版是 GUI 启动的，改不了它的环境变量；而凭证文件支持**热更新**（watcher 重读），
写完下一个请求就生效。文件权限 0600，且 harness 从不把它物化进进程环境。

> 实测中的一个坑：`headless` profile 的模板把 `credentials` 和 `authorization` 两行
> `disabled: true` 关掉了，此时 `refs:` 完全不生效，只能退化成读环境变量。
> 桌面 profile（`dsh-base` + `dsh-web-app`）没有关，所以桌面端用文件引用是对的；
> 想在 CLI 里验证就必须把 `credentials` 行重新打开。

### 9.5 安装、卸载与自检

```bash
# 桌面版（默认 profile=desktop）
node packages/dsh-plugin-workbuddy/install.mjs
node packages/dsh-plugin-workbuddy/install.mjs --default-model   # 顺手把默认模型设为 workbuddy/auto
node packages/dsh-plugin-workbuddy/install.mjs --uninstall       # 还原
```

安装器做四件事，每一步都可逆（改动前 `.workbuddy-backup-<ts>` 备份）：

1. 探 `127.0.0.1:8790/health`，不在就 detached 拉起 `packages/bridge/server.mjs`，日志写 `bridge.log`
2. 把 `.bridge-token` 写进 `$DSH_HOME/.credentials.yaml` 的 `refs:`
3. **把本包登记成 profile 的 bundle**：`package.json` 的 `dependencies` + `dsh.profile.bundles`，
   再在 `node_modules` 里建目录联接（`fs.symlinkSync(..., 'junction')`，失败则退化为复制）
4. 写路由补丁；登记成 bundle 后路由由 bundle 层提供，此时会摘掉用户补丁里的旧托管块

#### 为什么必须登记成 bundle

`Plugins` 页（`plugin_manager`）列的是 **profile 的 bundles**，不是 Loader 的行。
只往 `cordis.patch.yml` 写一行覆盖，模型选择器里能看到路由，但插件列表里什么都没有——
这就是第一版的现象。

登记成 bundle 后组合树里会出现来源标记：

```
# == @deepseek-ai/dsh-base, patched by dsh-plugin-workbuddy
- id: llm-pi-ai
```

顺带的好处：Plugins 页的开关真的能关掉路由。若路由同时写在 bundle 和用户补丁里，
关掉 bundle 后用户补丁那一份仍然生效，开关就成了摆设——所以安装器在登记成功后
会主动清掉用户补丁里的路由块。

#### 一个容易踩的副作用

在 DSH 里改设置（换默认模型、切主题）时，`config-editor` 会**重写整个
`cordis.patch.yml`**：注释和托管块标记会被抹掉、格式被重排。实测本机改完默认模型后，
文件里只剩 `agent-default-model` 等条目，格式也变成了双引号缩进。
这正是"路由放 bundle 层"的另一个理由——bundle 的 `cordis.patch.yml` 在包目录里，UI 碰不到。

生效方式：桌面 profile 开着 `dsh-hmr`，它监听 profile 清单与用户补丁文件，
**保存即重载**；万一没生效，重启桌面端即可。

### 9.6 模型目录

`models.json` 是唯一事实来源，产物有两份：本包的 `cordis.patch.yml` 和安装到 profile 里的托管块。

```bash
node packages/dsh-plugin-workbuddy/sync-models.mjs            # 从 bridge /v1/models 抓
node packages/dsh-plugin-workbuddy/sync-models.mjs --offline  # 只重渲染
```

DSH 侧不会自动发现模型（手写网关要求显式 `models` 列表），所以上游换模型后要跑一次同步。

### 9.7 设置页：把抓包环境搬进 UI

光有路由还不够——用户还得自己装 mitmproxy、导 CA、让客户端走代理、起 mitmdump。
这四步全是环境操作，塞进 README 没人会照着做，所以做成一个设置页。

**客户端半体**（`client.js`）注册到 `settings.section` 槽，导航里是一个 `WorkBuddy` 页：

```js
window.__ModuleLoader__.load({
  id: 'dsh-plugin-workbuddy',
  factory(require) {
    const React = require('react')
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'workbuddy', order: 50,
          label: () => 'WorkBuddy',
        }, Panel))
      },
    }
  },
})
```

`package.json` 里对应加两处，缺一个客户端就静默不加载：

```json
"exports": { "./client": "./client.js" },
"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings"] } }
```

`inject` 里写 `dsh-client-ui-settings` 是因为 `settings.section` 这个槽由它声明；
不声明依赖就可能注册到一个还不存在的槽上。

补丁里还要给客户端挂一个**可寻址的行**，Client 模块按包名加载：

```yaml
- insert:
    - id: workbuddy-ui
      name: 'dsh-plugin-workbuddy'
```

**Host 半体**（`lib/index.js`）只有 `export function apply() {}`——面板不发 RPC，
所有动作都打 bridge 的 HTTP 管理接口：

| 面板动作 | 接口 | 关键实现 |
|---|---|---|
| 读状态 | `GET /setup/status` | Python 探测、mitmdump 版本、CA 是否已信任、代理/抓包状态、日志尾部 |
| 安装环境 | `POST /setup/install` | `python -m venv .tools/mitm` + `pip install mitmproxy`（异步任务，UI 轮询） |
| 装证书 | `POST /setup/ca` | `certutil -user -addstore -f Root`，免管理员 |
| 开始抓包 | `POST /capture/start` | `mitmdump -s <addon> --listen-host 127.0.0.1`，等端口就绪再返回 |
| 停止抓包 | `POST /capture/stop` | `taskkill /T /F` 整棵进程树 + 按接管前的环境重新拉起客户端 |
| 代理开关 | `POST /proxy` | 重启客户端注入 `HTTP_PROXY`（`workbuddy-client.mjs`），不写注册表；接管状态存 `.launch-state.json` |

三个设计取舍：

1. **面板不持有状态**。全部以 `/setup/status` 为准，2 秒轮询；mitmdump 崩了、装到一半失败，
   界面下次刷新就能看到，不存在"UI 说已连接、实际没连"的漂移。
2. **管理接口不是鉴权，是 CSRF 护栏**。要求 `x-bridge-admin: 1` 且 `Origin` 是回环地址；
   浏览器跨站请求带不了自定义头，跨站页面就被挡在预检之外。真正敏感的东西仍然只有
   `127.0.0.1` 上的令牌。
3. **代理原值必须可还原**。第一次开启前把 `ProxyEnable/ProxyServer/ProxyOverride` 存盘，
   停止时按原值写回；中途失败也有 `.proxy-backup.json` 兜底。

> 实测：`POST /setup/install` 在这台机器上把 mitmproxy 12.2.3 装进了独立 venv（约 110MB），
> `POST /capture/start` 起在 `127.0.0.1:8899` 并生成了 CA 文件，`stop` 能干净收尾。
> 代理开关那段在本沙箱里测不了（`reg.exe` 被安全策略拦），留待真机验证。

---

## 10. 全链路时序（含工具调用）

```
DSH loop          llm-pi-ai            Bridge                Upstream
  │                    │                    │                     │
  ├─ stream(opts) ────►│                    │                     │
  │                    ├─ 解析 route 配置     │                     │
  │                    ├─ apiKeyEnv → 令牌    │                     │
  │                    ├─ POST /chat ──────►│                     │
  │                    │                    ├─ normalize()        │
  │                    │                    ├─ 取抓包会话          │
  │                    │                    ├─ 复用头 + UA ──────►│
  │                    │                    │◄── SSE delta ───────┤
  │                    │◄── SSE ────────────┤                     │
  │◄─ reasoning-delta ─┤                    │                     │
  │◄─ text-delta ──────┤                    │                     │
  │◄─ tool-call-delta ─┤                    │                     │
  │◄─ usage ───────────┤                    │                     │
  │◄─ finish(stop) ────┤                    │                     │
  │                    │                    │                     │
  ├─ 执行工具（本地/远程）                                          │
  ├─ 下一 step 带上 tool_result 重新 stream ────────────────────────►
```

工具调用的参数是**流式拼**出来的：上游可能把 `{"path":"a.txt"}` 拆成
`{"pa` / `th":"a` / `.txt"}`。分片重组成块由 `llm-pi-ai` + harness 的
`BlockAssembler` 负责——这正是"不自己写适配器"省下来的那部分工作。

---

## 11. 测试与验收

### 11.1 分层测试

| 层 | 方法 | 通过标准 | 状态 |
|---|---|---|---|
| 会话层 · 上报 | `POST /capture/session` 带/不带 key | 带 key 200，不带 401 | ✅ 已过 |
| 会话层 · 白名单 | 上报含 `content-length`/`host` | 被过滤，不出现在 headers 列表 | ✅ 已过 |
| 会话层 · 过期 | 伪造 `exp` 过去的 JWT | 解析出 `expiresAt` | ✅ 已过 |
| 会话层 · 撤销 | `DELETE /capture/session` | 状态回到 `captured:false` | ✅ 已过 |
| 桥 · 单元 | `WORKBUDDY_MOCK=1`，curl `/v1/chat/completions` | 完整 SSE，`[DONE]` 收尾 | ✅ 已过 |
| 桥 · 鉴权 | 不带/带错本地令牌 | 401，错误码 `LOCAL_AUTH` | ✅ 已过 |
| 桥 · 归一化 | `developer` / 对象 `tool_choice` / 无 system | 转发体符合 §5.3 | ✅ 已过 |
| 补丁 · 解析 | 真实运行时 `--dump-config` | 组合树里出现 workbuddy route | ✅ 已过 |
| **端到端** | headless profile 跑一次 agent 请求 | 回复来自 bridge | ✅ 已过 |
| 端到端 · 真实上游 | 抓包后 DSH 里发消息 | 真实模型回复 | ⏳ 需抓包 |
| 抓包端到端 | 开代理 → 客户端发消息 → DSH 发消息 | 中途不重启、不重抓 | ⏳ 需抓包 |

### 11.2 验收清单

- [ ] `capture/status` 显示 `captured:true`，来源为 `mitmproxy`
- [ ] 停止接管后 DSH 仍能对话（说明会话已复用，不依赖代理常开）
- [x] DSH 模型选择器出现 `WorkBuddy` 路由，15 个模型可选
- [ ] 首 token 延迟 < 1.5s（不含上游排队）
- [ ] 回复结束有 usage，token 数与上游一致
- [ ] 工具调用能触发、能回传结果、能继续下一轮
- [ ] 界面点停止后，bridge 日志显示上游请求被 abort
- [x] `/health` 明确区分「桥在服务」与「凭证是否就绪」（`ok` / `authReady`）
- [ ] 拔掉网络后报错可读，不是"未知错误"
- [x] 卸载（`install.mjs --uninstall`）能移除补丁块与凭证引用

### 11.3 已跑通的证据

用本机安装的 DeepSeek Harness 真实运行时（`app.asar` 里的 0.2.1-rc.2）
建了一个临时 headless profile，装上同一份路由补丁，跑了一次 agent 请求：

```
$ node tools/dsh-selftest.mjs
DSH × WorkBuddy bridge 自测
  ✓ bridge :8791 mode=mock
  ✓ profile selftest 已创建
  ✓ agent 回复来自 bridge: Hello from WorkBuddy bridge.

通过：DSH agent loop → llm-pi-ai(workbuddy) → bridge → SSE 全链路可用
```

这条自测同时验证了三件容易出错的事：

1. `llm-pi-ai` 接受了这份手写网关配置（`api` / `baseURL` / `models` / `compat` 全部通过 schema 校验）；
2. `apiKeyEnv` 引用能从 `$DSH_HOME/.credentials.yaml` 的 `refs:` 里解析出来（不是只认环境变量）；
3. DSH 的 `agent-default-model` 指向 `workbuddy/auto` 时，请求真的落到了 bridge。

复跑方式：`node tools/dsh-selftest.mjs`（首次会从 `app.asar` 解包运行时到 `.cache/`，约 1 分钟）。
它不碰你正在用的 `~/.dsh`，全部在 `.cache/selftest-home` 里完成。

---

## 12. 安全、合规与风险

### 12.1 硬约束

- 只监听 `127.0.0.1`；代码里禁止出现 `0.0.0.0`。
- `.bridge-token` / `.capture-key` / `.session.json` 权限 0600，全部进 `.gitignore`。
- 会话默认只在内存；落盘是显式选项。
- 日志不含 prompt / completion / token / cookie。
- 不在 README、截图、Issue 里出现 token、uid、余额、请求头原文。

### 12.2 合规

- 这是**非官方集成**，依赖未公开的订阅接口。上游改协议、收紧风控都会导致失效。
- 只驱动自己登录的账号；不做多账号池化、代他人调用、转售。
- 抓包只复用**已登录客户端**发出的会话，不绕过登录、不破解加密存储。
- 是否允许这样用，取决于 WorkBuddy 服务条款，需自行确认。

### 12.3 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 客户端证书固定（pinning） | 低 | 抓包直接失败 | 改用 CDP 或客户端原生绑定取会话 |
| CA 被误装/误用 | 中 | 本机 HTTPS 信任面扩大 | 用完移除 CA；只在抓包期间开代理 |
| 上游改请求头/协议 | 中 | 全挂 | 归一化集中在桥，一处改 |
| token 过期 | 高 | 401 | 客户端发消息即自动重新捕获 |
| 模型名/目录变动 | 高 | 选不到模型 | `/v3/config` 动态拉 + 静态兜底 |
| 风控 11140 | 中 | 单账号不可用 | 明示错误、不自动重试 |
| DSH 插件 API 变更 | 中 | 路由配置字段失效 | 锁 DSH 版本，README 标注 tested against |

---

## 13. 里程碑

| 阶段 | 交付 | 验收 | 状态 |
|---|---|---|---|
| M0 桥（0.5d） | `/capture/*`、`/health`、`/v1/models`、`/v1/chat/completions` | mock + 抓包会话都通 | ✅ |
| M1 路由（0.5d） | `llm-pi-ai` 手写网关配置 + 补丁合并 + 模型目录 | `--dump-config` 出现 workbuddy route | ✅ |
| M2 安装器（0.5d） | bridge 拉起、凭证 `refs:` 写入、补丁托管块、卸载 | 一次命令装完、可完整还原 | ✅ |
| M3 端到端（0.5d） | 真实运行时跑通 agent 请求 | 回复来自 bridge（§11.3） | ✅ |
| M4 真实上游（0.5d） | mitmproxy + CA + 客户端发消息 | `capture/status` 变 `captured:true` 后 DSH 用真实模型 | ⏳ |
| M5 加固（1–2d） | 过期提示、日志脱敏、限流退避、开机自启 | 异常场景可诊断 | ⏳ |

---

## 14. 排障手册

| 现象 | 先看 | 常见原因 |
|---|---|---|
| `captured:false` | mitmproxy 日志 | 客户端没被接管 / 没发消息 / CA 未信任 |
| `401 CAPTURE_AUTH` | `.capture-key` | 上报密钥不一致 |
| 设置页"未连接" | `/health` | bridge 没起 / 端口被占 / node 路径不对 |
| `expired:true` | `capture/status` | token 过期，回客户端发一条消息 |
| 10085 | bridge 日志 | 标识头没整组复用（UA 被覆盖） |
| 11102 | 模型 id | 大小写、模型不在当前账号目录 |
| 11128 | 请求体 | `developer` 角色、`tool_choice` 对象、首条非 system |
| 11140 | 上游原文 + trace id | 账号风控，联系官方 |
| 429/6004 | `Retry-After` | 限流，退避或换模型 |
| 首 token 很慢 | `x-accel-buffering` | 中间有反代在缓冲 |
| 点停止后仍扣额度 | `res.on('close')` | 没 abort 上游 |

---

## 15. 附录

### 15.1 可直接借鉴的开源实现

**`Ianzhyh/workbuddy-to-dsh`** — 最完整的参考。零依赖桥（8790）+ 控制台（8792）+ DSH 原生插件，
支持 OpenAI / Anthropic / Responses 三套协议；AtRest 解密走 `ELECTRON_RUN_AS_NODE` + `loggerGet()`；
已处理 `developer→system`、`tool_choice`、首条 system、强制流式；`/v1/embeddings` 返回 501。

```bash
dsh plugin --profile desktop add github:Ianzhyh/workbuddy-to-dsh
```

**`Acoder416/dsh-plugin-workbuddy-gateway`** — 插件内嵌网关（18088），强在账号管理：
积分余额、签到、多账号轮询、按模型的限流冷却（429 / 6004，`resetAt`）、区域隔离（国内/国际）。

```bash
dsh plugin --profile web add "github:Acoder416/dsh-plugin-workbuddy-gateway#v0.2.6"
```

**`@magpie-community/opencode-workbuddy-auth`** — 不是 DSH 插件，但它是"上游到底要哪些头"
最准确的公开说明：`X-User-Id / X-Domain / X-Product / X-IDE-Type` + UA，缺失报 10085；
并说明模型目录来自 `GET /v3/config`。

**mitmproxy** — 抓包层的实现基础。`packages/capture/mitm_addon.py` 只依赖它的 addon API。

### 15.2 配置项

| 变量 | 默认 | 说明 |
|---|---|---|
| `WORKBUDDY_PORT` | `8790` | 桥端口 |
| `WORKBUDDY_UPSTREAM` | `https://copilot.tencent.com/v2` | 上游 base |
| `WORKBUDDY_LOCAL_TOKEN` | 随机生成 | 本地访问令牌 |
| `WORKBUDDY_CAPTURE_KEY` | 随机生成 | 抓包上报密钥 |
| `WORKBUDDY_PERSIST` | — | `1` 时会话落盘（0600） |
| `WORKBUDDY_SESSION_FILE` | `.session.json` | 落盘路径 |
| `WORKBUDDY_MOCK` | — | `1` 时离线联调 |
| `WORKBUDDY_TIMEOUT_MS` | `600000` | 上游超时 |
| `WORKBUDDY_API_KEY` | — | 可选兜底（本方案不使用） |
| `WORKBUDDY_AUTH_FILE` | 自动探测 | 可选兜底（明文登录文件） |

### 15.3 DSH 侧配置速查

```yaml
# 一条手写网关 route 的全部必填项
providers:
  <route-name>:          # 请求里 GenerateOptions.provider 用的名字
    api: openai-completions
    baseURL: http://127.0.0.1:8790/v1
    apiKeyEnv: WORKBUDDY_BRIDGE_TOKEN   # 凭证引用，不是值本身
    models:
      - id: auto
```

```bash
# 只校验组合，不启动
dsh --profile <name> --dump-config

# 装 bundle（桌面版的等价动作由 install.mjs 完成）
dsh plugin --profile <name> add <package-dir>

# 组合树里看结果
dsh --profile <name> --dump-config | grep -A20 llm-pi-ai
```

### 15.4 参考资料

- DSH LLM 服务与适配器契约：安装目录 `app.asar` 内 `@deepseek-ai/dsh-llm/README.md`
- DSH 多提供方适配器（本文的核心依据）：`@deepseek-ai/dsh-llm-pi-ai/README.md`
- DSH profile / bundle 组合：`@deepseek-ai/dsh-app-boot/README.md`、`@deepseek-ai/dsh-base/README.md`
- DSH 凭证存储：`@deepseek-ai/dsh-credentials-local/README.md`
- mitmproxy addon API：`https://docs.mitmproxy.org/stable/addons-overview/`

> 这些 README 都在 `resources/app.asar` 里。本仓库的 `tools/asar-*.mjs` 可以直接读：
> `node tools/asar-list.mjs <app.asar> <正则>` 列出文件，`node tools/asar-extract.mjs` 取出单个文件。

---

## 16. 本仓库骨架

```
packages/
├── bridge/                    # 零依赖网关
│   ├── server.mjs             # /capture/* /health /v1/models /v1/chat/completions
│   ├── session.mjs            # 会话存储（内存 + 头白名单 + JWT exp）
│   ├── credentials.mjs        # 兜底凭证解析（API Key / 桌面文件）
│   └── package.json
├── capture/                   # 抓包层
│   ├── mitm_addon.py          # mitmproxy 插件：上报请求头
│   └── README.md              # 装 CA、开代理、验证、排障
├── dsh-plugin-workbuddy/      # DSH bundle（纯补丁 + 安装器）
│   ├── package.json           # dsh.bundle.patch + locale/icon 显示资源
│   ├── cordis.patch.yml       # llm-pi-ai 的 workbuddy 路由
│   ├── models.json            # 模型目录（唯一事实来源）
│   ├── lib/route.mjs          # 渲染/合并托管块
│   ├── install.mjs            # 桥 + 凭证 + 补丁，可 --uninstall
│   ├── sync-models.mjs        # 从 /v1/models 重新抓模型
│   └── locale/{zh,en}.json, icon.svg
└── workbuddy-plugin/          # WorkBuddy 插件（控制面）
    ├── .codebuddy-plugin/plugin.json
    ├── hooks/{hooks.json,ensure-bridge.mjs}
    ├── mcp/server.mjs
    ├── skills/workbuddy-bridge/SKILL.md
    └── commands/bridge.md

tools/
├── asar-list.mjs / asar-extract.mjs / asar-extract-dir.mjs   # 读 DSH 的 app.asar
├── yamlcheck.mjs              # 用运行时自带的 yaml 库校验生成的补丁
└── dsh-selftest.mjs           # 端到端自测（真实运行时 + mock bridge）
```

**已验证**：抓包上报（白名单过滤 / 401 / 撤销）、mock 流式、模型列表、本地鉴权、
MCP 的 `initialize/tools/list/tools/call`、补丁在真实运行时的组合与路由注册、
`apiKeyEnv` 经凭证文件解析、DSH agent loop → bridge 的完整往返。

**未验证**：真实上游转发（要先抓一次包）、桌面 UI 里模型选择器的渲染效果、
DSH 内 `install_bundle` 路径（桌面版由 Electron 独占 profile，安装器改为直接写补丁）。

下一步就是 M4：装 mitmproxy → 接管客户端（注入 `HTTP_PROXY`）→ 在 WorkBuddy 里发一条消息 →
`curl 127.0.0.1:8790/capture/status` 出现 `captured:true` → 回 DSH 选 WorkBuddy 模型即可。
