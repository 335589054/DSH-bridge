# workbuddytoharness

把 WorkBuddy 的订阅模型接进 DeepSeek Harness（DSH）。

**不申请 API Key、不解密登录文件**：靠本机抓包拿到 WorkBuddy 客户端自己的会话头，
再由本地桥转发复用。

```
DSH agent loop → llm-pi-ai(workbuddy 路由) → bridge :8790 → copilot.tencent.com
                                                    ▲
                                       mitmproxy :8899（只读请求头）
```

> **正式产品只有一种运行形态：`live`** —— 请求原样转发到上游 `chat/completions`，
> 上下文与 `tools` 完整保留，工具由 DSH 自己执行。凭证只有一条来源：抓包。
> 网关模式（往当前会话注入消息）属于实验特性，必须显式开 `WORKBUDDY_EXPERIMENTAL=1`
> 才生效，**不用于产品**。改动代码前请先读 [`AGENTS.md`](AGENTS.md)。

- 开发文档：[`docs/workbuddy-llm-for-dsh-dev.md`](docs/workbuddy-llm-for-dsh-dev.md)
- 约定与决策：[`AGENTS.md`](AGENTS.md)
- 本地网关：`packages/bridge`（零依赖，`127.0.0.1:8790`）
- 抓包层：`packages/capture`（mitmproxy addon，`127.0.0.1:8899`）
- DSH 插件：`packages/dsh-plugin-workbuddy`（bundle + 安装器）
- WorkBuddy 插件：`packages/workbuddy-plugin`（SessionStart 钩子 + 只读 MCP）

## 一键安装（桌面版）

### 从 GitHub 直接装（推荐，不需要解压安装包）

```bash
dsh plugin --profile web add github:335589054/DSH-bridge       # 网页端 profile
dsh plugin --profile desktop add github:335589054/DSH-bridge   # 桌面版 profile
```

仓库根就是完整的插件包：`bridge/`（含随包 `certs/` 和 `capture/`）已经打进包内，
装完重启 DSH 就会自动拉起 `127.0.0.1:8790` 的网关。git 安装不跑 `prepare` 构建，
因为 `lib/` 是直接提交进仓库的。

### 从仓库源码 / zip 安装

```bash
node packages/dsh-plugin-workbuddy/install.mjs --quick
```

它做四件事，全部可逆：

1. 探活 / 拉起 `127.0.0.1:8790` 的 bridge
2. 把 bridge 令牌写进 `~/.dsh/.credentials.yaml` 的 `refs:`
3. **把本包登记成 profile 的 bundle**（Plugins 页才看得到；纯补丁不会出现在插件列表里）
4. 写路由补丁（登记成 bundle 后由 bundle 层提供）

`--quick` 再多两步：装**随包附带的 CA**（`packages/bridge/certs/`）→ 开抓包 →
等你在 WorkBuddy 里发一条消息 → 自动停抓包并把客户端恢复正常启动。

桌面版的 HMR 会监听 profile 清单与补丁文件，保存即生效；没生效就重启桌面端。
之后：

- Settings → **Plugins** 里出现「WorkBuddy 模型」
- 模型选择器里出现 **WorkBuddy** → **Auto（自动选择）**

```bash
node packages/dsh-plugin-workbuddy/install.mjs --default-model   # 顺手把默认模型也切过去
node packages/dsh-plugin-workbuddy/install.mjs --uninstall       # 完整还原
```

完整操作指南：[`packages/dsh-plugin-workbuddy/GUIDE.md`](packages/dsh-plugin-workbuddy/GUIDE.md)
（安装细节：[`INSTALL.md`](packages/dsh-plugin-workbuddy/INSTALL.md)）。

## 证书：随包附带

抓包需要一张本机自签根证书。它提前生成好放在 `packages/bridge/certs/`，随 zip 分发：

| 文件 | 用途 |
|---|---|
| `mitmproxy-ca.pem` | 私钥 + 证书（mitmdump 通过 `--set confdir=<bridge>/.ca` 使用） |
| `mitmproxy-ca-cert.cer` | 双击安装（DER） |
| `install-ca.cmd` / `uninstall-ca.cmd` | 一键装 / 卸到当前用户根证书库 |

mitmdump 启动时 `confdir` 指向 `bridge/.ca/`（由 `certs/` 同步），于是「装证书」不再
依赖「先跑一次抓包生成证书」。受限环境写证书库会被拦（`此操作中不允许使用 UI`），
此时接口回 `manual: true`，让用户双击 `install-ca.cmd` 即可。
私钥随包分发，只应装在受控机器上；安全说明与重新生成步骤见
[`packages/bridge/certs/README.md`](packages/bridge/certs/README.md)。

## 让它能真的回话：在设置页里点几下

`install.mjs` 装完还缺凭证。重启 DeepSeek Harness 后打开 **Settings → WorkBuddy**：

1. **安装 mitmproxy** —— 装到 `packages/bridge/.tools/mitm` 的独立 venv，不动系统 Python
2. **安装到本机**（CA）—— `certutil -user`，装进当前用户根证书库，免管理员
3. **开始抓包** —— 自动起 `mitmdump`（只监听 127.0.0.1），并重启 WorkBuddy 注入
   `HTTP_PROXY=127.0.0.1:8899`（不写注册表、不改系统代理）
4. 去 WorkBuddy 里发一条消息，回面板确认「会话：已捕获」
5. **停止并还原** —— 客户端按接管前的环境重新拉起，之后 DSH 不再依赖代理常开

面板里还能看到 Python / mitmproxy / CA / 代理 / 抓包的实时状态和日志。
面板打不开时用命令行等价物：

```bash
node packages/bridge/ctl.mjs status          # 状态总览
node packages/bridge/ctl.mjs capture start   # 开始抓包（重启并接管客户端）
node packages/bridge/ctl.mjs capture stop    # 停止 + 还原代理
node packages/bridge/ctl.mjs ca install      # 装随包 CA
node packages/bridge/ctl.mjs proxy off       # 只退出接管（恢复客户端）
```

细节见 [`packages/capture/README.md`](packages/capture/README.md)。

## 导出可分发的 zip

```bash
python tools/pack_plugin.py
# -> dist/workbuddy-dsh-plugin-<version>.zip
```

解压后保持同级结构，根目录 `README.md` 就是使用指南：

```
workbuddy-dsh-plugin/
├── README.md              # 使用指南（来自 dsh-plugin-workbuddy/GUIDE.md）
├── install.cmd            # 双击：装插件 + 装证书 + 抓一次会话
├── install-ca.cmd         # 双击：只装证书
├── link.cmd               # 双击：复制桥接链接
├── stop-capture.cmd       # 双击：停抓包 + 还原代理
├── start-bridge.cmd       # 双击：只起本地网关（8790）
├── dsh-web.cmd            # 双击：起 DSH 网页端（3080），已在跑就直接打开
├── dsh-plugin-workbuddy/  # bundle + 安装器
├── bridge/                # 本地网关（install.mjs 用 ../bridge 找它）+ certs/
└── capture/               # mitmproxy 抓包插件
```

## 自测

```bash
node tools/dsh-selftest.mjs
```

用本机安装的 DSH 真实运行时（从 `app.asar` 解包）+ mock bridge 跑一次完整 agent 请求，
验证 `agent loop → llm-pi-ai → bridge → SSE` 全链路。不碰你正在用的 `~/.dsh`。

## 只想要 OpenAI 兼容端点

桥本身就是 OpenAI Chat Completions 兼容的，`/v1/models` + `/v1/chat/completions`：
任何客户端填 `http://127.0.0.1:8790/v1`、令牌取 `packages/bridge/.bridge-token` 即可。

不想自己拼，直接抓一份现成的（地址 + 令牌 + 模型 + `.env`/JSON/curl 片段）：

```bash
node packages/bridge/link.mjs          # 人读
node packages/bridge/link.mjs --json   # 机读
node packages/bridge/link.mjs --copy   # 复制地址+令牌到剪贴板
```

同一份数据在 Settings → WorkBuddy 的「桥接链接」卡片里，可一键复制。
bridge 没起时脚本会回落到本地令牌文件，仍能给出地址和令牌。

> 非官方集成。只驱动自己登录的账号，桥与抓包层只监听回环地址，会话默认只存内存。
