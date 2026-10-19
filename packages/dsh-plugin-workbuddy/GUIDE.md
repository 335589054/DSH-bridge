# 使用指南

把 **WorkBuddy 的订阅模型**接进 **DeepSeek Harness（DSH）**：本机起一个 OpenAI 兼容网关，
DSH 把它当成一个模型供应商用。不申请 API Key，只在本机抓一次客户端会话头复用。

> 只支持 Windows 桌面版。全程只监听 `127.0.0.1`，不对外提供服务。

---

## 一、30 秒版本

解压后双击 **`install.cmd`**，按提示在 WorkBuddy 里发一句话，看到 `✓ 已抓到会话` 就完成了。
然后重启一次 DeepSeek Harness，在模型选择器里选 **WorkBuddy → Auto**。

命令行等价物（在解压目录里执行）：

```bash
node dsh-plugin-workbuddy/install.mjs --quick
```

---

## 二、包里有什么

```
workbuddy-dsh-plugin/
├── install.cmd            双击：装插件 + 装证书 + 抓一次会话（推荐）
├── install-ca.cmd         双击：只装证书（证书那一步被拦时用）
├── link.cmd               双击：把桥接地址 + 令牌复制到剪贴板
├── stop-capture.cmd       双击：停抓包 + 恢复客户端（客户端卡住时的救命键）
├── start-bridge.cmd       双击：只起本地网关（8790），不开网页端
├── dsh-web.cmd            双击：起 DSH 网页端（3080）；已经在跑就直接打开
├── README.md              本指南
├── dsh-plugin-workbuddy/  插件本体：设置页 UI、安装器、provider 路由
├── bridge/                本地网关 127.0.0.1:8790
│   ├── server.mjs         网关入口
│   ├── link.mjs           打印桥接链接
│   ├── ctl.mjs            命令行运维（status / capture / ca / proxy）
│   └── certs/             ★ 随包附带的 CA（证书 + 私钥 + 一键安装脚本）
└── capture/               mitmproxy 抓包插件（只摘鉴权头，不落盘请求体）
```

`bridge/certs/` 里就是安装要用的证书：

| 文件 | 干什么用 |
|---|---|
| `mitmproxy-ca.pem` | 私钥 + 证书，mitmdump 用它现签叶子证书 |
| `mitmproxy-ca-cert.cer` | 双击安装用的证书（DER） |
| `mitmproxy-ca-cert.pem` | 证书（PEM），脚本 / Linux 用 |
| `install-ca.cmd` | 一键装进当前用户根证书库 |
| `uninstall-ca.cmd` | 一键移除 |

**为什么随包附带**：抓包必须有一张本机自签的根证书，否则 WorkBuddy 的 HTTPS 请求只会
给你一个证书错误。以前这张证书要「先跑一次抓包」才生成，现在提前生成好放包里，
装完直接就能「安装到本机 → 开始抓包」。

⚠️ 证书私钥在包里。它只能装在你自己控制的机器上，别把 `certs/` 传到公开仓库或群里。
想每个部署一张独立 CA，见 `bridge/certs/README.md` 里的重新生成步骤。

---

## 三、安装：三种方式

### 3.1 一键（推荐）

解压 → 双击 `install.cmd`。它会依次做：

1. 探活 / 拉起 `127.0.0.1:8790` 的 bridge
2. 把本地令牌登记到 `~/.dsh/.credentials.yaml`
3. 把插件登记成 DSH profile（`desktop`）的 bundle，写 provider 路由
4. **把随包 CA 装进「当前用户 → 受信任的根证书颁发机构」**
5. **开始抓包 → WorkBuddy 会重启一次 → 在里面发一条消息 → 自动停止并恢复客户端**

第 5 步是最关键的：它把「开抓包 / 发消息 / 关代理」这套顺序收进了一次等待。
看到这些输出就成功了：

```
› 设备证书
  ✓ CA 已装入当前用户根证书库（WorkBuddy Bridge Local CA）
› 抓一次会话
  ✓ mitmdump 已在 127.0.0.1:8899 监听，WorkBuddy 已注入 HTTP_PROXY 重新拉起
  现在去 WorkBuddy 客户端里随便发一条消息（一句话就行，别的不用做）
  ✓ 已抓到会话（账号 u_xxx），代理已还原
```

### 3.2 命令行

```bash
node dsh-plugin-workbuddy/install.mjs --quick          # 装 + 证书 + 抓一次
node dsh-plugin-workbuddy/install.mjs --quick --default-model   # 顺便设成默认模型
node dsh-plugin-workbuddy/install.mjs --ca             # 只补装证书
node dsh-plugin-workbuddy/install.mjs --quick --no-capture      # 不抓包，只装到位
node dsh-plugin-workbuddy/install.mjs --quick --wait 300        # 等 300s（默认 120s）
```

| 参数 | 作用 |
|---|---|
| `--quick` | 安装 + 证书 + 抓一次会话（= `--ca --capture`） |
| `--ca` | 装随包 CA（写入当前用户根证书库） |
| `--capture` / `--no-capture` | 装完后是否开始抓包 |
| `--wait <秒>` | 抓包等待上限，默认 120 |
| `--default-model [名字]` | 把新会话默认模型设为 `workbuddy/<名字>`，默认 `auto` |
| `--profile <名字>` | DSH profile，默认 `desktop` |
| `--port <端口>` | bridge 端口，默认 8790 |
| `--force` | 覆盖已存在的 `llm-pi-ai` 配置行 |
| `--no-start` | 不自动拉起 bridge |
| `--no-bundle` | 只写路由补丁，不登记成插件（Plugins 页看不到） |
| `--uninstall` | 还原所有改动 |

### 3.3 证书装不上怎么办

受限环境（部分公司电脑 / 安全软件）会把「写证书库」这个动作直接拦掉，
安装器会打印：

```
! 自动写入被拦：写入证书库被拦截：双击 .../bridge/certs/install-ca.cmd（或右键「以管理员身份运行」）...
```

按它说的做，任选一种：

1. 双击 **`install-ca.cmd`**（在解压目录根下，或 `bridge/certs/` 里）
2. 双击 `bridge/certs/mitmproxy-ca-cert.cer` → 安装证书 → **当前用户** → **受信任的根证书颁发机构**
3. 右键 `install-ca.cmd` → 以管理员身份运行

装完回到 DSH 设置页点「重新检测」，证书那行变成「已信任」即可。
命令行也可以验证：

```bat
certutil -user -store Root "WorkBuddy Bridge Local CA"
```

有输出（含证书指纹）就是装好了。移除用 `bridge\certs\uninstall-ca.cmd`。

---

## 四、在 DSH 里用起来

1. **重启一次 DeepSeek Harness**：设置页是客户端半体的新代码，必须重启才会加载
2. 模型选择器里出现 **WorkBuddy**，下面是 15 个模型（`auto` 是自动选）
3. 发一句话，能看到流式输出就通了

设置页 **Settings → WorkBuddy** 里有四张卡：

| 卡片 | 能做什么 |
|---|---|
| 运行状态 | 网关在不在、凭证就绪没、会话抓到没；缺凭证时直接列出①②③④步 |
| 桥接链接 | 地址 / 令牌 / 模型，一键复制地址+令牌、JSON、`.env`、curl |
| 抓包环境 | Python / mitmproxy / 证书状态，**安装 mitmproxy**、**安装到本机** |
| 抓包与代理 | **开始抓包**（重启客户端并注入 `HTTP_PROXY`，不写注册表）、**停止并还原** |

设置页打不开也不影响使用 —— 下面的命令行等价物都能干同样的事。

---

## 五、日常使用

### 5.1 凭证过期了

抓包抓到的令牌有有效期（一般几小时到几天）。过期后对话会报 `AUTH_EXPIRED`，设置页
「凭证」显示「未就绪」。重新抓一次就好，两条路：

- 设置页：「开始抓包」→ 等 WorkBuddy 重新打开 → 发一句话 →「停止并还原」
- 命令行：

```bash
node bridge/ctl.mjs capture start     # 开抓包（会重启客户端并接管它的代理）
# 去 WorkBuddy 里发一条消息
node bridge/ctl.mjs capture stop      # 停抓包 + 恢复客户端
node bridge/ctl.mjs status            # 确认「凭证 就绪」
```

### 5.2 手机 / 局域网里的其它设备

设置页 → WorkBuddy →「局域网访问」卡片，三步：

1. 打开开关 —— bridge 从只监听 `127.0.0.1` 改为监听 `0.0.0.0`，卡片上会列出可用的局域网地址
2. 在「API 密钥」卡片里生成一把 `wbk_…`，**当场复制**（明文只显示这一次）
3. 手机 / 另一台电脑上填：baseURL `http://192.168.x.x:8790/v1`，密钥 `wbk_…`

请求格式就是 DeepSeek 的（OpenAI 兼容），模型名可以直接写 `deepseek-chat` /
`deepseek-reasoner`，bridge 会映射到 WorkBuddy 的模型：

```bash
curl http://192.168.10.20:8790/v1/chat/completions \
  -H "authorization: Bearer wbk_..." \
  -H "content-type: application/json" \
  -d '{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"ping"}]}'
```

边界是有意为之的，不是 bug：

| 规则 | 行为 |
|---|---|
| 只听内网 | 来源 IP 必须落在 RFC1918 内网段，公网来源一律 403 `LAN_ONLY` |
| 管理接口只给本机 | `/setup/*`、`/capture/*`、`/proxy` 从局域网访问返回 403 `ADMIN_LOCAL_ONLY` |
| 本机令牌不出本机 | `wb_…` 在局域网来源上被拒（`TOKEN_LOCAL_ONLY`），局域网必须用 `wbk_…` |
| 密钥只存哈希 | 配置文件里只有 SHA-256，明文只在生成那一刻出现 |
| API 可分别关闭 | 「API 开关」关掉后返回 503 `API_DISABLED`，例如只开对话、不开模型列表 |

> Radmin VPN / Tailscale 之类的虚拟网卡常分配公网段地址（例如 `26.x.x.x`），会被内网闸门挡住；
> 同一 Wi-Fi 下的 `192.168.x.x` 不受影响。首次被局域网访问时 Windows 可能弹防火墙，选「允许（专用网络）」。

### 5.3 给别的客户端用（不走 DSH）

`http://127.0.0.1:8790/v1` 本身就是 OpenAI Chat Completions 兼容端点，任何支持
自定义 baseURL 的客户端都能接：

```bash
node bridge/link.mjs            # 人读：地址 / 令牌 / 模型
node bridge/link.mjs --json     # 机读
node bridge/link.mjs --copy     # 地址 + 令牌复制到剪贴板
```

或者直接双击 `link.cmd`。填到别的客户端里就是 `baseURL = http://127.0.0.1:8790/v1`，
`apiKey = 打印出来的 wb_... 令牌`（这是**本地**令牌，只防同机误用，不是上游凭证）。

### 5.4 客户端卡住了（一直被代理接管着）

`stop-capture.cmd` 双击，或：

```bash
node bridge/ctl.mjs proxy off
```

它会把代理还原成「开抓包之前的那个值」（备份在 `bridge/.proxy-backup.json`）。

### 5.5 状态速查

```bash
node bridge/ctl.mjs status
```

bridge 没在跑（设置页转圈 / 显示「网关未连接」）时，双击 `start-bridge.cmd`：
它会先探 `/health`，没起才在后台拉一个，关掉黑框也不影响；已经在跑就直接退出。

```
地址    http://127.0.0.1:8790  在线
模式    live → https://copilot.tencent.com/v2
凭证    就绪（抓包 · u_xxx）
mitm    已安装 12.2.3
证书    已信任
抓包    未运行
代理    未开启
```

### 5.6 用浏览器打开 DSH 网页端

不装桌面版也能用 DSH：双击 **`dsh-web.cmd`**（等价于 `dsh --profile web`），
默认监听 **3080**。脚本会先探端口，已经在跑就直接打开浏览器，不会重复起一份。

命令行等价物：

```bat
"%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --profile web
```

两个坑，都记一下：

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 页面显示 `authentication required` | 登录态 cookie 按 authority 哈希区分，`localhost:3080` 和 `127.0.0.1:3080` 是**两套**登录态，在一边登录另一边不认 | 一律用 **http://127.0.0.1:3080/** 访问 |
| `'dsh' 不是内部或外部命令` | CLI 随桌面版附带，但不在 PATH 里 | 用上面的完整路径，或双击 `dsh-web.cmd`（脚本自己会找） |

---

## 六、故障排查

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 设置页一片空白 / 转圈 | bridge 没起，或旧版 bridge | `node bridge/ctl.mjs status`；起不来就跑一次 `install.cmd` |
| 面板显示「网关未连接」+ `Failed to fetch` | bridge 没在跑（被杀掉、或它自己在某个请求里崩了） | 0.5.2 起 **DSH 启动时会自动拉起 bridge**，重启一次 DSH 即可；也可以双击 `bridge/start.cmd`。看 `bridge/bridge.log` 末尾有没有 `[fatal]` 行 |
| 面板显示「网关未连接」，下面一行「管理接口只接受本机页面调用」 | bridge 的来源闸门没认桌面壳 Origin（桌面版从 `app://app/` 加载，既不是 127.0.0.1 也不是 file://），旧版 bridge 会 403 | 更新到 0.5.1+ 后重启 bridge（`start-bridge.cmd`），再点「重试」。这条在浏览器沙箱里复现不出来，只有桌面版会踩 |
| 点「开始抓包」报「抓包没能接管 WorkBuddy 流量……父进程链里有 WorkBuddy.exe」 | 当前这份 bridge 是**从 WorkBuddy 里**拉起的（典型：WorkBuddy 内置 agent / 远程控制会话起的 node），抓包要重启客户端，会把它一起带走 | 两个办法：① 重启一次 DSH —— host 半体会自动换一份自己拉起的 bridge；② 双击 `packages\bridge\start.cmd` —— 它发现自托管 bridge 会先杀掉再起一份干净的。然后重试 |
| 点「开始抓包」报「拉起 WorkBuddy 后 20 秒内没检测到进程」，客户端还莫名消失了 | **0.5.5 及之前的坑**：bridge 是 DSH 拉起的，环境里有 `ELECTRON_RUN_AS_NODE=1`，被原样传给了 WorkBuddy.exe（同为 Electron 程序）→ 以纯 Node 模式启动、无参数秒退，检测当然看不到；失败回滚的「还原启动」也秒死，只能手动重开客户端 | 更新到 0.5.6+（`launch()` 会剥掉 `ELECTRON_*` 变量）。注意：**跑着的旧 bridge 不会自己换新代码**——重启一次 DSH，或先结束旧 bridge 进程再双击 `packages\bridge\start.cmd`，然后重试抓包 |
| 面板样式和浏览器 / 网页版里看到的不一样 | 正常。插件只往设置页里填一块面板，外面的导航、标题栏、间距由各前端自己的壳决定（桌面版 `app://`，网页版是 http 页面） | 只要 WorkBuddy 里的几张卡都在，就是对的 |
| 面板显示「证书 已生成，未信任」 | 证书没进证书库 | 双击 `install-ca.cmd`，回来点「重新检测」 |
| WorkBuddy 里 HTTPS 全报证书错误 | 开始抓包了但证书没装 | 先 `capture stop` 恢复客户端 → 装证书 → 再 `capture start` |
| 对话报 `AUTH_EXPIRED` | 抓到的令牌过期 | 重新抓一次（见 5.1） |
| 对话报 `authReady:false` | 还没抓到过会话 | 抓一次（见 5.1） |
| 「开始抓包」按钮灰着 | mitmproxy 没装 / venv 失效 | 点「安装 mitmproxy」或「重建环境」 |
| mitmproxy 装到一半失败 | 网络 / PyPI 慢 | 设 `WORKBUDDY_PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple` 再装 |
| 提示 venv 失效（换过 Python / 换过机器） | venv 里记的是旧的解释器绝对路径 | 设置页点「重建环境」；不会卡住，旧目录会被挪开 |
| 端口 8790 被占 | 有旧 bridge 在跑 | 关掉旧进程，或 `--port 8791` 另起一份 |
| 装了新版本，界面还是旧的 | profile 指向的是另一份副本：双击的是 zip 解压目录里的 `install.mjs`，它把「那份静态快照」登记进了 profile，改源码当然没反应 | 装的时候看第一行 `安装源`：显示「仓库源码」才是源码；要装源码就跑 `node packages/dsh-plugin-workbuddy/install.mjs`。装完必须重启 DSH |
| DSH 模型列表里没有 WorkBuddy | 没重启 / 路由没写进去 | 重启 DSH；`install.cmd` 自检里「路由来源」必须是 bundle 层或用户补丁 |
| 插件列表里看不到「WorkBuddy 模型」 | 用 `--no-bundle` 装过 | 重跑 `install.mjs`（不带该参数） |
| 装完模型还在报 401 | 抓到的会话被上游作废 | 桥已自动作废旧会话；重新抓一次 |
| 卸载后 DSH 起不来 | profile 补丁残留 | `node dsh-plugin-workbuddy/install.mjs --uninstall` |

日志在 `bridge/bridge.log`（网关）和设置页「日志」折叠区（mitmdump / pip 输出）。

---

## 七、常见问题

**桥接过去的是什么？是纯文本吗？**
不是。DSH 发来的 `system` / 历史消息 / `tools` / 图片**全部原样转发**给上游，
上游的 SSE 也原样透传回来。桥只做几处必要的字段归一化（`developer` → `system`、
强制 `stream: true`、`tool_choice` 收敛成字符串等），不裁剪上下文、不改内容。

**工具是谁执行的？**
**DSH 侧**。上游只回 `tool_calls`，桥只转发，不替客户端执行任何工具。
所以你在 DSH 里装的 MCP / 工具链照常用，WorkBuddy 只负责生成。

**会不会污染我 WorkBuddy 里的对话？**
不会。正式产品只走 `live` 模式：请求直接转发到 `chat/completions`，不往任何已有会话里
注入消息。（仓库里另有一套「网关模式」用于实验，会把消息注进当前会话，那道开关在
产品里永久关闭，也不在文档里承诺。）

**抓到的凭证存在哪？**
只存 bridge 进程内存。设 `WORKBUDDY_PERSIST=1` 才会落盘到 `bridge/.session.json`（0600）。
卸载或重启 bridge 就没了。

**需要管理员权限吗？**
不需要。证书装到「当前用户」根证书库（`certutil -user`），代理改的是 HKCU。
只有证书库写入被安全策略拦住时才建议右键「以管理员身份运行」。

**会不会影响我自己装的 mitmproxy？**
不会。桥用自己的 `bridge/certs/` 和运行期目录 `bridge/.ca/`，不碰 `~/.mitmproxy/`。
mitmproxy 也装在 `bridge/.tools/mitm` 的独立 venv 里，不动系统 Python。

**换机器 / 重装系统怎么办？**
重新解压、双击 `install.cmd`。证书是同一张，之前装过的信任仍然有效。

---

## 八、卸载

```bash
node dsh-plugin-workbuddy/install.mjs --uninstall
```

会移除：bundle 登记、`node_modules` 目录联接、profile 补丁里的托管块、凭证引用。
不会自动删：bridge 进程、抓包环境、已安装的证书。需要彻底清理时：

```bat
taskkill /IM node.exe /F
rmdir /s /q bridge\.tools
bridge\certs\uninstall-ca.cmd
```

---

## 九、安全与合规

- 全链路只监听 `127.0.0.1`（bridge 8790、mitmdump 8899），不绑定 `0.0.0.0`
- 证书私钥随包分发，**只装在自己控制的机器上**；用完可以随时卸掉
- 抓包只从真实请求里摘白名单请求头（`authorization` / `x-user-id` / `x-domain` 等），
  请求体不落盘
- 本地令牌只防同机误用，日志和接口里一律掩码显示
- 这是**非官方**集成，依赖未公开的订阅接口。是否允许这样使用，请自行确认服务条款。
