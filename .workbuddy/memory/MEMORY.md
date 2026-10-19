# 项目长期约定

## 用户工作方式（影响方案选型）

- 用户**经常在外部用 WorkBuddy 远程控制**这台机器。任何需要「到桌面上点两下」的方案（改系统代理、装证书向导、重启桌面端）都不可行，除非明确说人回来了。
- 需要凭证时，优先选**可远程传递**的方式：贴 API Key / Bearer token 到对话里，由我注入；避免让用户操作 Windows 设置。
- WorkBuddy 的登录态是封的：`.info` 是 AES-GCM（`$wbEncrypted`），`keyblob` 的槽位是 `static-v1`，保护器密钥在 app.asar 里 —— 不逆向、不解密。

## 交付习惯

- 验证 UI 用 `.cache/drive.mjs`（Edge headless + CDP），临时 `DSH_HOME` + `--from-default-profile web`，不污染 `~/.dsh`。
  点完界面还要等异步取数，用 `--settle <ms>`，别指望 1.2s 就渲染完。
- 改完 bridge 记得切回 `live`，别把 mock 模式留在运行中。

## 本机 DSH 事实（省得每次重新挖）

- 桌面版自带 dsh CLI：`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`。
  已在本机 `C:\Users\33558\bin\dsh.cmd` 放了转发脚本（该目录本就在 PATH），直接 `dsh` 可用，版本 0.2.1-rc.2。
- 网页端：`dsh --profile web --no-open` → `http://127.0.0.1:3080/?token=…`（不带 token 返回 401）。
  token 换来的 cookie 名里带 **authority 哈希**、有效期 30 天，所以
  **`localhost:3080` 和 `127.0.0.1:3080` 是两套登录态**：用 localhost 打开会一直报
  `dsh web authentication required`，必须用 `127.0.0.1`。每次重启 token 变，cookie 随之失效。
- profile：桌面端用 `~/.dsh/profiles/desktop`，网页端用 `~/.dsh/profiles/web`；两边都要各装一次插件
  （`install.mjs --profile web`），不是共享的。
- 桌面版渲染进程 Origin 是 `app://app`，网页端是 `http://127.0.0.1:3080` —— 管理接口闸门两种都要过。

