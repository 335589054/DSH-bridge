/**
 * 会话捕获存储
 *
 * 不做凭据解密、不申请 API Key：只接收本地抓包工具从 WorkBuddy 客户端自己的请求里
 * 摘下来的鉴权头，存在内存里，后续由 bridge 转发时复用。
 *
 * 约束：
 *   - 只存内存，不落盘（除非显式开启 WORKBUDDY_PERSIST=1，且文件权限 0600）
 *   - 只保留白名单头，避免把 accept-encoding / content-length 之类带进重放请求
 *   - token 过期时间从 JWT 的 exp 解析；解析不到就标记为 unknown，由上游 401 兜底
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_FILE = process.env.WORKBUDDY_SESSION_FILE || join(__dirname, '.session.json')

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
    if (process.env.WORKBUDDY_PERSIST === '1' && existsSync(STORE_FILE)) {
      try {
        this.session = JSON.parse(readFileSync(STORE_FILE, 'utf8'))
      } catch {
        this.session = null
      }
    }
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
    if (process.env.WORKBUDDY_PERSIST === '1') {
      writeFileSync(STORE_FILE, JSON.stringify(session, null, 2), { mode: 0o600 })
      try {
        chmodSync(STORE_FILE, 0o600)
      } catch {
        /* Windows 上 chmod 语义有限，忽略 */
      }
    }
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
    if (!this.session) return { captured: false }
    const expired = Boolean(this.session.expiresAt && Date.now() > this.session.expiresAt)
    return {
      captured: true,
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

  clear() {
    this.session = null
  }
}

export const sessionStore = new SessionStore()
