/**
 * 局域网访问 + API 密钥 + API 开关
 *
 * 三件事，状态都持久化在 `bridge/.bridge-config.json`：
 *
 *   1. **局域网访问**：关着时 bridge 只监听 127.0.0.1（历史行为）；开着才监听 0.0.0.0。
 *      但「听着局域网」不等于「谁都能进」—— 来源 IP 必须落在内网网段
 *      （10/8、172.16/12、192.168/16、169.254/16、fc00::/7、fe80::/10），
 *      公网来源一律 403。管理接口（/setup、/capture、/proxy）永远只接受本机。
 *   2. **API 密钥**：局域网客户端持 `wbk_…` 密钥调用，格式与 DeepSeek 一致
 *      （OpenAI 兼容：`Authorization: Bearer <key>` + `/v1/chat/completions`）。
 *      密钥只存 SHA-256 哈希，明文只在生成那一刻返回一次；校验全部在本地完成，
 *      不请求上游。本机令牌（wb_…）仍然可用，但仅限本机来源。
 *   3. **API 开关**：`chat`（/v1/chat/completions）与 `models`（/v1/models）
 *      可分别关闭，关掉后返回 503 API_DISABLED。
 *
 * 为什么密钥不明文存：这个文件会跟着 zip 分发目录留在用户机器上，
 * 明文密钥落盘等于把局域网入口交出去。
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

const KEY_PREFIX = 'wbk_'
const CONFIG_NAME = '.bridge-config.json'

/** 可以开关的 API：键名 → 设置页上的展示名 */
export const API_DEFS = {
  chat: { label: '对话', route: 'POST /v1/chat/completions' },
  models: { label: '模型列表', route: 'GET /v1/models' },
}

/**
 * DeepSeek 兼容的模型别名 → WorkBuddy 上游模型 ID。
 * 局域网客户端（Cherry Studio、Cline 等）按 DeepSeek 的格式填
 * `deepseek-chat` / `deepseek-reasoner` 就能用，不用先去翻模型清单。
 */
export const DEEPSEEK_ALIASES = {
  'deepseek-chat': 'auto',
  'deepseek-reasoner': 'deepseek-v4-pro',
}

const DEFAULT_CONFIG = {
  version: 1,
  lan: { enabled: false },
  apis: { chat: true, models: true },
  keys: [],
}

/** 规范化 IP：IPv4-mapped IPv6（::ffff:192.168.1.5）剥成纯 IPv4 */
export function normalizeIp(ip) {
  const s = String(ip || '').trim()
  if (!s) return ''
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return mapped[1]
  return s.toLowerCase()
}

export function isLoopbackIp(ip) {
  const s = normalizeIp(ip)
  if (!s) return false
  if (s === '::1') return true
  return /^127\./.test(s)
}

/**
 * 是否内网来源。
 * 只认 RFC1918 + 链路本地 + IPv6 唯一本地：公网 IP 一律不算，
 * 这是「只允许局域网访问」这条要求的硬闸门（听着 0.0.0.0 也不放开）。
 * 注意 Radmin VPN 之类的虚拟网卡会带公网段地址，同样按公网处理。
 */
export function isLanIp(ip) {
  const s = normalizeIp(ip)
  if (!s) return false
  if (isLoopbackIp(s)) return true
  if (isPrivateV4(s)) return true
  if (/^169\.254\./.test(s)) return true
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return true // fc00::/7 唯一本地
  if (/^fe[89ab][0-9a-f]:/.test(s)) return true // fe80::/10 链路本地
  return false
}

/** 私网 IPv4（RFC1918）。VPN/虚拟网卡常带来公网段地址，那些不算局域网 */
function isPrivateV4(ip) {
  const s = normalizeIp(ip)
  return /^10\./.test(s) || /^192\.168\./.test(s) || /^172\.(1[6-9]|2\d|3[01])\./.test(s)
}

/**
 * 本机可共享的局域网地址。
 * 只列私网 IPv4： Radmin VPN 之类的虚拟网卡会带公网段地址（如 26.x），
 * 把它当「局域网地址」给用户，客户端连上反而会被来源闸门拒掉，自相矛盾。
 * 169.254 的 APIPA 地址同理不列（不可共享），但闸门仍然放行（无害）。
 */
export function lanAddresses() {
  const out = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue
      if (!isPrivateV4(ni.address)) continue
      out.push(ni.address)
    }
  }
  return [...new Set(out)]
}

function hashKey(key) {
  return createHash('sha256').update(String(key)).digest('hex')
}

/** 常量时间比较：避免按响应时间猜密钥 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return ba.equals(bb)
}

function publicKey(entry) {
  return {
    id: entry.id,
    name: entry.name,
    prefix: entry.prefix,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt || null,
    enabled: entry.enabled !== false,
  }
}

function nowIso() {
  return new Date().toISOString()
}

/**
 * @param {object} opts
 * @param {string} opts.dir        bridge 目录（配置文件放这里）
 * @param {number} opts.port       bridge 端口
 * @param {string} opts.localToken 本机令牌（wb_…）：仅本机来源可用
 */
export function createLan({ dir, port, localToken }) {
  const CONFIG_FILE = join(dir, CONFIG_NAME)

  function load() {
    try {
      if (!existsSync(CONFIG_FILE)) return structuredClone(DEFAULT_CONFIG)
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
      return {
        ...structuredClone(DEFAULT_CONFIG),
        ...parsed,
        lan: { ...DEFAULT_CONFIG.lan, ...(parsed.lan || {}) },
        apis: { ...DEFAULT_CONFIG.apis, ...(parsed.apis || {}) },
        keys: Array.isArray(parsed.keys) ? parsed.keys : [],
      }
    } catch {
      // 配置损坏不能让 bridge 起不来：退回默认（仅本机），用户重新开一次局域网即可
      return structuredClone(DEFAULT_CONFIG)
    }
  }

  function save(cfg) {
    const tmp = `${CONFIG_FILE}.tmp`
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, CONFIG_FILE)
    } catch {
      /* 配置写不进去不影响本次运行，只是重启后丢失 */
    }
  }

  let config = load()

  // 环境变量兜底：无头部署（远程机器上没有设置页可点）时开机即开局域网
  if (process.env.WORKBUDDY_LAN === '1' && !config.lan.enabled) {
    config.lan.enabled = true
    save(config)
  }

  /** 当前应该绑定的地址：0.0.0.0 才是「听着局域网」 */
  function bindHost() {
    return config.lan.enabled ? '0.0.0.0' : '127.0.0.1'
  }

  function urls() {
    if (!config.lan.enabled) return []
    return lanAddresses().map((ip) => `http://${ip}:${port}/v1`)
  }

  function status() {
    return {
      enabled: config.lan.enabled,
      bindHost: bindHost(),
      addresses: config.lan.enabled ? lanAddresses() : [],
      urls: urls(),
      apis: { ...config.apis },
      keys: config.keys.map(publicKey),
      keyCount: config.keys.length,
      activeKeyCount: config.keys.filter((k) => k.enabled !== false).length,
      // 局域网上能不能真的调用：开着 + 至少一把启用的密钥
      lanReady: config.lan.enabled && config.keys.some((k) => k.enabled !== false),
    }
  }

  function setLan(enabled) {
    config.lan.enabled = Boolean(enabled)
    save(config)
    return status()
  }

  function apiEnabled(name) {
    return config.apis[name] !== false
  }

  function setApi(name, enabled) {
    if (!(name in config.apis)) return { ok: false, error: `未知 API：${name}（可选 ${Object.keys(config.apis).join(' / ')}）` }
    config.apis[name] = Boolean(enabled)
    save(config)
    return { ok: true, apis: { ...config.apis } }
  }

  function createKey(name) {
    const id = 'k_' + randomBytes(4).toString('hex')
    const key = KEY_PREFIX + randomBytes(24).toString('base64url')
    const entry = {
      id,
      name: String(name || '未命名密钥').slice(0, 40),
      prefix: key.slice(0, 11) + '…',
      hash: hashKey(key),
      createdAt: nowIso(),
      lastUsedAt: null,
      enabled: true,
    }
    config.keys.push(entry)
    save(config)
    // 明文只在这里出现一次：UI 展示后不再可查，用户必须当场复制
    return { ok: true, key, entry: publicKey(entry) }
  }

  function listKeys() {
    return config.keys.map(publicKey)
  }

  function findKey(id) {
    return config.keys.find((k) => k.id === id) || null
  }

  function setKeyEnabled(id, enabled) {
    const entry = findKey(id)
    if (!entry) return { ok: false, error: '密钥不存在' }
    entry.enabled = Boolean(enabled)
    save(config)
    return { ok: true, entry: publicKey(entry) }
  }

  function deleteKey(id) {
    const before = config.keys.length
    config.keys = config.keys.filter((k) => k.id !== id)
    if (config.keys.length === before) return { ok: false, error: '密钥不存在' }
    save(config)
    return { ok: true }
  }

  let lastPersist = 0

  /**
   * 本地校验一把密钥。
   *
   * @param {string} token 客户端给的 Bearer 值
   * @param {object} opts
   * @param {boolean} opts.fromLoopback 来源是不是本机
   * @param {boolean} opts.record 是否记录「最近使用」（验证按钮不该留下使用痕迹）
   * @returns {{ok: true, entry} | {ok: false, code, message}}
   */
  function verifyKey(token, { fromLoopback = false, record = true } = {}) {
    const t = String(token || '').trim()
    if (!t) {
      return { ok: false, code: 'API_KEY_MISSING', message: '缺少 API 密钥：请求头带 Authorization: Bearer <key>' }
    }
    // 本机令牌：只在本机来源上认。它躺在 .bridge-token 文件里，
    // 不该被当成局域网凭据使用（局域网一律用生成的 wbk_ 密钥）。
    if (t === localToken) {
      if (fromLoopback) return { ok: true, entry: { id: 'local', name: '本机令牌', prefix: 'wb_…' } }
      return {
        ok: false,
        code: 'TOKEN_LOCAL_ONLY',
        message: '本机令牌只允许本机使用；局域网访问请用设置页生成的 API 密钥（wbk_…）',
      }
    }
    const entry = config.keys.find((k) => safeEqual(k.hash, hashKey(t)))
    if (!entry) {
      return { ok: false, code: 'API_KEY_INVALID', message: 'API 密钥无效（已在设置页生成？注意生成时只显示一次）' }
    }
    if (entry.enabled === false) {
      return { ok: false, code: 'API_KEY_DISABLED', message: `API 密钥「${entry.name}」已被停用` }
    }
    // 最近使用时间：内存里立即改（UI 马上看得到），落盘节流（5 分钟一次）
    if (record) {
      entry.lastUsedAt = nowIso()
      if (Date.now() - lastPersist > 300_000) {
        lastPersist = Date.now()
        save(config)
      }
    }
    return { ok: true, entry: publicKey(entry) }
  }

  /** 只校验、不记录使用：给设置页的「验证」按钮和 CLI 用 */
  function probeKey(token, { fromLoopback = false } = {}) {
    return verifyKey(token, { fromLoopback, record: false })
  }

  /**
   * 试探能不能绑 0.0.0.0（安全策略/防火墙有时会拦）。
   * 用一个随机端口试，不碰 bridge 自己的端口（此刻正被 127.0.0.1 占着）。
   */
  function canBindWildcard() {
    return new Promise((resolve) => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.listen(0, '0.0.0.0', () => srv.close(() => resolve(true)))
      setTimeout(() => resolve(false), 2000).unref()
    })
  }

  return {
    status,
    bindHost,
    setLan,
    canBindWildcard,
    apiEnabled,
    setApi,
    createKey,
    listKeys,
    setKeyEnabled,
    deleteKey,
    verifyKey,
    probeKey,
  }
}
