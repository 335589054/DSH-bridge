# AGENTS.md

本文件是本仓库的**约定与决策记录**。改动代码前先读这里，尤其是「硬性决策」一节。

---

## 这是什么

把 WorkBuddy 订阅模型导出成 **OpenAI Chat Completions 兼容接口**，让 DeepSeek Harness（DSH）
等任意 OpenAI 客户端能把 WorkBuddy 当成一个模型供应商来用。

- `packages/bridge/` —— 桥本体（Node，只监听回环）；`certs/` 是随包 CA
- `packages/bridge/ctl.mjs` —— 命令行运维（设置页打不开时的等价入口）
- `packages/capture/` —— mitmproxy addon，抓 WorkBuddy 客户端自己的鉴权头
- `packages/dsh-plugin-workbuddy/` —— DSH 插件：设置页 UI + provider bundle + 安装器
  （`GUIDE.md` 使用指南 / `INSTALL.md` 安装细节）
- `tools/` —— 打包、YAML 校验等一次性脚本；`tools/package-root/` 是 zip 根的双击脚本

---

## 硬性决策（已定，不要推翻）

### 1. 正式产品只走 `live` 模式

`live` = 把 OpenAI 请求**原样转发**到上游 `chat/completions`，SSE 透传回客户端。

- 上游默认 `https://copilot.tencent.com/v2`
- 客户端发来的 `system` / 历史消息 / `tools` / 图片**全部保留**，桥不裁剪上下文
- **工具由 DSH 执行**：上游只回 `tool_calls`，桥只转发，不替客户端执行任何工具

### 2. 不提供 token / API Key 路线

用户已确认 `ck_` API Key 需要付费、拿不到，**不作为产品路径**。

- 产品里**不存在**「粘贴令牌」这类入口，不要再加
- `credentials.mjs` 里的 `WORKBUDDY_API_KEY` 只是**调试兜底**（环境变量），不在文档里承诺
- 不要去解密 `$wbEncrypted` / `keyblob` 的 `static-v1` 槽位 —— 密钥在 app.asar 里，
  属于逆向，明确不做。凭证的合法来源只有一个：**客户端自己发出去的请求**

### 3. 网关模式是实验特性，永远不进产品面
`WORKBUDDY_GATEWAY_URL`（本机 46285 远程控制口）会把 chat 翻译成
「往当前 WorkBuddy 会话注入一条消息」，**副作用是真实的**：那条消息会落进会话，
WorkBuddy 的 agent 会真的执行它，工具也是 **WorkBuddy 侧**的工具。

因此代码里加了双闸门：

```js
const EXPERIMENTAL = process.env.WORKBUDDY_EXPERIMENTAL === '1'
const GATEWAY_URL = EXPERIMENTAL ? (process.env.WORKBUDDY_GATEWAY_URL || '') : ''
```

- 只设 `WORKBUDDY_GATEWAY_URL` → 启动时告警并**按 live 运行**（防环境变量残留把产品带偏）
- 两个都设 → `mode=gateway`，可联调
- 网关模式还有两个已知缺陷，**不要在它上面建产品功能**：
  - 只转发**最后一条真实用户消息的纯文本**，没有上下文（`{id,type:'text',text}`）
  - 排队中的 run **取消不掉**（`POST /runs/:id/cancel` 只认正在执行的，排队态返 404）

---

### 4. CA 随包附带，运行期复制到 `.ca/`

`packages/bridge/certs/` 里是**提前生成好的** mitmproxy CA（证书 + 私钥），随 zip 分发。
mitmdump 一律带 `--set confdir=<bridge>/.ca`，`.ca/` 由 `certs/` 同步而来。

- 好处：装证书不再依赖「先跑一次抓包生成证书」，也不会被用户的 `~/.mitmproxy` 干扰
- 代价：私钥进了分发包 → 只应装在受控机器上，`certs/README.md` 写明风险与重新生成步骤
- 检测：`certutil -user -store Root "WorkBuddy Bridge Local CA"`；CN 命中即算已装，
  指纹不一致只记日志不拦人（拦下来会让用户彻底没法抓包）
- 证书没装就点「开始抓包」→ 直接拒绝并说明原因（`needsCa: true`），
  否则用户只会看到 WorkBuddy 里一片 TLS 错误
- 受限环境写证书库会被拦（`此操作中不允许使用 UI`）→ 接口回 `manual: true` +
  `certs/install-ca.cmd` 路径，让用户自己双击。**不要试图绕过这个限制**

---

### 5. 局域网访问是「绑定 + 来源」双闸门

`packages/bridge/lan.mjs`，状态落 `bridge/.bridge-config.json`（已 gitignore、不进 zip）。

- 开关只改 **绑定地址**：关 → `127.0.0.1`，开 → `0.0.0.0`，运行中热切换（`close()` 旧
  server 对象 + 新对象 `listen()` 同端口，实测可靠，在途连接不中断）
- 听着 `0.0.0.0` 不等于谁都能进：请求来源必须过 `isLanIp()`（RFC1918 + 169.254 + fc00::/7 +
  fe80::/10），**公网段一律 403 `LAN_ONLY`**。Radmin VPN 之类虚拟网卡的 `26.x.x.x`
  属于公网段，按公网拒绝 —— 这是「只允许局域网」的字面执行，不是 bug
- 管理面（`/setup/*`、`/capture/*`、`/proxy`）无论开关都只接受**回环来源**（`ADMIN_LOCAL_ONLY`）
- 本机令牌 `wb_…` 只在本机来源生效（局域网来源返回 `TOKEN_LOCAL_ONLY`），局域网必须用
  `wbk_…`；密钥只存 SHA-256，明文只在生成响应里出现一次
- `chat` / `models` 可分别关闭，关掉返回 503 `API_DISABLED`
- 模型名兼容 DeepSeek：`deepseek-chat → auto`、`deepseek-reasoner → deepseek-v4-pro`
  （`DEEPSEEK_ALIASES`，只在入站映射，不改上游请求体）

---

### 6. 安装器只认「自己所在的那一份」

`install.mjs` 把 `import.meta.url` 的目录（`PACKAGE_ROOT`）写进 profile 的
`link:` 依赖。所以：

- 从**仓库源码**跑 → profile 指向 `packages/dsh-plugin-workbuddy`，改代码重启即生效
- 从 **zip 解压目录**跑 → profile 指向那份静态快照，改源码**永远不生效**

曾经踩过的坑：改完源码，重启 DSH 界面没变 —— 因为最后一次安装是双击解压目录里的
`install.cmd`，profile 被改指到 `dist/workbuddy-dsh-plugin/...`，连 bridge 也是从那份
旧代码起的。现在安装器第一屏就打 `安装源` 与版本，并显式提示「本次覆盖了哪个旧路径」；
排查「新代码没生效」**先看这一行**。

---

### 7. 管理接口的来源闸门必须同时认「桌面壳」

DSH 桌面版渲染进程从 `app://app/` 加载（Electron 自定义协议），Origin 既不是
`http://127.0.0.1` 也不是 `file://`（`file://` 的 Origin 头是字符串 `null`）。
`checkAdmin()` 只认回环 http 来源时，桌面版设置页每个请求都 403，界面上只剩
「网关未连接 / 管理接口只接受本机页面调用」——而这个症状在沙箱（web profile + 浏览器）
里**复现不出来**，因为那边的 Origin 是 `http://127.0.0.1:PORT`。

规则（`SHELL_ORIGIN`）：

- 放行：无 Origin（curl / 脚本）、`null`、回环 http(s)、`app://` `dsh://` `file://`
  `electron://` `vscode-webview://`
- 拒绝：任何非回环 http(s) 来源 → 403 `ADMIN_ORIGIN`，并把来源写进管理日志
- 管理路径不给 `access-control-allow-origin: *`（否则网页能带 `x-bridge-admin` 试一把）；
  只读端点仍给 `*`

放行自定义 scheme 不降低安全性：网页无法伪造 `app://` 这类 Origin。改这块必须两个用例都测：
`origin: 'app://app'` → 200，`origin: 'https://evil.com'` → 403。

---

### 8. 代理接管一律走客户端自己的 `HTTP_PROXY`，**不写注册表**

老版本把系统代理写到 `HKCU\...\Internet Settings` 再刷 WinINet。受限环境里 `reg.exe`
在程序黑名单上，写不进去 → 面板红字「代理设置未生效」，整条取证链路断掉。

现在的唯一实现（`packages/bridge/workbuddy-client.mjs`）：

1. 找 `WorkBuddy.exe`：`WORKBUDDY_CLIENT_EXE` → 运行中进程的路径 → 常见安装位置
2. `taskkill /IM WorkBuddy.exe /T /F`（Electron 单实例锁，不退出新进程只会把旧窗口顶到前台）
3. 用 `HTTP_PROXY=http://127.0.0.1:<capturePort>`（外加 `http_proxy` / `HTTPS_PROXY` /
   `https_proxy`）拉起客户端
4. 停止时杀掉这份进程，按接管前拍下来的环境变量还原（`wasRunning` 才重新拉起）

为什么是环境变量、不是 `--proxy-server`：**读过 `app.asar` 确认**，客户端启动时会走
`configureRendererSessionProxy()`，从 `process.env.HTTP_PROXY || http_proxy` 取值并调用
`session.setProxy({proxyRules, proxyBypassRules:'localhost,127.0.0.1,::1'})`；没设才回落到
`mode:'system'`。`session.setProxy` 会盖掉命令行开关，写 `--proxy-server` 是白写。

约束：

- 接管期间客户端会**重启一次**：用户没发出去的输入会丢，面板文案必须写明
- 状态落 `bridge/.launch-state.json`（`pid` + `envBefore` + `wasRunning`）；判断「是否接管中」
  必须用「记录的 pid 还在」，不能只看「有 WorkBuddy 进程」——用户手动重开的那份没带代理
- `orphan: true` = 状态文件还在但 pid 没了：面板提示点「恢复客户端」清状态，别自动杀进程
- **bridge 自己跑在 WorkBuddy 里时拒绝接管**（`SELF_HOSTED`）：重启客户端会把 bridge 一起
  带走。父进程链查不到时按「不是」处理，不拦人；`WORKBUDDY_LAUNCH_FORCE=1` 可强制
- 不再需要 `reg.exe` / `InternetSetOption` / `.proxy-backup.json`；旧备份文件会被清理并记一条日志

---

### 9. 网关的生命周期归插件 host 半体管

`packages/dsh-plugin-workbuddy/lib/index.js` 的 `apply()` 里会调 `ensureBridge()`：
探 `/health`，没起就 `spawn(process.execPath, [bridge/server.mjs], { detached: true })`。

为什么必须这么做：bridge 原先是安装器或人手起的临时进程，会话/终端一关就没了，
用户再打开设置页看到的是「网关未连接 / Failed to fetch」——**而界面里没有任何入口能把它
启动起来**（bridge 都没跑，自然没有 API 可调）。DSH 加载插件的那一刻，就是「该有网关」的时刻。

- 桌面版 host 跑在 Electron 里，`process.execPath` 是 `DeepSeek Harness.exe`，
  必须给子进程加 `ELECTRON_RUN_AS_NODE=1`，否则会再弹一个 GUI
- `detached + unref + stdio 指向 bridge.log`：不拖住插件加载，也不跟着 DSH 退出
- 这里**绝不允许抛异常**：插件加载失败会连带整个 DSH 起不来，代价远大于网关缺席

配套的两条防线（都是真实事故换来的）：

- `admin.mjs` 的 `seedCa()` 全程 try/catch。一个 `mkdirSync` 抛出来就会把进程带走
- `server.mjs` 挂了 `uncaughtException` / `unhandledRejection`，只记日志不退出
  （本地网关卡住一次请求，比整个掉线好）

**自托管的 bridge 必须换掉**：`/health` 带 `pid` 和 `selfHosted`（父进程链里有
`WorkBuddy.exe` 即为 true，父进程链不变所以只算一次）。`ensureBridge()` 发现
「在跑但自托管」就 `process.kill(pid)` 换一份自己拉起的；`start.cmd` 同理
（先杀再起，`taskkill /PID` + 等端口释放）。真实案例：bridge 由 WorkBuddy 内置
agent 会话拉起时，DSH 面板一切正常，但点「开始抓包」必被 `SELF_HOSTED` 拦——
而界面上看不出 bridge 的来路，只能靠这两个字段。

> 注意：从**我这边的沙箱**里 `spawn(detached)` 起的进程会被回收，验证「常驻」不能这么做；
> 用受管后台任务，或让 DSH 自己拉。另外沙箱里 `schtasks.exe` 被安全策略黑名单拦
> （且明确警告不要绕路），「换个父进程起 bridge」这类验证只能留给用户侧双击。

---

### 10. 网页端启动脚本：一律 `127.0.0.1`，脚本必须 GBK

DSH 网页端（`dsh --profile web`，默认端口 **3080**）的登录态 cookie 按 authority 哈希
区分，`localhost:3080` 与 `127.0.0.1:3080` 是**两套**登录态 —— 用 localhost 打开会看到
`authentication required`，这不是故障。所有入口（桌面脚本、zip 根脚本、文档）只给
`http://127.0.0.1:3080/`。

- 探测语义：node `fetch` 到 3080 **拿到任何 HTTP 响应都算「已在跑」**（401 也算在跑），
  此时只 `start ""` 打开浏览器，不起第二份
- 桌面脚本（`启动 DSH 网页端.cmd`）**必须 GBK 编码**：UTF-8 + `chcp 65001` 组合下
  某些中文 `echo` 行会被 cmd 解析炸掉（`'on' is not recognized`）。改它用 python 按
  GBK 读写，别用会转码的编辑工具
- zip 根的同款脚本是 `tools/package-root/dsh-web.cmd`（ASCII 版），已登记进
  `tools/pack_plugin.py` 的 `ROOT_FILES`
- CLI 真身不在 PATH：`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`

---

### 11. bridge 转发自己的环境变量给子进程前，先剥掉 `ELECTRON_*`

DSH 拉起 bridge 时带 `ELECTRON_RUN_AS_NODE=1`（为了让 Electron exe 按 Node 跑）。
bridge 里任何「拉起另一个 GUI 程序」的 spawn（`workbuddy-client.mjs` 的 `launch()`）
都必须先删掉 `ELECTRON_RUN_AS_NODE` / `ELECTRON_NO_ATTACH_CONSOLE` / `ELECTRON_ENABLE_LOGGING`
（`CHILD_ENV_STRIP`）—— WorkBuddy 也是 Electron 程序，原样继承会以纯 Node 模式启动、
无参数立即退出。真实事故（0.5.5）：点「开始抓包」→ 杀掉客户端 → 重新拉起秒死 →
`waitClient` 20 秒看不到进程 → 失败回滚的还原启动同样秒死 → 用户只能手动重开。
已用无害实验复现：带该变量 spawn WorkBuddy.exe，1.5 秒内进程消失。
注意非 Electron 子进程（tasklist / powershell / python）不受影响，不用剥。

---

## live 模式的数据流

```
DSH(OpenAI 客户端)
   │  POST /v1/chat/completions  (Authorization: Bearer <本地令牌>)
   ▼
bridge :8790
   │  1) checkAuth —— 校验本地令牌，不是上游凭证
   │  2) normalize   —— developer→system、首条补 system、tool_choice 收敛为字符串、强制 stream
   │  3) currentAuth —— 抓包会话优先，其次 credentials.mjs 兜底
   │  4) 原样 POST 上游 /chat/completions，SSE 透传
   ▼
copilot.tencent.com/v2
```

### `normalize()` 处理的每一条都对应一个真实出现过的上游报错

- 上游**拒绝非流式** → 强制 `stream: true`
- `max_completion_tokens` 与 `max_tokens` 冲突 → 删掉前者
- `developer` 角色上游不认 → 转成 `system`
- 首条必须是 `system` → 缺了补 `DEFAULT_SYSTEM`
- `tool_choice` 只接受字符串 → 对象形态收敛成 `auto` / `required` / `none`

---

## 凭证：唯一产品路径是抓包

```
mitmdump :8899（addon: packages/capture/mitm_addon.py）
   │  从 WorkBuddy 真实请求里摘 authorization / x-user-id / x-domain 等白名单头
   │  POST /capture/session   (x-capture-key)
   ▼
sessionStore（只存内存，WORKBUDDY_PERSIST=1 才落盘 0600）
   │
   └─ bridge 每次请求取用
```

规则：

- 只保留白名单头（见 `session.mjs` 的 `ALLOWED`），别把 `accept-encoding` / `content-length` 带进重放
- 过期时间从 JWT `exp` 解析；解析不到就交给上游 401 兜底
- **401 必须作废抓包会话**：`type === 'captured'` 且上游 401 → `sessionStore.clear()`，
  然后换兜底凭证重试一次；没有兜底就返回 `AUTH_EXPIRED` 提示重新抓包。
  否则旧令牌会让后续每个请求都撞墙。

---

## 生产行为约定（`server.mjs`）

| 行为 | 约定 |
|---|---|
| 监听地址 | 只绑 `127.0.0.1`，**绝不 `0.0.0.0`** |
| 状态码 | 上游 4xx 原样透出（400/401/403/429 客户端要能区分）；5xx 收敛成 502 |
| 流式保活 | 上游开流后常静默几十秒，每 `WORKBUDDY_KEEPALIVE_MS`（默认 15s）写 `: keepalive` 注释行 |
| 客户端断开 | 必须 `abort()` 上游，别让请求悬挂占配额 |
| 优雅退出 | SIGINT/SIGTERM 停收新连接，给在途流 3 秒 |
| 端口占用 | `EADDRINUSE` 给可照做的提示后 `exit(1)`，不抛栈 |
| 令牌 | 本地令牌只防同机误用；**任何日志/接口都不回传明文**，展示一律掩码 |
| 管理接口 | `Origin` 必须是回环地址（端口不同不算风险）+ `x-bridge-admin: 1` |

> 历史坑：早期按 `sec-fetch-site: cross-site` 一律 403，结果 DSH 设置页（另一个回环端口）
> 每次都 403，面板永远打不开。**判据必须是「Origin 是否回环」，不是「是否跨站」。**

### 接口清单

| 接口 | 用途 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 兼容对话（SSE） |
| `GET /v1/models` | 模型目录（上游 `GET /v3/config`，失败回退内置表） |
| `GET /health` | 运行形态 + `credentials`（`ready` / `needsCapture` / `hint`） |
| `POST /capture/session` | 抓包上报（`x-capture-key`） |
| `GET /capture/status` · `DELETE /capture/session` | 会话状态 / 清除 |
| `GET /setup/status[?fresh=1]` | 环境状态（`fresh=1` 跳过 30s 探测缓存，UI「重新检测」用） |
| `GET /setup/link` | 桥接地址 / 令牌掩码 / 模型 + 复制片段 |
| `POST /setup/install` · `POST /setup/ca` | 装 mitmproxy / 装随包 CA（被拦时回 `manual:true`） |
| `POST /capture/{start,stop}` · `POST /proxy` | 抓包与客户端接管（不写注册表） |
| `POST /setup/lan` | 局域网开关（热切 `127.0.0.1` ↔ `0.0.0.0`，先探能否绑定） |
| `GET·POST /setup/keys` · `/setup/keys/{enable,delete,verify}` | API 密钥（生成时明文只回一次 / 启停 / 删除 / 本地校验） |
| `POST /setup/api` | 单接口开关（`chat` / `models`） |

命令行等价物：`bridge/ctl.mjs`（`status` / `capture start|stop` / `ca install` / `proxy on|off`）。
`install.mjs --quick` = 安装 + 装证书 + 抓一次会话（等 120s，抓到自动停代理）。

---

## 验证方法（重要）

**不允许用真实 WorkBuddy 会话做验证** —— 网关模式会往用户对话里注入消息，且取消不掉。

标准做法：假上游 / 假网关 + 另起端口。

```bash
# 假上游：不联网，检验 live 的转发/重试/保活/错误码
node .cache/fake-upstream.mjs 46400

# bridge 另起一份（不要动 8790 上正在服务的实例）
WORKBUDDY_PORT=8792 \
WORKBUDDY_UPSTREAM=http://127.0.0.1:46400/v2 \
WORKBUDDY_API_KEY=ck_test \
WORKBUDDY_KEEPALIVE_MS=1000 \
node packages/bridge/server.mjs
```

`WORKBUDDY_PORT` 可改端口是**关键**，否则只能停掉正式实例才能测。

已验证覆盖的用例：正常透传、上游 400 原样透出、长静默保活、
抓包凭证 401 → 作废并换兜底重试、`/v1/models` 取上游目录、
网关双闸门（只给 URL → live + 告警；两个都给 → gateway）。

---

## 已知限制

- **证书要用户亲手点一下**。在受限环境里写根证书库会被策略硬杀（`certutil` 挂住 20s、
  `Import-Certificate` 报「此操作中不允许使用 UI」），只能双击 `certs/install-ca.cmd`。
  证书文件本身已经随包附带，不需要再生成。
- 子进程一律带超时（`admin.mjs` 的 `run()`，默认 60s；certutil / ps 20s；pip 900s）。
  不带超时的话，被挂住的 `certutil` 会让设置页那一次请求永远转圈。
- Windows 自带 exe（certutil / reg）输出是 GBK，`run()` 先按 UTF-8 严格解、失败退 GBK。
  直接按 UTF-8 读会把要显示给用户的错误原因变成乱码。
- **客户端接管要重启一次 WorkBuddy**。用户没发出去的输入会丢，所以面板文案必须写明；
  `--quick` 安装时也要提示「窗口会重开」。
- **bridge 跑在 WorkBuddy 里时接管会被拒**（`SELF_HOSTED`）。这是故意的：重启客户端会把
  bridge 一起带走。从 DSH 或独立终端起 bridge 即可。
- **代理不再需要注册表**（老版本受限环境里 `reg.exe` 被黑名单拦）。现在只剩证书库那一关要
  用户亲手点。
- 上游没有 `/models`，模型清单靠 `/v3/config`；拿不到时用 `FALLBACK_MODELS`。
- Windows 上递归删 3000+ 小文件会被安全策略拦（`SAFE_DELETE_BULK`），
  重建 mitmproxy venv 用 **rename 挪开再建**，不要 `rm -rf`。

---

## 待办

- [ ] 把网关试验代码从 `server.mjs` 抽到 `packages/bridge/experimental/`，产品入口不再引用
- [ ] `tools/yamlcheck.mjs`、打包脚本补进 CI 前的自检清单
- [ ] `certs/` 里的 CA 有效期到 2031-10；到期前在打包流程里提醒换一份
