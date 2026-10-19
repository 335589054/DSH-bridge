/**
 * WorkBuddy 凭证解析层
 *
 * 解析顺序（抓包优先，其余为兜底）：
 *   1. 抓包会话 —— 由 capture 层写入 sessionStore，bridge 优先使用（见 session.mjs）。
 *   2. WORKBUDDY_API_KEY   —— 可选兜底：官方 API Key（ck_ 开头）。
 *   3. WORKBUDDY_AUTH_FILE —— 显式指定的桌面登录文件（.info）。
 *   4. 自动探测桌面登录文件（国内版 workbuddy-desktop.info / 国际版 workbuddy-desktop-ai.info）。
 *
 * 桌面登录文件在 WorkBuddy 5.6.0 之后可能是 AtRest 加密信封（AES-256-GCM），
 * 本文件只处理「明文 JSON」形态；加密形态走抓包，见文档「凭证层」一节。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'

const AUTH_DIR_CANDIDATES = () => {
  const p = platform()
  if (p === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return [join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  if (p === 'darwin') {
    return [join(homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  return [
    join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  ]
}

const AUTH_FILE_NAMES = ['workbuddy-desktop.info', 'workbuddy-desktop-ai.info']

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

/** 从登录文件 JSON 里抽出统一结构 */
function pickFromInfo(info, file) {
  const accessToken = info.accessToken || info.access_token || info.token
  const refreshToken = info.refreshToken || info.refresh_token
  if (!accessToken) return null
  const jwt = decodeJwtPayload(accessToken) || {}
  return {
    type: 'desktop',
    token: accessToken,
    refreshToken,
    userId: info.userId || info.uid || jwt.sub || jwt.uid || '',
    domain: info.domain || info.host || 'copilot.tencent.com',
    expiresAt: (jwt.exp ? jwt.exp * 1000 : undefined) || info.expiresAt,
    source: file,
  }
}

function scanDesktop() {
  if (process.env.WORKBUDDY_AUTH_FILE) {
    const file = process.env.WORKBUDDY_AUTH_FILE
    if (!existsSync(file)) throw new Error(`WORKBUDDY_AUTH_FILE 不存在: ${file}`)
    return pickFromInfo(JSON.parse(readFileSync(file, 'utf8')), file)
  }
  for (const dir of AUTH_DIR_CANDIDATES()) {
    for (const name of AUTH_FILE_NAMES) {
      const file = join(dir, name)
      if (!existsSync(file)) continue
      const raw = readFileSync(file, 'utf8').trim()
      if (!raw.startsWith('{')) continue
      const info = JSON.parse(raw)
      if (JSON.stringify(info).includes('$wbEncrypted')) {
        throw new Error(
          `登录文件已加密（AtRest），无法直接读取: ${file}\n` +
            '改用抓包路径：启动 capture 代理，在 WorkBuddy 里发一条消息，让 bridge 捕获会话。',
        )
      }
      const picked = pickFromInfo(info, file)
      if (picked) return picked
    }
  }
  return null
}

/**
 * 兜底凭证解析。正常情况下 bridge 会先用抓包会话，只有会话缺失/过期才走到这里。
 * 返回 { type, token, userId, domain, expiresAt?, source? }
 */
export function resolveUpstreamAuth() {
  const apiKey = process.env.WORKBUDDY_API_KEY
  if (apiKey) {
    const jwt = decodeJwtPayload(apiKey)
    return {
      type: 'api-key',
      token: apiKey,
      userId: process.env.WORKBUDDY_USER_ID || jwt?.sub || '',
      domain: process.env.WORKBUDDY_DOMAIN || 'copilot.tencent.com',
      source: 'env:WORKBUDDY_API_KEY',
    }
  }
  const desktop = scanDesktop()
  if (!desktop) {
    throw new Error(
      '未捕获到 WorkBuddy 会话。请任选其一：\n' +
        '  1) 启动 capture 代理（packages/capture），在 WorkBuddy 里发一条消息（推荐）\n' +
        '  2) 设置 WORKBUDDY_API_KEY 作为兜底',
    )
  }
  return desktop
}

/** 只暴露长度、来源、有效期，绝不回传令牌明文 */
export function describeAuth(auth) {
  return {
    type: auth.type,
    source: auth.source ?? null,
    userId: auth.userId || null,
    domain: auth.domain,
    tokenLength: auth.token ? auth.token.length : 0,
    expiresAt: auth.expiresAt ?? null,
  }
}
