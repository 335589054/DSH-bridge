# WorkBuddy × DeepSeek Harness 插件包

> 想尽快用起来：双击根目录的 `install.cmd`（装插件 + 装证书 + 抓一次会话）。
> 完整操作、故障排查见 **GUIDE.md**，本文件只讲安装细节。

解压后请保持这个同级结构（`install.mjs` 会去 `../bridge` 找网关）：

```
workbuddy-dsh-plugin/
├── dsh-plugin-workbuddy/   # DSH bundle + 安装器 + 设置页
├── bridge/                 # 本地网关（127.0.0.1:8790）+ 抓包环境管理
│   └── certs/              # 随包附带的 CA（证书 + 私钥 + 一键安装脚本）
└── capture/                # mitmproxy 抓包插件
```

## 前置条件

- 已安装 DeepSeek Harness 桌面版（Windows）
- Node.js 22.19+ 或 24+
- Python 3.10+（设置页里「安装 mitmproxy」需要；仅用于建独立 venv）
- 证书**不需要**单独准备：`bridge/certs/` 已随包附带，装完直接「安装到本机」即可

## 1. 安装

在本文件所在目录执行：

```bash
node dsh-plugin-workbuddy/install.mjs             # 只装插件（证书/抓包自己在设置页点）
node dsh-plugin-workbuddy/install.mjs --quick     # 插件 + 证书 + 抓一次会话
```

它做四件事，全部可逆：

1. 探活 / 拉起 `127.0.0.1:8790` 的 bridge
2. 把 bridge 令牌写进 `~/.dsh/.credentials.yaml` 的 `refs:`
3. 把本包登记成 profile `desktop` 的 bundle（Plugins 页里能看到）
4. 写路由补丁（登记成 bundle 后由 bundle 层提供）

`--quick` 会在这四步之后追加：装随包 CA → 开始抓包（客户端会重启一次）→ 等你在
WorkBuddy 里发一句话 → 自动停止抓包并恢复客户端。加 `--default-model` 可同时把新会话默认模型设为
`workbuddy/auto`。

## 1.1 证书（随包，不再需要先生成再装）

`bridge/certs/` 里的 CA 是提前生成好的，理由与安全须知见 `bridge/certs/README.md`：

| 文件 | 用途 |
|---|---|
| `mitmproxy-ca.pem` | 私钥 + 证书，mitmdump 通过 `--set confdir` 使用 |
| `mitmproxy-ca-cert.cer` | 双击安装（DER） |
| `install-ca.cmd` / `uninstall-ca.cmd` | 一键装 / 卸（当前用户根证书库） |

证书主体固定为 `CN=WorkBuddy Bridge Local CA`，设置页按「CN + 指纹」判断是否已信任。
受限环境里写证书库会被策略拦掉，此时安装器会把 `install-ca.cmd` 的路径打出来，
双击跑一次即可；命令行等价物：

```bat
certutil -user -addstore -f Root bridge\certs\mitmproxy-ca-cert.cer
```

## 2. 重启 DeepSeek Harness

客户端半体（设置页）是新代码，必须重启一次才会加载。

## 3. 在设置页里配好抓包环境

打开 **Settings → WorkBuddy**，面板里有：

| 区块 | 能做什么 |
|---|---|
| 运行状态 | 网关在不在、凭证就绪没、会话抓到没 |
| 桥接链接 | 地址 / 令牌 / 模型，一键复制地址+令牌、JSON、`.env`、curl |
| 抓包环境 | Python 版本、**安装 mitmproxy**、**把 CA 装进本机信任区** |
| 抓包与代理 | **开始抓包**（重启客户端并注入 `HTTP_PROXY=127.0.0.1:8899`，不写注册表）、**停止并还原** |
| 日志 | mitmdump / pip 的最近输出 |

顺序：`安装 mitmproxy` → `安装到本机`（CA，随包附带，不用先生成）→ `开始抓包`（客户端重启）→
去 WorkBuddy 里发一条消息 → 回到面板确认「会话：已捕获」→ `停止并还原`。

mitmproxy 装在 `bridge/.tools/mitm` 的独立 venv 里，不动你系统的 Python。
CA 用 `certutil -user` 装到**当前用户**的根证书库，不需要管理员；写证书库被安全策略
拦下时，双击 `bridge/certs/install-ca.cmd` 或 `bridge/certs/mitmproxy-ca-cert.cer`。
换过机器或升级过 Python 时，旧 venv 的解释器路径会失效，面板会标成
「装过但虚拟环境失效」，点一下「重建环境」即可（旧目录会被挪开重建，不会卡住）。

设置页打不开时的等价命令行：

```bash
node bridge/ctl.mjs status          # 状态总览
node bridge/ctl.mjs capture start   # 开始抓包（重启并接管客户端）
node bridge/ctl.mjs capture stop    # 停止 + 恢复客户端
node bridge/ctl.mjs ca install      # 装随包 CA
node bridge/ctl.mjs proxy off       # 只关代理
```

## 3.1 桥接链接（不走 DSH 也能用）

`127.0.0.1:8790` 本身就是 OpenAI Chat Completions 兼容端点。设置页的
「桥接链接」卡片给出地址（`http://127.0.0.1:8790/v1`）、令牌和模型，
可以一键复制成 `.env` / JSON / curl。命令行等价物：

```bash
node bridge/link.mjs            # 人读
node bridge/link.mjs --json     # 机读
node bridge/link.mjs --copy     # 复制地址+令牌
```

bridge 没起时脚本会回落到本地令牌文件，仍然给出地址和令牌（只是拿不到实时状态）。

## 4. 用起来

- 模型选择器里出现 **WorkBuddy**，15 个模型可选
- Settings → **Plugins** 里出现「WorkBuddy 模型」
- 抓到会话前对话会报错 `authReady:false`，这是预期的

## 5. 卸载

```bash
node dsh-plugin-workbuddy/install.mjs --uninstall
```

会移除 bundle 登记、node_modules 链接、用户补丁里的托管块、凭证引用。
抓包环境（venv、证书、`.ca/`）不会被删；需要的话：

```bash
rm -rf bridge/.tools bridge/.ca
bridge/certs/uninstall-ca.cmd
```

## 说明

- 插件目录是指向解压位置的**目录联接**：挪动或删除这个文件夹会让插件列表报错，重跑安装即可修复。
- 网关与代理端口都只监听回环地址；会话默认只存内存。
- 「开始抓包」不会动系统代理，也不会写注册表：它只是重启 WorkBuddy 并给它一个 `HTTP_PROXY` 环境变量；「停止」会把这份进程换成正常启动的那份。
- 这是非官方集成，依赖未公开的订阅接口；是否允许这样用请自行确认服务条款。
