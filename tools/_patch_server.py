import io
import os

PATH = r"E:\workbuddytoharness\packages\bridge\server.mjs"
NEW = PATH + ".new"

text = io.open(PATH, encoding="utf-8").read()


def sub(old, new, count=1):
    global text
    assert old in text, "anchor not found: " + old[:60]
    text = text.replace(old, new, count)


# 1) import
sub(
    "import { resolveUpstreamAuth, describeAuth } from './credentials.mjs'\nimport { sessionStore } from './session.mjs'",
    "import { resolveUpstreamAuth, describeAuth } from './credentials.mjs'\n"
    "import { createAdmin } from './admin.mjs'\n"
    "import { sessionStore } from './session.mjs'",
)

# 2) admin 实例
sub(
    "const CAPTURE_KEY = process.env.WORKBUDDY_CAPTURE_KEY || loadOrCreate(CAPTURE_KEY_FILE, 'cap_')",
    "const CAPTURE_KEY = process.env.WORKBUDDY_CAPTURE_KEY || loadOrCreate(CAPTURE_KEY_FILE, 'cap_')\n"
    "\n"
    "// 抓包环境的运维面（安装 mitmproxy / 装 CA / 起停代理），只给本机 UI 用\n"
    "const admin = createAdmin({\n"
    "  dir: __dirname,\n"
    "  bridgePort: PORT,\n"
    "  captureKey: CAPTURE_KEY,\n"
    "  addonPath: join(__dirname, '..', 'capture', 'mitm_addon.py'),\n"
    "})",
)

# 3) CORS 头
sub(
    "res.setHeader('access-control-allow-headers', 'authorization, content-type, x-capture-key')",
    "res.setHeader('access-control-allow-headers', 'authorization, content-type, x-capture-key, x-bridge-admin')",
)

# 4) 管理接口（插在 /health 之前）
sub(
    "  if (url.pathname === '/health') {",
    """  // —— 抓包环境运维面（DSH 设置页调用）——
  if (
    url.pathname.startsWith('/setup/') ||
    url.pathname === '/proxy' ||
    url.pathname === '/capture/start' ||
    url.pathname === '/capture/stop'
  ) {
    if (!checkAdmin(req, res)) return
    const body = req.method === 'POST' ? await readJsonBody(req) : {}
    if (url.pathname === '/setup/status') return json(res, 200, await admin.status())
    if (url.pathname === '/setup/install' && req.method === 'POST') return json(res, 200, await admin.install())
    if (url.pathname === '/setup/ca' && req.method === 'POST') return json(res, 200, await admin.installCa())
    if (url.pathname === '/proxy' && req.method === 'POST') return json(res, 200, await admin.setProxy(body.enabled !== false))
    if (url.pathname === '/capture/start' && req.method === 'POST')
      return json(res, 200, await admin.startCapture({ proxy: body.proxy !== false }))
    if (url.pathname === '/capture/stop' && req.method === 'POST')
      return json(res, 200, await admin.stopCapture({ proxy: body.proxy !== false }))
    return openaiError(res, 404, `未知管理接口: ${req.method} ${url.pathname}`, 'NOT_FOUND')
  }

  if (url.pathname === '/health') {""",
)

# 5) 辅助函数
sub(
    "const server = http.createServer(async (req, res) => {",
    """/**
 * 管理接口的本地护栏（不是鉴权）：
 *   - 必须带 x-bridge-admin: 1（浏览器跨站请求带不了自定义头，等于挡掉 CSRF）
 *   - Origin 必须是回环地址；带本地令牌的脚本可以直接过
 */
function checkAdmin(req, res) {
  const origin = req.headers.origin
  const loopbackOrigin =
    !origin || /^https?:\\/\\/(127\\.0\\.0\\.1|localhost|\\[::1\\])(:\\d+)?$/.test(origin)
  const authed = (req.headers.authorization || '') === `Bearer ${LOCAL_TOKEN}`
  if (!loopbackOrigin && !authed) {
    openaiError(res, 403, '管理接口只接受本机页面调用', 'ADMIN_ORIGIN')
    return false
  }
  if (req.headers['x-bridge-admin'] !== '1' && !authed) {
    openaiError(res, 401, '缺少 x-bridge-admin 头', 'ADMIN_HEADER')
    return false
  }
  return true
}

async function readJsonBody(req) {
  try {
    const text = await readBody(req)
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

const server = http.createServer(async (req, res) => {""",
)

io.open(NEW, "w", encoding="utf-8", newline="").write(text)
try:
    os.replace(NEW, PATH)
    print("server.mjs 已更新")
except PermissionError as e:
    print("replace failed, fallback:", e)
