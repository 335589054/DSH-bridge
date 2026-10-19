# dsh-plugin-workbuddy

把 WorkBuddy 订阅模型接进 DeepSeek Harness 的 bundle 插件。

它不是"自己实现一个 LLM 适配器"，而是把 DSH 自带的 `@deepseek-ai/dsh-llm-pi-ai`
配置成一条**手写网关路由**，指向本机的 bridge（`../bridge`）：

```
DSH agent loop → llm-pi-ai(providers.workbuddy) → http://127.0.0.1:8790/v1 → WorkBuddy
```

流式解析、工具调用分片、usage 账本、重试策略都由 DSH 自己的代码承担，
本插件只负责三件事：**路由配置、凭证引用、bridge 常驻**。

## 安装

```bash
node install.mjs                    # 只装插件（证书/抓包自己在设置页点）
node install.mjs --quick            # 插件 + 随包 CA + 抓一次会话（一步到位）
node install.mjs --quick --default-model   # 顺便把默认模型设为 workbuddy/auto
node install.mjs --ca               # 只补装随包 CA
node install.mjs --profile web      # 装到别的 profile
node install.mjs --uninstall        # 还原（bundle 登记 + 补丁 + 凭证引用）
```

安装器做四件事：

1. 探活 / 拉起 bridge
2. 把令牌写进 `$DSH_HOME/.credentials.yaml` 的 `refs:`
3. **把本包登记成 profile 的 bundle**（`dependencies` + `dsh.profile.bundles`，
   并在 `node_modules` 里建目录联接）——Plugins 页只列 bundle，纯补丁不会出现在插件列表里
4. 写路由补丁。登记成 bundle 后路由由 bundle 提供，此时会摘掉用户补丁里的旧托管块，
   避免同一行被覆盖两次（Plugins 页的开关才会真的生效）

`--quick` 追加两步：装 `../bridge/certs/` 里随包附带的 CA → 开抓包 → 等 120s
（`--wait` 可调）抓到会话后自动停抓包并把客户端恢复正常启动。

| 参数 | 说明 |
|---|---|
| `--profile <name>` | 默认 `desktop` |
| `--port <n>` | bridge 端口，默认 `8790` |
| `--quick` | 安装 + 装证书 + 抓一次会话 |
| `--ca` | 只装随包 CA |
| `--capture` / `--no-capture` | 装完是否抓包 |
| `--wait <秒>` | 抓包等待上限，默认 120 |
| `--default-model[=<id>]` | 把 `agent-default-model` 指到 `workbuddy/<id>`，默认 `auto` |
| `--force` | 允许覆盖补丁里别人写的 `llm-pi-ai` 行 |
| `--no-start` | 不自动拉起 bridge |
| `--no-bundle` | 只写路由补丁，不登记成 bundle（插件列表里不会出现） |

改动前会写 `.workbuddy-backup-<ts>` 备份（同一文件只保留最近 3 份）。
完整操作说明见 **GUIDE.md**，安装细节见 **INSTALL.md**。

## 设置页（抓包环境面板）

`client.js` 往 `settings.section` 注册了一个页面（导航里叫 **WorkBuddy**），
所有按钮都直接打 bridge 的管理接口：

| 面板动作 | 接口 |
|---|---|
| 读状态 | `GET /setup/status` —— Python / mitmproxy / CA / 代理 / 抓包 / 安装进度（`?fresh=1` 跳过 30s 探测缓存，"重新检测"用） |
| 桥接链接 | `GET /setup/link` —— 地址 / 令牌 / 模型 + `.env`、JSON、curl 片段 |
| 安装环境 | `POST /setup/install` —— 在 `bridge/.tools/mitm` 建 venv 并 `pip install mitmproxy` |
| 装证书 | `POST /setup/ca` —— 装 `bridge/certs/` 随包 CA（`certutil -user -addstore -f Root`，免管理员；被拦时回 `manual:true` 并给出 `install-ca.cmd` 路径） |
| 开始抓包 | `POST /capture/start` —— 起 `mitmdump --listen-host 127.0.0.1`，并重启客户端注入 `HTTP_PROXY`（不写注册表） |
| 停止抓包 | `POST /capture/stop` —— 结束 mitmdump，客户端按接管前的环境重新拉起 |
| 代理开关 | `POST /proxy` —— HKCU 注册表 + WinINet 刷新 |
| 局域网 | `POST /setup/lan` `{enabled}` —— 热切监听地址（`127.0.0.1` ↔ `0.0.0.0`），并校验能否绑定 |
| API 密钥 | `GET/POST /setup/keys`、`POST /setup/keys/{enable,delete,verify}` —— 生成（明文仅返回一次）/ 启停 / 删除 / 本地校验 |
| API 开关 | `POST /setup/api` `{name, enabled}` —— `chat` / `models` 可分别关闭（503 `API_DISABLED`） |
| 会话记忆 | `GET/POST /setup/session` —— 「记住会话」开关：关闭只存内存；开启则落盘 `bridge/.session.json`（0600），网关重启仍可用 |

管理接口的护栏：必须带 `x-bridge-admin: 1`，且 `Origin` 必须是回环地址
（端口不同无所谓 —— DSH 设置页本身就跑在另一个回环端口上；非回环来源一律 403，
等于挡掉 CSRF）；带本地令牌的脚本可以直连。
界面不落状态，全部以 `/setup/status` 为准，3 秒轮询且页面隐藏时暂停；
`/setup/status` 在 bridge 侧有 1.5 秒短缓存，避免轮询把 python/certutil/reg 反复拉起来。

## 证书（随包）

抓包要有一张本机自签的根证书。它现在**随包附带**在 `../bridge/certs/`，不再需要
「先跑一次抓包去生成」：

- mitmdump 启动时带 `--set confdir=<bridge>/.ca`，`.ca/` 由 `certs/` 同步而来
- 设置页按「CN = `WorkBuddy Bridge Local CA`」查当前用户根证书库判断是否已信任
- 写证书库被安全策略拦下时（受限环境常见），接口回 `manual: true`，UI 给出
  `bridge/certs/install-ca.cmd` 的路径和可复制的 `certutil` 命令
- 「开始抓包」前置检查：证书没装就直接拒绝并说明原因，避免用户看到一片 TLS 错误

证书私钥在包里，只应装在受控机器上；想每个部署一张独立 CA 见 `../bridge/certs/README.md`。

## 桥接链接

「桥接链接」卡片把任何 OpenAI 兼容客户端要填的东西一次给全：`http://127.0.0.1:8790/v1`
+ 令牌 + 模型，可一键复制成「地址+令牌」/`.env`/JSON/curl。

命令行等价物在 `../bridge/link.mjs`：

```bash
node ../bridge/link.mjs          # 人读
node ../bridge/link.mjs --json   # 机读
node ../bridge/link.mjs --copy   # 复制地址+令牌
```

## 卸载 / 排障

```bash
node install.mjs --uninstall
curl -s http://127.0.0.1:8790/health     # ok / authReady / capture
curl -s http://127.0.0.1:8790/capture/status
```

`/health` 的两个字段要分开看：

- `ok: true` —— bridge 在服务
- `authReady: false` —— 还没有可用凭证（需要抓一次 WorkBuddy 会话，见 `../capture/README.md`）

插件列表里看不到本插件时，按顺序查：

```bash
# 1. profile 清单里有没有登记
cat ~/.dsh/profiles/desktop/package.json       # dsh.profile.bundles 应含 dsh-plugin-workbuddy

# 2. 目录联接在不在
ls ~/.dsh/profiles/desktop/node_modules/dsh-plugin-workbuddy

# 3. 补丁层有没有真的加载（把 desktop 复制成别的名字再 dump）
dsh --profile <副本名> --dump-default-config | grep -A3 dsh-plugin-workbuddy
```

## 换模型

`models.json` 是唯一事实来源，`cordis.patch.yml` 与已安装的 profile 补丁都由它渲染：

```bash
node sync-models.mjs            # 从 bridge /v1/models 抓（bridge 需可用凭证）
node sync-models.mjs --offline  # 只用现有 models.json 重渲染
```

DSH 的手写网关要求显式列出模型，所以上游换模型后要重跑一次。

## bundle 形态

```yaml
# cordis.patch.yml（由 sync-models 生成）
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      workbuddy:
        api: openai-completions
        baseURL: 'http://127.0.0.1:8790/v1'
        apiKeyEnv: 'WORKBUDDY_BRIDGE_TOKEN'
        compat: { thinkingFormat: deepseek }
        models: [...]
```

两个必须知道的约束：

1. **`- id: llm-pi-ai` 是覆盖，不是新增**。插第二行同 id 的适配器会让 profile 加载失败。
2. **覆盖是整块替换**，所以会覆盖你在别处给 `llm-pi-ai` 配的其它 provider；
   安装器检测到这种情况会要求 `--force`。

另外：在 DSH 里改设置（例如换默认模型）会让 config-editor **重写整个
`cordis.patch.yml`**（去注释、重排格式）。所以路由放在 bundle 层更稳，
`--no-bundle` 模式下写进用户补丁的托管块注释可能会被抹掉（配置本身保留）。

## 已验证范围

- 补丁在真实 DSH 运行时（0.2.1-rc.2）里通过 `--dump-config` / `--dump-default-config` 组合
- `apiKeyEnv` 能从 `$DSH_HOME/.credentials.yaml` 的 `refs:` 解析
- bundle 层解析正常：`# == @deepseek-ai/dsh-base, patched by dsh-plugin-workbuddy`
- headless profile 跑通 `agent loop → llm-pi-ai → bridge → SSE`（`tools/dsh-selftest.mjs`）
- 未验证：真实上游（需先抓包）、桌面 UI 里的渲染效果
