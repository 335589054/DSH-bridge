# 本机会话捕获（capture）

目标：不申请 API Key、不解密登录文件，只从 WorkBuddy 客户端自己的 HTTPS 请求里
`Authorization` / `X-User-Id` / `Cookie` 等头取下来，交给 bridge 复用。

```
WorkBuddy 客户端 ──HTTPS──► mitmproxy(8899) ──► copilot.tencent.com
                                 │ 只读请求头
                                 ▼
                      POST /capture/session
                                 │
                        bridge(8790) 内存会话
                                 │
                     DSH 适配器转发时复用同一组头
```

抓包层**不修改**请求和响应，只旁路上报一次请求头。

## 1. 启动 bridge

```bash
node packages/bridge/server.mjs
# 记下日志里的 capture key 路径：packages/bridge/.capture-key
```

## 2. 安装 mitmproxy

```bash
pip install mitmproxy          # 或 winget install mitmproxy
```

## 3. 信任 CA（只需一次）

首次运行 mitmdump 会生成 `%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.cer`：

```bash
mitmdump --listen-port 8899    # 先跑一次生成证书，Ctrl+C 退出
certutil -addstore -user Root "%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.cer"
```

macOS：`security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain ~/.mitmproxy/mitmproxy-ca-cert.pem`

## 4. 启动抓包

```bash
# Windows Git Bash
WB_CAPTURE_KEY=$(cat packages/bridge/.capture-key) \
  mitmdump -s packages/capture/mitm_addon.py --listen-port 8899
```

Windows CMD：

```bat
set WB_CAPTURE_KEY=<.capture-key 的内容>
mitmdump -s packages\capture\mitm_addon.py --listen-port 8899
```

## 5. 让 WorkBuddy 走代理

产品里这一步由 bridge 自动完成（`POST /capture/start` → `bridge/workbuddy-client.mjs`）：
关掉客户端 → 带 `HTTP_PROXY` 重新拉起 → 客户端启动时自己 `session.setProxy`。
**不写注册表、不改系统代理、不需要管理员**。

手工验证时照做即可：

```bat
set HTTP_PROXY=http://127.0.0.1:8899
set HTTPS_PROXY=http://127.0.0.1:8899
start "" "D:\Program Files\WorkBuddy\WorkBuddy.exe"
```

> `WorkBuddy.exe --proxy-server=127.0.0.1:8899` 这条**不管用**：客户端启动时会走
> `configureRendererSessionProxy()`，读 `process.env.HTTP_PROXY || http_proxy` 并显式
> `session.setProxy()`；没设才回落到 `mode:'system'`。命令行开关会被它盖掉。

然后在 WorkBuddy 里**随便发一条消息**，触发一次对话请求。

## 6. 验证

```bash
curl -s http://127.0.0.1:8790/capture/status
# {"captured":true,"source":"mitmproxy","expiresAt":"...","userId":"..."}

curl -s http://127.0.0.1:8790/health
# auth.type = "captured"
```

之后 DSH 的请求就会被 bridge 用这组头转发出去。此时可以退出接管（客户端恢复普通启动）。

## 7. 会话时效

| 来源 | 有效期 | 失效表现 | 处理 |
|---|---|---|---|
| 桌面登录 token | 约 45 天 | 401 | 重新抓一次 |
| 浏览器授权 token | 约 1 小时 | 401 | 客户端会自动刷新，刷新时会再次被捕获 |

客户端每次刷新 token 都会发新请求，addon 会自动重新上报，所以只要客户端在正常用，
会话基本不会断。长时间不用导致过期时，回 WorkBuddy 发一条消息即可。

## 8. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `capture/status` 一直是 false | 客户端没走代理 | 面板「客户端接管」应为已接管；不行就手工按第 5 节设 `HTTP_PROXY` 再启动 |
| 出现证书错误 / 请求失败 | CA 没装进客户端信任区 | 装 CA 到「受信任的根证书颁发机构」；或临时用 `--ignore-certificate-errors` 启动 |
| 401 `CAPTURE_AUTH` | 抓包密钥不对 | 重新读 `.capture-key`，或设置 `WORKBUDDY_CAPTURE_KEY` |
| 抓到的是 `/v3/config` 而不是对话 | 没触发对话 | 在客户端发一条消息 |
| 想撤销会话 | — | `curl -X DELETE -H "x-capture-key: ..." http://127.0.0.1:8790/capture/session` |

## 9. 边界

- 抓包层只监听回环，bridge 也只监听回环。
- 会话默认只存内存；`WORKBUDDY_PERSIST=1` 才会落盘到 `packages/bridge/.session.json`（0600）。
- 这套做法依赖未公开接口，客户端升级可能失效；不要外传 token，不要在截图里露出请求头。
- 仅用于自己账号的本机开发，不做多账号池化或对外服务。
