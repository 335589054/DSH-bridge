# certs/ —— 抓包用的本地 CA（随包附带）

这个目录里是 mitmproxy 用的**根证书 + 私钥**，随安装包一起分发，所以装完就能直接
「安装到本机 → 开始抓包」，不需要先跑一次抓包等它生成证书。

| 文件 | 用途 |
|---|---|
| `mitmproxy-ca.pem` | 私钥 + 证书，给 mitmdump 用（`--set confdir`） |
| `mitmproxy-ca-cert.pem` | 证书（PEM），Linux / 脚本用 |
| `mitmproxy-ca-cert.cer` | 证书（DER），Windows 双击安装用 |
| `install-ca.cmd` | 双击 → 装进「当前用户 → 受信任的根证书颁发机构」 |
| `uninstall-ca.cmd` | 双击 → 从当前用户证书库移除 |

证书主体（Subject）固定是：

```
C=CN, O=WorkBuddy Bridge, OU=Local Capture, CN=WorkBuddy Bridge Local CA
```

设置页判断「已信任」就是按这个 CN + 证书指纹（SHA-1）一起比对，同名但换过一代
CA 时不会误报。

## 为什么可以随包附带

抓包需要一个「本机自己签的根证书」：mitmdump 用它给 `copilot.tencent.com` 现签
叶子证书，浏览器/客户端只有信任这张根证书，才肯把明文的请求头交给我们。

mitmproxy 默认是在 `~/.mitmproxy/` 里**第一次运行时生成**一张，本包把它提前生成好
放进 `certs/`，并在启动 mitmdump 时用 `--set confdir=<bridge>/.ca` 指向这里复制出来
的那一份。好处：

- 装证书不再依赖「先抓一次包」这一步，也不会踩到「证书还没生成」的空窗
- 不去碰用户自己 `~/.mitmproxy` 里的那张 CA（那是别的工具在用的）
- 换机器、重装系统后证书是同一张，之前装过的信任不会失效

## 安全须知（请务必读一遍）

`mitmproxy-ca.pem` 里有**这张 CA 的私钥**。谁拿到它，谁就能给任意域名签证书；
如果某台机器信任了这张 CA，持有私钥的人就能解密那台机器的 HTTPS。

所以：

- 这张 CA **只应该装在你自己控制的机器上**，用完可以随时用 `uninstall-ca.cmd` 卸掉
- 不要把 `certs/` 里的私钥贴到公开仓库、网盘、群聊里
- 想每个部署一份独立 CA（更稳妥），自己重新生成一份替换掉本目录，见下

抓包本身也只监听 `127.0.0.1:8899`，代理不会暴露到局域网；会话令牌只存在内存里。

## 重新生成一份 CA（可选）

需要本机有 `openssl`（Windows 可用 Git Bash 自带的那份）：

```bash
cd packages/bridge/certs
openssl req -x509 -newkey rsa:2048 -sha256 -days 1825 -nodes \
  -keyout key.pem -out cert.pem \
  -subj "/C=CN/O=WorkBuddy Bridge/OU=Local Capture/CN=WorkBuddy Bridge Local CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,digitalSignature,keyCertSign,cRLSign" \
  -addext "subjectKeyIdentifier=hash"
cat key.pem cert.pem > mitmproxy-ca.pem
cp cert.pem mitmproxy-ca-cert.pem
openssl x509 -in cert.pem -outform DER -out mitmproxy-ca-cert.cer
rm key.pem cert.pem
```

换过 CA 之后要**重新装一次证书**（旧的可以先用 `uninstall-ca.cmd` 删掉）；
bridge 下次读状态时会把新的 CA 同步到 `.ca/`，mitmdump 重启后生效。
