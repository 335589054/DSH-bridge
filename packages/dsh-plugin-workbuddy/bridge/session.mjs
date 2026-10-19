/**
 * 会话捕获存储
 *
 * 不做凭据解密、不申请 API Key：只接收本地抓包工具从 WorkBuddy 客户端自己的请求里
 * 摘下来的鉴权头，存在内存里，后续由 bridge 转发时复用。
 *
 * 约束：
 *   - **默认只存内存**；用户可在设置页打开「记住会话」，或部署时给 WORKBUDDY_PERSIST=1
 *   - 落盘文件 `.session.json` 权限 0600，位置在 bridge 目录（已 gitignore）
 *   - 只保留白名单头，避免把 accept-encoding / content-length 之类带进重放请求
 *   - token 过期时间从 JWT 的 exp 解析；解析不到就标记为 unknown，由上游 401 兜底
 *
 * 「记住会话」的必要性：bridge 由 DSH 拉起，重装插件 / 重启 DSH 都会换一份进程，
 * 内存里的会话随之丢失，用户就得再抓一次。开启后重启仍能复用，直到 JWT 过期。
 */

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_FILE = process.env.WORKBUDDY_SESSION_FILE || join(__dirname, '.session.json')
/** 「记住会话」开关的落点：与 .session.json 分开，清会话不该把偏好一起清掉 */
const PREFS_FILE = process.env.WORKBUDDY_SESSION_PREFS || join(__dirname, '.session-prefs.json')

/** 允许重放的请求头白名单 */
const ALLOWED = [
  'authorization',
  'cookie',
  'user-agent',
  'x-user-id',
  'x-domain',
  'x-product',
  'x-ide-type',
  'x-request-id',
  'x-trace-id',
  'x-client-version',
  'x-tenant-id',
  'origin',
  'referer',
  'accept-language',
]

function decodeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1]
    if (!part) return null
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

function filterHeaders(input) {
  const out = {}
  for (const [k, v] of Object.entries(input || {})) {
    const key = String(k).toLowerCase()
    if (!ALLOWED.includes(key)) continue
    if (typeof v !== 'string' || !v) continue
    out[key] = v
  }
  return out
}

class SessionStore {
  constructor() {
    this.session = null
    this.persist = this.readPrefs()
    if (this.persist) this.restore()
  }

  /**
   * 「是否落盘」的初始值：环境变量优先（无头部署开机即记住），
   * 否则读用户在设置页存下的偏好。默认关闭 —— 这是既定决策。
   */
  readPrefs() {
    if (process.env.WORKBUDDY_PERSIST === '1') return true
    try {
      if (existsSync(PREFS_FILE)) {
        const parsed = JSON.parse(readFileSync(PREFS_FILE, 'utf8'))
        return parsed.persist === true
      }
    } catch {
      /* 偏好文件损坏就按关闭处理，不影响启动 */
    }
    return false
  }

  writePrefs() {
    try {
      writeFileSync(PREFS_FILE, JSON.stringify({ persist: this.persist }, null, 2) + '\n', { mode: 0o600 })
      chmodSync(PREFS_FILE, 0o600)
    } catch {
      /* 写不进去只影响下次启动的默认值，不影响本次运行 */
    }
  }

  /** 从磁盘恢复会话（启动时、或刚打开开关时） */
  restore() {
    try {
      if (!existsSync(STORE_FILE)) return false
      const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || !parsed.headers) return false
      this.session = parsed
      return true
    } catch {
      this.session = null
      return false
    }
  }

  saveToDisk() {
    if (!this.session) return false
    try {
      writeFileSync(STORE_FILE, JSON.stringify(this.session, null, 2), { mode: 0o600 })
      chmodSync(STORE_FILE, 0o600)
      return true
    } catch {
      return false
    }
  }

  removeDisk() {
    try {
      rmSync(STORE_FILE, { force: true })
    } catch {
      /* 删不掉也不影响内存态 */
    }
  }

  /**
   * 切换「记住会话」。
   * 打开时：把当前内存里的会话立刻落盘（这样用户不必重抓一次）。
   * 关闭时：删掉磁盘副本，回到只存内存。
   */
  setPersist(on) {
    this.persist = Boolean(on)
    this.writePrefs()
    if (this.persist) {
      if (this.session) this.saveToDisk()
    } else {
      this.removeDisk()
    }
    return this.persist
  }

  /** 磁盘上是否有一份可用的会话副本 */
  persisted() {
    return this.persist && existsSync(STORE_FILE)
  }

  /** @param {{headers: Record<string,string>, source?: string, path?: string}} payload */
  capture(payload) {
    const headers = filterHeaders(payload.headers)
    const auth = headers.authorization
    if (!auth) throw new Error('抓包内容里没有 authorization 头')

    const token = auth.replace(/^Bearer\s+/i, '')
    const jwt = decodeJwtPayload(token) || {}
    const session = {
      headers,
      source: payload.source || 'unknown',
      path: payload.path || null,
      userId: headers['x-user-id'] || jwt.sub || jwt.uid || '',
      domain: headers['x-domain'] || jwt.aud || 'copilot.tencent.com',
      tokenLength: token.length,
      capturedAt: Date.now(),
      expiresAt: jwt.exp ? jwt.exp * 1000 : null,
    }
    this.session = session
    if (this.persist) this.saveToDisk()
    return session
  }

  /** 返回可直接用于上游请求的鉴权信息，过期则返回 null */
  get() {
    if (!this.session) return null
    if (this.session.expiresAt && Date.now() > this.session.expiresAt - 30_000) return null
    return {
      type: 'captured',
      token: this.session.headers.authorization.replace(/^Bearer\s+/i, ''),
      authHeader: this.session.headers.authorization,
      headers: this.session.headers,
      userId: this.session.userId,
      domain: this.session.domain,
      expiresAt: this.session.expiresAt,
      source: this.session.source,
    }
  }

  status() {
    const persisted = this.persisted()
    if (!this.session) return { captured: false, persist: this.persist, persisted }
    const expired = Boolean(this.session.expiresAt && Date.now() > this.session.expiresAt)
    return {
      captured: true,
      persist: this.persist,
      persisted,
      source: this.session.source,
      capturedAt: new Date(this.session.capturedAt).toISOString(),
      expiresAt: this.session.expiresAt ? new Date(this.session.expiresAt).toISOString() : null,
      expired,
      userId: this.session.userId || null,
      domain: this.session.domain || null,
      tokenLength: this.session.tokenLength,
      headers: Object.keys(this.session.headers),
    }
  }

  /** 清空会话：内存与磁盘一起清，避免下次启动又捡起作废的令牌 */
  clear() {
    this.session = null
    this.removeDisk()
  }
}

export const sessionStore = new SessionStore()
