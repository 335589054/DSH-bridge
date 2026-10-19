#!/usr/bin/env node
/**
 * WorkBuddy LLM Bridge
 *
 * 把 WorkBuddy 订阅模型导出为 OpenAI Chat Completions 兼容接口，供 DeepSeek Harness
 * 的自定义 LLM 适配器（或任意 OpenAI 客户端）调用。
 *
 * 凭证来源以「本地抓包」为主：客户端自己的请求里带着 Authorization / X-User-Id 等头，
 * capture 层把这一组头摘下来 POST 给本服务，之后由本服务原样转发复用。
 * 不做文件解密、不申请 API Key、不额外开配额。
 *
 * 设计要点：
 *   - 默认只监听 127.0.0.1；局域网访问要在设置页显式打开，且仅接受内网来源
 *     （10/8、172.16/12、192.168/16、169.254/16、fc00::/7），公网来源一律 403
 *   - 管理接口（/setup、/capture、/proxy）无论局域网开不开都只接受本机
 *   - 上游只接受流式请求，这里强制 stream:true 并原样转发 SSE
 *   - 上游对请求结构比 OpenAI 更严：developer→system、tool_choice 收敛为字符串、
 *     首条必须是 system —— 全部在 normalize() 里一次做完
 *   - 本地令牌只防同机误用，不是上游凭证；局域网客户端用设置页生成的 API 密钥
 *     （wbk_…，只存哈希，本地校验），请求格式与 DeepSeek 一致
 *
 * 环境变量：
 *   WORKBUDDY_PORT          监听端口，默认 8790
 *   WORKBUDDY_UPSTREAM      上游 base，默认 https://copilot.tencent.com/v2
 *   WORKBUDDY_LOCAL_TOKEN   本地访问令牌；不设则自动生成到 .bridge-token
 *   WORKBUDDY_CAPTURE_KEY   抓包上报密钥；不设则自动生成到 .capture-key
 *   WORKBUDDY_TIMEOUT_MS    单次上游请求超时，默认 600000
 *   WORKBUDDY_KEEPALIVE_MS  流式保活间隔，默认 15000；<=0 关闭
 *   WORKBUDDY_MOCK=1        离线联调，不请求上游，返回构造好的 SSE
 *
 * 实验特性（**不进正式产品**，两个变量都要给才生效）：
 *   WORKBUDDY_EXPERIMENTAL=1
 *   WORKBUDDY_GATEWAY_URL   改走本机远程控制网关（如 http://127.0.0.1:46285）：
 *                           chat 请求会被翻译成「往当前 WorkBuddy 会话注入一条消息」，
 *                           再把 SSE 转回 OpenAI 流。会真的污染那个会话。
 *   WORKBUDDY_GATEWAY_AUTH  网关的 Bearer 口令（CODEBUDDY_GATEWAY_PASSWORD）
 */

import http from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveUpstreamAuth, describeAuth } from './credentials.mjs'
import { createAdmin, pushLog } from './admin.mjs'
import { createLan, isLanIp, isLoopbackIp, normalizeIp, DEEPSEEK_ALIASES } from './lan.mjs'
import { sessionStore } from './session.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.WORKBUDDY_PORT || 8790)
// 监听地址不是常量：局域网开关会随时改它（127.0.0.1 ↔ 0.0.0.0），见 applyBind()
let bindHost = '127.0.0.1'
const MOCK = process.env.WORKBUDDY_MOCK === '1'
const UPSTREAM_BASE = (process.env.WORKBUDDY_UPSTREAM || 'https://copilot.tencent.com/v2').replace(/\/$/, '')

/**
 * 实验特性闸门。
 * 网关模式会把 chat 请求翻译成「往当前 WorkBuddy 会话注入一条消息」，
 * 副作用是真实的：那条消息会落进会话、agent 会真的执行工具。仅用于联调，
 * **正式产品不启用**。必须同时给 WORKBUDDY_EXPERIMENTAL=1 才认 GATEWAY_URL，
 * 只设 GATEWAY_URL 会在启动时告警并按 live 处理，避免环境变量残留把产品带偏。
 */
const EXPERIMENTAL = process.env.WORKBUDDY_EXPERIMENTAL === '1'
const GATEWAY_URL = EXPERIMENTAL ? (process.env.WORKBUDDY_GATEWAY_URL || '').replace(/\/$/, '') : ''
const GATEWAY_AUTH = EXPERIMENTAL ? process.env.WORKBUDDY_GATEWAY_AUTH || '' : ''
const GATEWAY_IGNORED = Boolean(process.env.WORKBUDDY_GATEWAY_URL) && !EXPERIMENTAL

/** 运行形态：正式产品恒为 live（要么没凭证，要么真实转发） */
const MODE = MOCK ? 'mock' : GATEWAY_URL ? 'gateway' : 'live'
const TOKEN_FILE = join(__dirname, '.bridge-token')
const CAPTURE_KEY_FILE = join(__dirname, '.capture-key')
const MAX_BODY = 32 * 1024 * 1024

// WorkBuddy 客户端实际下发的模型 ID（取自客户端日志的 cli.models）
const FALLBACK_MODELS = [
  'auto',
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.2',
  'glm-5.1',
  'glm-5v-turbo',
  'kimi-k3-1',
  'kimi-k2.8-preview',
  'minimax-m3',
  'hy3',
  'hy3-x',
  'hy4-preview',
  'hy4-preview-f',
]

function loadOrCreate(file, prefix) {
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  const value = prefix + randomBytes(24).toString('hex')
  writeFileSync(file, value + '\n', { mode: 0o600 })
  return value
}

const LOCAL_TOKEN = process.env.WORKBUDDY_LOCAL_TOKEN || loadOrCreate(TOKEN_FILE, 'wb_')
const CAPTURE_KEY = process.env.WORKBUDDY_CAPTURE_KEY || loadOrCreate(CAPTURE_KEY_FILE, 'cap_')

// 局域网访问 / API 密钥 / API 开关：配置在 .bridge-config.json，重启不丢
const lan = createLan({ dir: __dirname, port: PORT, localToken: LOCAL_TOKEN })
bindHost = lan.bindHost()

// 抓包环境的运维面（安装 mitmproxy / 装 CA / 起停代理），只给本机 UI 用
// addon 的两种落点：
//   1) git/npm 安装形态：capture 打进 bridge 内 <bridge>/capture/mitm_addon.py
//   2) 仓库/zip 源码形态：capture 是 bridge 的同级目录 ../capture/mitm_addon.py
const CAPTURE_ADDON =
  existsSync(join(__dirname, 'capture', 'mitm_addon.py'))
    ? join(__dirname, 'capture', 'mitm_addon.py')
    : join(__dirname, '..', 'capture', 'mitm_addon.py')
const admin = createAdmin({
  dir: __dirname,
  bridgePort: PORT,
  captureKey: CAPTURE_KEY,
  addonPath: CAPTURE_ADDON,
})

/** 抓包会话优先；过期或缺失才回落到 API Key / 桌面文件 */
function currentAuth() {
  const captured = sessionStore.get()
  if (captured) return captured
  return resolveUpstreamAuth()
}

/**
 * 凭证体检 —— 设置页和 /health 共用。
 * 产品只有一条取凭证的路：抓包。所以这里要明确回答「现在能不能用、不能用该做什么」。
 */
function credentialsState() {
  const capture = sessionStore.status()
  const capturedReady = Boolean(capture.captured && !capture.expired)
  let fallback = null
  let fallbackError = null
  try {
    fallback = describeAuth(resolveUpstreamAuth())
  } catch (err) {
    fallbackError = err.message
  }
  const ready = capturedReady || Boolean(fallback)
  const expired = Boolean(capture.captured && capture.expired)
  return {
    ready,
    // 抓包会话是首选来源
    capture,
    fallback,
    needsCapture: !ready,
    hint: ready
      ? null
      : expired
        ? '抓包凭证已过期：重新「开始抓包」，并在 WorkBuddy 里发一条消息'
        : '还没有凭证：在设置页「开始抓包」，然后在 WorkBuddy 里发一条消息',
    fallbackError,
  }
}

function upstreamHeaders(auth) {
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  }
  // 抓包拿到的头优先：UA、X-*、cookie 全是客户端当时真实发送的值
  if (auth.headers) {
    for (const [k, v] of Object.entries(auth.headers)) {
      if (k === 'content-type' || k === 'accept' || k === 'host' || k === 'content-length') continue
      headers[k] = v
    }
  }
  headers.authorization = auth.authHeader || `Bearer ${auth.token}`
  // 抓包头不全时兜底
  headers['user-agent'] ||= 'WorkBuddy/5.5.6'
  headers['x-product'] ||= 'SaaS'
  headers['x-ide-type'] ||= 'WorkBuddy'
  headers['x-domain'] ||= auth.domain || 'copilot.tencent.com'
  if (auth.userId && !headers['x-user-id']) headers['x-user-id'] = auth.userId
  return headers
}

const DEFAULT_SYSTEM = 'You are WorkBuddy, a helpful AI assistant.'

/**
 * 上游请求结构归一化。
 * 这里处理的每一条都对应一个真实出现过的上游报错。
 */
function normalize(body) {
  const out = { ...body }
  out.stream = true // 上游拒绝非流式
  delete out.max_completion_tokens // 与 max_tokens 冲突
  delete out.stream_options

  let messages = Array.isArray(out.messages) ? out.messages : []
  messages = messages.map((m) => ({
    ...m,
    role: m.role === 'developer' ? 'system' : m.role,
  }))
  if (messages.length === 0 || messages[0].role !== 'system') {
    messages.unshift({ role: 'system', content: DEFAULT_SYSTEM })
  }
  out.messages = messages

  if (out.tool_choice && typeof out.tool_choice === 'object') {
    // OpenAI 的 {type:'function',function:{name}} 上游不认，只接受字符串
    const kind = out.tool_choice.type
    out.tool_choice = kind === 'required' || kind === 'none' ? kind : 'auto'
  }
  if (out.tools && out.tools.length === 0) delete out.tools
  return out
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function openaiError(res, status, message, code, extra = {}) {
  json(res, status, { error: { message, type: 'workbuddy_bridge_error', code, ...extra } })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * OpenAI 兼容面的鉴权（DeepSeek 同款：Authorization: Bearer <key>）。
 *
 * 两档凭据：
 *   - 本机令牌（wb_…）：只在本机来源上认，DSH 自己走这条
 *   - API 密钥（wbk_…）：设置页生成，本机和局域网都认，哈希本地比对
 */
function checkApiAuth(req, res) {
  const fromLoopback = isLoopbackIp(normalizeIp(req.socket.remoteAddress))
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const r = lan.verifyKey(token, { fromLoopback })
  if (r.ok) return true
  openaiError(res, 401, r.message, r.code)
  return false
}

function checkCaptureKey(req, res) {
  const key = req.headers['x-capture-key']
  if (key && key === CAPTURE_KEY) return true
  openaiError(res, 401, '抓包密钥无效：请使用 bridge 生成的 WORKBUDDY_CAPTURE_KEY', 'CAPTURE_AUTH')
  return false
}

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** 离线联调：构造一段包含 reasoning、正文、工具调用的 SSE */
function mockStream(res, body) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const model = body.model || FALLBACK_MODELS[0]
  const id = 'chatcmpl-mock-' + Date.now()
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }))
  for (const text of ['Hello', ' from', ' WorkBuddy', ' bridge.']) {
    res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }))
  }
  res.write(
    sseChunk({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }),
  )
  res.write('data: [DONE]\n\n')
  res.end()
}

/** 取一条 OpenAI 消息的纯文本（content 可能是字符串，也可能是 parts 数组） */
function messageText(m) {
  if (!m) return ''
  const c = m.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
      .trim()
  }
  return ''
}

/** DSH 追加的提醒块；它不是用户敲的字 */
const REMINDER_BLOCK = /<system-reminder\b[\s\S]*?<\/system-reminder>/gi

function stripReminders(text) {
  return String(text || '').replace(REMINDER_BLOCK, '').trim()
}

/** 最后一条 user 消息的原文（不脱敏），用来判断「这条是不是纯提醒」 */
function lastRawUserText(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (!m || m.role !== 'user') continue
    const t = messageText(m)
    if (t.trim()) return t
  }
  return ''
}

/**
 * 最后一条「真实用户消息」的文本 —— 网关注入只认这一条。
 *
 * 坑：DSH 会把 <system-reminder>…</system-reminder> 追加在用户消息之后，
 * 有时直接作为一条独立的 user 消息。若单纯取最后一条 user，
 * 抓到的就是提醒正文，用户真正说的话（如「你好」）会被整条丢掉。
 * 所以必须剥掉提醒块再判空，并把纯提醒的消息跳过。
 */
function lastUserText(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (!m || m.role !== 'user') continue
    const t = stripReminders(messageText(m))
    if (t) return t
  }
  return ''
}

/**
 * DSH 除真实对话外还会发辅助请求（会话标题、纯 system-reminder、上下文压缩）。
 * 这些一旦被注入会话就是纯污染，必须拦在本机。
 * 注意：判断依据必须是「剥掉提醒后的正文」，否则带提醒的真实提问会被误杀。
 */
function auxKind(body) {
  const raw = lastRawUserText(body)
  if (!raw.trim()) return 'empty'
  const text = lastUserText(body)
  // 整条只有提醒，没有用户正文
  if (!text) return 'system-reminder'
  if (/generate the session title/i.test(text)) return 'title'
  if (/^(?:summarize|compress|condense) (?:the )?(?:conversation|history|context)/i.test(text)) return 'compact'
  // 超长单条几乎都是 DSH 拼进去的上下文，不是用户敲的字
  if (text.length > 4000) return 'oversized'
  return null
}

/** 辅助请求的本地应答：不进会话，但让 DSH 侧拿到一个合法回复 */
function auxStream(res, body, kind) {
  const model = body.model || FALLBACK_MODELS[0]
  const id = 'chatcmpl-aux-' + Date.now()
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  const text =
    kind === 'title' ? 'DSH × WorkBuddy' : '（bridge 网关模式：内部辅助请求，未注入会话）'
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }))
  res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }))
  res.write(
    sseChunk({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  )
  res.write('data: [DONE]\n\n')
  res.end()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 走本机远程控制网关（WorkBuddy 的 46285 口）：
 *   chat 请求 → POST /api/v1/runs 注入当前会话 → GET .../stream 把事件翻成 OpenAI chunk
 * 副作用是真的：那条用户消息会落进当前会话，agent 会真的回一遍。
 */
async function proxyViaGateway(res, body) {
  const text = lastUserText(body)
  if (!text) return openaiError(res, 400, '请求里没有可注入的用户消息', 'NO_PROMPT')

  const model = body.model || FALLBACK_MODELS[0]
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), Number(process.env.WORKBUDDY_TIMEOUT_MS || 600000))
  res.on('close', () => {
    clearTimeout(timer)
    ac.abort()
  })
  const authHeader = GATEWAY_AUTH ? { authorization: `Bearer ${GATEWAY_AUTH}` } : {}

  // 1) 注入
  const msgId = randomUUID()
  let runId
  try {
    const r = await fetch(`${GATEWAY_URL}/api/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader },
      body: JSON.stringify({ id: msgId, type: 'text', text }),
      signal: ac.signal,
    })
    const raw = await r.text()
    let parsed = {}
    try {
      parsed = JSON.parse(raw)
    } catch {
      /* 网关可能回 HTML */
    }
    if (!r.ok) {
      clearTimeout(timer)
      console.log(`[chat:gateway] inject ${r.status} ${raw.slice(0, 200)}`)
      return openaiError(res, 502, `网关拒绝注入: ${raw.slice(0, 600)}`, parsed?.error?.code || 'GATEWAY_INJECT_FAILED')
    }
    runId = parsed?.data?.runId || parsed?.runId
  } catch (err) {
    clearTimeout(timer)
    return openaiError(res, 502, `连接网关失败: ${err.message}`, 'GATEWAY_UNREACHABLE')
  }
  if (!runId) {
    clearTimeout(timer)
    return openaiError(res, 502, '网关没有返回 runId', 'GATEWAY_NO_RUN_ID')
  }
  console.log(`[chat:gateway] injected run=${runId} model=${model} text="${text.slice(0, 60)}"`)

  // 2) 订阅。run 结束得很快时 stream 会 404，短暂重试
  let upstream = null
  for (let attempt = 0; attempt < 5 && !upstream; attempt++) {
    try {
      const r = await fetch(`${GATEWAY_URL}/api/v1/runs/${runId}/stream`, { headers: authHeader, signal: ac.signal })
      if (r.status === 404) {
        await sleep(250)
        continue
      }
      if (!r.ok) {
        clearTimeout(timer)
        return openaiError(res, 502, `订阅网关流失败: HTTP ${r.status}`, 'GATEWAY_STREAM_FAILED')
      }
      upstream = r
    } catch (err) {
      if (attempt === 4) {
        clearTimeout(timer)
        return openaiError(res, 502, `订阅网关流失败: ${err.message}`, 'GATEWAY_STREAM_FAILED')
      }
      await sleep(250)
    }
  }
  if (!upstream) {
    clearTimeout(timer)
    return openaiError(res, 502, '网关流已结束（run 太快查不到），注入本身是成功的', 'GATEWAY_RUN_GONE')
  }

  // 3) 翻译成 OpenAI 流
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const id = 'chatcmpl-gw-' + Date.now()
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }))

  const decoder = new TextDecoder()
  let buf = ''
  let acc = ''
  let done = false
  try {
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true })
      let cut
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, cut)
        buf = buf.slice(cut + 2)
        let event = 'message'
        const dataLines = []
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        if (!dataLines.length) continue
        let payload
        try {
          payload = JSON.parse(dataLines.join('\n'))
        } catch {
          continue
        }
        if (event === 'done') {
          done = true
          break
        }
        if (event === 'error') {
          const msg = payload?.error || '网关流报错'
          res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: `\n\n[网关错误] ${msg}` }, finish_reason: null }] }))
          done = true
          break
        }
        const status = payload?.status
        if (status === 'streaming') {
          const t = payload?.content?.chunk
          if (typeof t === 'string' && t) {
            acc += t
            res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] }))
          }
        } else if (status === 'completed') {
          // 没有增量帧（比如极短回复）时，用全文补一次
          const full = payload?.content?.markdown ?? payload?.content?.text ?? ''
          if (!acc && typeof full === 'string' && full) {
            acc = full
            res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: full }, finish_reason: null }] }))
          }
        } else if (status === 'error') {
          const msg = payload?.error?.message || payload?.error?.code || '任务失败'
          res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: `\n\n[任务失败] ${msg}` }, finish_reason: null }] }))
          done = true
          break
        }
      }
      if (done) break
    }
  } catch (err) {
    res.write(sseChunk({ error: { message: String(err.message || err), code: 'STREAM_INTERRUPTED' } }))
  } finally {
    clearTimeout(timer)
    res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
    res.write('data: [DONE]\n\n')
    res.end()
    console.log(`[chat:gateway] run=${runId} done, ${acc.length} chars`)
  }
}

/** 上游状态码 → 对外状态码：4xx 原样保留（客户端要能区分 400/401/403/429），5xx 收敛成 502 */
function passthroughStatus(status) {
  if (status === 429) return 429
  if (status >= 400 && status < 500) return status
  return 502
}

/**
 * live 模式：原样转发到上游 chat/completions，并把 SSE 透传给客户端。
 *
 * 生产上的三个必需动作：
 *   1) 抓包凭证被 401 时立刻作废并换兜底凭证重试一次 —— 否则旧令牌会让后续每个请求都撞墙；
 *   2) 上游开流后常有一段静默（推理阶段），定时补 SSE 注释行防止连接被中间层掐断；
 *   3) 客户端断开必须连带 abort 上游，避免请求悬挂把配额一直占着。
 */
async function proxyStream(res, body, auth, attempt = 0) {
  const ac = new AbortController()
  const started = Date.now()
  const timer = setTimeout(() => ac.abort(), Number(process.env.WORKBUDDY_TIMEOUT_MS || 600000))
  res.on('close', () => {
    clearTimeout(timer)
    ac.abort()
  })

  let upstream
  try {
    upstream = await fetch(`${UPSTREAM_BASE}/chat/completions`, {
      method: 'POST',
      headers: upstreamHeaders(auth),
      body: JSON.stringify(body),
      signal: ac.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    return openaiError(res, 502, `连接上游失败: ${err.message}`, 'UPSTREAM_UNREACHABLE')
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '')
    clearTimeout(timer)
    console.log(`[chat] upstream ${upstream.status} ${text.slice(0, 200)}`)

    // 抓包凭证被上游拒绝：立即作废，别让后续请求继续拿死令牌
    if (upstream.status === 401 && auth.type === 'captured') {
      sessionStore.clear()
      if (attempt === 0) {
        let next = null
        try {
          next = currentAuth()
        } catch {
          next = null
        }
        if (next) {
          console.log(`[chat] 抓包凭证已失效，改用 ${next.type} 重试一次`)
          return proxyStream(res, body, next, attempt + 1)
        }
      }
      return openaiError(
        res,
        401,
        '上游拒绝了抓包凭证（已失效或过期）。请到设置页重新「开始抓包」，并在 WorkBuddy 里发一条消息让它重新上报。',
        'AUTH_EXPIRED',
      )
    }

    let code = 'UPSTREAM_ERROR'
    try {
      const parsed = JSON.parse(text)
      code = parsed.code ?? parsed.error?.code ?? code
    } catch {
      /* 上游可能返回 HTML */
    }
    return openaiError(res, passthroughStatus(upstream.status), text.slice(0, 800) || 'upstream error', code)
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  // 上游开流后到首个 token 之间可能就是几十秒。
  // SSE 注释行（以 ":" 开头）会被所有客户端忽略，但足以让连接保持“有流量”。
  const KA_MS = Number(process.env.WORKBUDDY_KEEPALIVE_MS || 15000)
  let ka = null
  const armKeepalive = () => {
    if (!(KA_MS > 0)) return
    if (ka) clearTimeout(ka)
    ka = setTimeout(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n')
      armKeepalive()
    }, KA_MS)
  }
  const disarmKeepalive = () => {
    if (ka) clearTimeout(ka)
    ka = null
  }

  let bytes = 0
  try {
    armKeepalive()
    for await (const chunk of upstream.body) {
      disarmKeepalive()
      bytes += chunk.length
      res.write(chunk)
      armKeepalive()
    }
  } catch (err) {
    // 已经进入流式，只能以错误事件收尾，不能改状态码
    res.write(sseChunk({ error: { message: String(err.message || err), code: 'STREAM_INTERRUPTED' } }))
  } finally {
    disarmKeepalive()
    clearTimeout(timer)
    res.end()
    console.log(
      `[chat] done model=${body.model} auth=${auth.type} ${bytes}B ${Date.now() - started}ms` +
        (attempt ? ` (retry ${attempt})` : ''),
    )
  }
}

async function listModels(auth) {
  // 上游没有 /models。产品模型清单来自 GET /v3/config；失败时回退到静态目录。
  try {
    const r = await fetch(`${UPSTREAM_BASE.replace(/\/v2$/, '')}/v3/config`, {
      headers: upstreamHeaders(auth),
    })
    if (r.ok) {
      const cfg = await r.json()
      const models = cfg?.data?.models || cfg?.models || []
      if (Array.isArray(models) && models.length) {
        return models.map((m) => {
          const id = typeof m === 'string' ? m : m.id || m.model
          return {
            id,
            object: 'model',
            owned_by: 'workbuddy',
            context_window: (typeof m === 'object' && (m.contextWindow || m.context_window)) || undefined,
            input: (typeof m === 'object' && m.input) || ['text'],
          }
        })
      }
    }
  } catch {
    /* 目录抓取失败不影响对话 */
  }
  return FALLBACK_MODELS.map((id) => ({ id, object: 'model', owned_by: 'workbuddy' }))
}

/**
 * 管理接口的本地护栏（不是鉴权）：
 *   - 来源必须是本机：局域网开着也不行，装机凭证、抓包开关不该暴露给同网段的人
 *   - 必须带 x-bridge-admin: 1（浏览器跨站请求带不了自定义头，等于挡掉 CSRF）
 *   - Origin 必须是回环地址；带本地令牌的脚本可以直接过
 *
 * 注意：DSH 的设置页跑在它自己的回环端口上（例如 127.0.0.1:53211），
 * 对 bridge 来说 Origin 不同端口 —— 浏览器会标成 sec-fetch-site: cross-site。
 * 早期版本按 cross-site 一律拒绝，结果设置页每次读状态都是 403，面板永远打不开。
 * 真正的边界是 Origin 必须是回环地址，端口不同不算风险。
 */
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

/**
 * 桌面壳的 Origin。
 *
 * DSH 桌面版的渲染进程是从 `app://app/` 加载的（Electron 自定义协议），
 * 既不是 127.0.0.1，也不是 file://（file:// 的 Origin 头是字符串 "null"）。
 * 早期只认回环 http 来源，结果桌面版设置页每个请求都吃 403，
 * 面板上只剩「网关未连接 / 管理接口只接受本机页面调用」。
 *
 * 放行自定义 scheme 不降低安全性：网页无法伪造 app:// 这类 Origin，
 * 浏览器里的跨站请求一定带 http(s) Origin 或 null。
 */
const SHELL_ORIGIN = /^(app|dsh|file|electron|vscode-webview):\/\//i

function isLoopbackOrigin(origin) {
  return origin === 'null' || LOOPBACK_ORIGIN.test(origin)
}

/** 管理接口的可信来源：无 Origin（脚本/curl）、回环 http、桌面壳自定义协议 */
function isTrustedAdminOrigin(origin) {
  return !origin || origin === 'null' || LOOPBACK_ORIGIN.test(origin) || SHELL_ORIGIN.test(origin)
}

function checkAdmin(req, res) {
  if (!isLoopbackIp(normalizeIp(req.socket.remoteAddress))) {
    openaiError(res, 403, '管理接口只接受本机调用（局域网访问开着也不例外）', 'ADMIN_LOCAL_ONLY')
    return false
  }
  const authed = (req.headers.authorization || '') === `Bearer ${LOCAL_TOKEN}`
  if (authed) return true
  const origin = req.headers.origin
  if (!isTrustedAdminOrigin(origin)) {
    // 把被拒的 Origin 记下来：下次「设置页打不开」时直接看日志就知道是哪种来源
    pushLog(admin.log, `[admin] 拒绝来源 ${String(origin).slice(0, 60)} → ${req.method} ${req.url}`)
    openaiError(res, 403, `管理接口只接受本机页面调用（来源 ${String(origin).slice(0, 60)}）`, 'ADMIN_ORIGIN')
    return false
  }
  if (req.headers['x-bridge-admin'] !== '1') {
    openaiError(res, 401, '缺少 x-bridge-admin 头', 'ADMIN_HEADER')
    return false
  }
  return true
}

/** 令牌只在本机暴露，展示时留头尾，避免整串落在截图/日志里 */
function maskToken(token) {
  const t = String(token || '')
  if (t.length <= 12) return '•'.repeat(t.length)
  return `${t.slice(0, 6)}…${t.slice(-4)}`
}

/** 机读的模型目录（models.json 由 sync-models 生成，缺失时回退内置） */
function loadModelIds() {
  // 两种落点：git/npm 形态下 bridge 在 <pkg>/bridge、models.json 在上一级；仓库/zip 形态下是 ../dsh-plugin-workbuddy/models.json
  const candidates = [
    join(__dirname, '..', 'models.json'),
    join(__dirname, '..', 'dsh-plugin-workbuddy', 'models.json'),
  ]
  for (const file of candidates) {
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        const list = Array.isArray(parsed) ? parsed : parsed.models
        const ids = (list || []).map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean)
        if (ids.length) return ids
      }
    } catch {
      /* 目录只是展示用，读失败不影响对话 */
    }
  }
  return [...FALLBACK_MODELS]
}

/**
 * 「桥接链接」：把 DSH 之外任何 OpenAI 客户端要填的三样东西一次给全。
 * 设置页、`link.mjs` 脚本、curl 都读这一份，避免两边各拼一套。
 * 局域网开着时额外给出内网地址和 DeepSeek 别名，客户端按 DeepSeek 的格式填就能用。
 */
function linkInfo() {
  const lanStatus = lan.status()
  const baseUrl = lanStatus.enabled && lanStatus.urls.length ? lanStatus.urls[0] : `http://127.0.0.1:${PORT}/v1`
  const models = loadModelIds()
  const model = models[0] || 'auto'
  const capture = sessionStore.status()
  return {
    ok: true,
    baseUrl,
    endpoint: `${baseUrl}/chat/completions`,
    modelsUrl: `${baseUrl}/models`,
    apiKey: LOCAL_TOKEN,
    apiKeyMasked: maskToken(LOCAL_TOKEN),
    provider: 'workbuddy',
    defaultModel: model,
    models,
    mode: MODE,
    upstream: GATEWAY_URL || UPSTREAM_BASE,
    captured: Boolean(capture.captured),
    capture,
    lan: {
      enabled: lanStatus.enabled,
      urls: lanStatus.urls,
      addresses: lanStatus.addresses,
      lanReady: lanStatus.lanReady,
      keyCount: lanStatus.keyCount,
    },
    // 局域网客户端按 DeepSeek 的用法填：baseUrl + deepseek-chat/deepseek-reasoner + wbk_ 密钥
    deepseek: {
      baseUrl: lanStatus.enabled ? baseUrl : null,
      aliases: DEEPSEEK_ALIASES,
      models: Object.keys(DEEPSEEK_ALIASES),
    },
    copyText: [
      'WorkBuddy 桥接（OpenAI Chat Completions 兼容）',
      `地址：${baseUrl}`,
      `令牌：${LOCAL_TOKEN}`,
      `模型：${model}`,
    ].join('\n'),
    snippets: {
      env: `OPENAI_BASE_URL=${baseUrl}\nOPENAI_API_KEY=${LOCAL_TOKEN}`,
      json: JSON.stringify({ baseURL: baseUrl, apiKey: LOCAL_TOKEN, model }, null, 2),
      curl:
        `curl -s ${baseUrl}/chat/completions \\\n` +
        `  -H "authorization: Bearer ${LOCAL_TOKEN}" \\\n` +
        '  -H "content-type: application/json" \\\n' +
        `  -d '{"model":"${model}","stream":true,"messages":[{"role":"user","content":"ping"}]}'`,
    },
    fetchedAt: new Date().toISOString(),
  }
}

async function readJsonBody(req) {
  try {
    const text = await readBody(req)
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  // 只读端点 + 抓包上报开放 CORS，便于浏览器里的本地控制台与抓包工具直接调用。
  // 回环 / 桌面壳来源按原样回显；管理接口不给 *（否则网页就能带上 x-bridge-admin 试一把），
  // 其余公开端点仍给 * —— 没有 API 密钥本来也拿不到东西。
  const reqOrigin = req.headers.origin
  const isAdminPath =
    url.pathname.startsWith('/setup/') ||
    url.pathname === '/proxy' ||
    url.pathname === '/capture/start' ||
    url.pathname === '/capture/stop'
  if (reqOrigin && (isLoopbackOrigin(reqOrigin) || SHELL_ORIGIN.test(reqOrigin))) {
    res.setHeader('access-control-allow-origin', reqOrigin)
    res.setHeader('vary', 'origin')
  } else if (!isAdminPath) {
    res.setHeader('access-control-allow-origin', '*')
  }
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-capture-key, x-bridge-admin')
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('access-control-max-age', '600')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  // —— 来源闸门：只允许局域网 ——
  // 本机永远放行；其余来源必须在「局域网已开启」且落在内网网段里。
  // 听着 0.0.0.0 也不等于对外开放，这一层就是「只允许局域网访问」的硬边界。
  const clientIp = normalizeIp(req.socket.remoteAddress)
  const fromLoopback = isLoopbackIp(clientIp)
  if (!fromLoopback) {
    if (!lan.status().enabled) {
      return openaiError(res, 403, 'bridge 只监听本机；需要局域网访问请到 DSH 设置页 → WorkBuddy 开启', 'LAN_DISABLED')
    }
    if (!isLanIp(clientIp)) {
      return openaiError(
        res,
        403,
        `只允许局域网来源：${clientIp || '未知地址'} 不在内网网段（10.x / 172.16-31.x / 192.168.x）`,
        'LAN_ONLY',
      )
    }
  }

  // —— 抓包上报：capture 层把客户端请求头 POST 进来 ——
  if (url.pathname === '/capture/session' && req.method === 'POST') {
    if (!checkCaptureKey(req, res)) return
    try {
      const payload = JSON.parse(await readBody(req))
      const session = sessionStore.capture(payload)
      return json(res, 200, {
        ok: true,
        capturedAt: new Date(session.capturedAt).toISOString(),
        expiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null,
        userId: session.userId || null,
        source: session.source,
      })
    } catch (err) {
      return openaiError(res, 400, err.message, 'CAPTURE_FAILED')
    }
  }

  if (url.pathname === '/capture/status' && req.method === 'GET') {
    return json(res, 200, sessionStore.status())
  }

  if (url.pathname === '/capture/session' && req.method === 'DELETE') {
    if (!checkCaptureKey(req, res)) return
    sessionStore.clear()
    return json(res, 200, { ok: true })
  }

  // —— 抓包环境运维面 + 桥接链接 + 局域网/密钥（DSH 设置页调用）——
  if (
    url.pathname.startsWith('/setup/') ||
    url.pathname === '/proxy' ||
    url.pathname === '/capture/start' ||
    url.pathname === '/capture/stop'
  ) {
    if (!checkAdmin(req, res)) return
    const body = req.method === 'POST' ? await readJsonBody(req) : {}
    if (url.pathname === '/setup/status') {
      const s = await admin.status({ fresh: url.searchParams.get('fresh') === '1' })
      return json(res, 200, { ...s, lan: lan.status() })
    }
    if (url.pathname === '/setup/link') return json(res, 200, linkInfo())
    if (url.pathname === '/setup/install' && req.method === 'POST') return json(res, 200, await admin.install())
    if (url.pathname === '/setup/ca' && req.method === 'POST') return json(res, 200, await admin.installCa())
    if (url.pathname === '/proxy' && req.method === 'POST') return json(res, 200, await admin.setProxy(body.enabled !== false))
    if (url.pathname === '/capture/start' && req.method === 'POST')
      return json(res, 200, await admin.startCapture({ proxy: body.proxy !== false }))
    if (url.pathname === '/capture/stop' && req.method === 'POST')
      return json(res, 200, await admin.stopCapture({ proxy: body.proxy !== false }))

    // —— 局域网开关：改了监听地址，进程内热切换，不用重启 ——
    if (url.pathname === '/setup/lan' && req.method === 'POST') {
      const enabled = body.enabled !== false
      if (enabled && !(await lan.canBindWildcard())) {
        return json(res, 200, {
          ok: false,
          error: '这台机器不允许绑定 0.0.0.0（安全策略或防火墙限制），局域网访问无法开启',
        })
      }
      const st = lan.setLan(enabled)
      applyBind(st.bindHost)
      pushLog(admin.log, `[lan] ${enabled ? '局域网访问已开启（仅内网来源）' : '局域网访问已关闭，恢复仅本机监听'}`)
      return json(res, 200, { ok: true, lan: st })
    }

    // —— API 密钥 ——
    if (url.pathname === '/setup/keys' && req.method === 'GET') {
      return json(res, 200, { ok: true, keys: lan.listKeys() })
    }
    if (url.pathname === '/setup/keys' && req.method === 'POST') {
      const r = lan.createKey(body.name)
      pushLog(admin.log, `[lan] 已生成 API 密钥「${r.entry.name}」（${r.entry.prefix}）`)
      return json(res, 200, r)
    }
    if (url.pathname === '/setup/keys/enable' && req.method === 'POST') {
      const r = lan.setKeyEnabled(String(body.id || ''), body.enabled !== false)
      return json(res, 200, r)
    }
    if (url.pathname === '/setup/keys/delete' && req.method === 'POST') {
      return json(res, 200, lan.deleteKey(String(body.id || '')))
    }
    if (url.pathname === '/setup/keys/verify' && req.method === 'POST') {
      // 本地校验：不比上游、不发任何请求，回答「这把钥匙能不能开、能开哪些 API」
      const r = lan.probeKey(String(body.key || ''), { fromLoopback: true })
      if (!r.ok) return json(res, 200, { ok: false, error: r.message, code: r.code })
      const st = lan.status()
      return json(res, 200, {
        ok: true,
        entry: r.entry,
        lan: { enabled: st.enabled, lanReady: st.lanReady },
        apis: Object.fromEntries(Object.entries(st.apis).map(([k, v]) => [k, v !== false])),
        message: st.enabled
          ? `密钥有效：${r.entry.name}`
          : `密钥有效：${r.entry.name}（局域网未开启，目前仅本机可用）`,
      })
    }

    // —— API 开关 ——
    if (url.pathname === '/setup/api' && req.method === 'POST') {
      const r = lan.setApi(String(body.name || ''), body.enabled !== false)
      if (r.ok) pushLog(admin.log, `[lan] API ${body.name} 已${body.enabled !== false ? '开启' : '关闭'}`)
      return json(res, 200, r)
    }
    return openaiError(res, 404, `未知管理接口: ${req.method} ${url.pathname}`, 'NOT_FOUND')
  }

  if (url.pathname === '/health') {
    const credentials = credentialsState()
    const lanStatus = lan.status()
    return json(res, 200, {
      // ok 只表示 bridge 自身在服务；凭证是否就绪看 authReady
      ok: true,
      service: 'workbuddy-bridge',
      // 进程级信息：start.cmd 与 DSH 的 host 半体用它判断「这份 bridge 是不是该换掉」
      pid: process.pid,
      mode: MODE,
      upstream: GATEWAY_URL || UPSTREAM_BASE,
      gateway: GATEWAY_URL || null,
      auth: credentials.capture.captured ? credentials.capture : credentials.fallback,
      // 网关模式不依赖上游凭证
      authReady: GATEWAY_URL ? true : credentials.ready,
      credentials,
      capture: credentials.capture,
      error: credentials.ready ? null : credentials.hint,
      localTokenLength: LOCAL_TOKEN.length,
      // 从 WorkBuddy 里拉起的 bridge：抓包时重启客户端会把它一起带走，见 workbuddy-client.mjs
      selfHosted: await admin.selfHosted(),
      lan: {
        enabled: lanStatus.enabled,
        bindHost: lanStatus.bindHost,
        urls: lanStatus.urls,
        lanReady: lanStatus.lanReady,
        keyCount: lanStatus.keyCount,
      },
    })
  }

  if (url.pathname === '/v1/models' && req.method === 'GET') {
    if (!lan.apiEnabled('models')) {
      return openaiError(res, 503, '模型列表 API 已关闭：DSH 设置页 → WorkBuddy → API 开关', 'API_DISABLED')
    }
    if (!checkApiAuth(req, res)) return
    // DeepSeek 别名一并列出：客户端（Cherry Studio 等）下拉里直接选 deepseek-chat
    const decorate = (list) => ({
      object: 'list',
      data: [
        ...list,
        ...Object.keys(DEEPSEEK_ALIASES).map((id) => ({ id, object: 'model', owned_by: 'deepseek' })),
      ],
    })
    if (MOCK || GATEWAY_URL) {
      return json(res, 200, decorate(FALLBACK_MODELS.map((id) => ({ id, object: 'model', owned_by: 'workbuddy' }))))
    }
    try {
      return json(res, 200, decorate(await listModels(currentAuth())))
    } catch (err) {
      return openaiError(res, 401, err.message, 'AUTH_RESOLVE_FAILED')
    }
  }

  if (url.pathname === '/v1/embeddings') {
    return openaiError(res, 501, 'WorkBuddy 上游不提供 embedding 模型', 'NOT_IMPLEMENTED')
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    if (!lan.apiEnabled('chat')) {
      return openaiError(res, 503, '对话 API 已关闭：DSH 设置页 → WorkBuddy → API 开关', 'API_DISABLED')
    }
    if (!checkApiAuth(req, res)) return
    let body
    try {
      body = normalize(JSON.parse(await readBody(req)))
    } catch (err) {
      return openaiError(res, 400, `请求体解析失败: ${err.message}`, 'BAD_REQUEST')
    }
    // DeepSeek 兼容：客户端按 DeepSeek 的格式填模型名时映射到上游真实模型
    const alias = DEEPSEEK_ALIASES[body.model]
    if (alias) {
      console.log(`[chat] DeepSeek 别名 ${body.model} → ${alias}`)
      body.model = alias
    }
    if (MOCK) {
      console.log(`[chat:mock] model=${body.model} msgs=${body.messages.length} ua=${req.headers['user-agent'] || '-'}`)
      return mockStream(res, body)
    }
    if (GATEWAY_URL) {
      const aux = auxKind(body)
      if (aux) {
        console.log(`[chat:gateway] skip aux(${aux}) msgs=${body.messages.length} ua=${req.headers['user-agent'] || '-'}`)
        return auxStream(res, body, aux)
      }
      console.log(`[chat:gateway] model=${body.model} msgs=${body.messages.length} ua=${req.headers['user-agent'] || '-'}`)
      return proxyViaGateway(res, body)
    }
    let auth
    try {
      auth = currentAuth()
    } catch (err) {
      // 产品只有一条取凭证的路，报错要直接指向「去抓包」这个动作
      const { hint } = credentialsState()
      return openaiError(res, 401, hint || err.message, 'AUTH_MISSING', { detail: err.message })
    }
    console.log(
      `[chat] model=${body.model} msgs=${body.messages.length} tools=${body.tools?.length || 0} ` +
        `auth=${auth.type} ua=${req.headers['user-agent'] || '-'}`,
    )
    return proxyStream(res, body, auth)
  }

  return openaiError(res, 404, `未知路由: ${req.method} ${url.pathname}`, 'NOT_FOUND')
}

// —— 监听地址管理 ——
// 局域网开关会在运行中改监听地址：新建一个 server 听新地址，再把旧的关掉，
// 旧的在途 SSE 流自然收尾（不打断正在进行的对话）。
// close→listen 之间端口偶发没立即释放，EADDRINUSE 时退避重试，不把进程带走。
// 换桥（杀掉自托管 bridge 后立刻起新的）时端口释放有实测滞后，窗口给到 10 秒：
// 以前 6×300ms 不够，新 bridge 会把自己退掉，用户看到的就是「10 秒内没连上」且没有 bridge 在跑。

let server = null
let rebindLeft = 0

function onServerError(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`[workbuddy-bridge] 端口 ${PORT} 已被占用 —— 可能已经有一个 bridge 在跑。`)
    console.error(`[workbuddy-bridge] 换端口启动：WORKBUDDY_PORT=8791 node packages/bridge/server.mjs`)
    process.exit(1)
  }
  console.error('[workbuddy-bridge] 启动失败:', err)
  process.exit(1)
}

function applyBind(host) {
  if (server && bindHost === host) return
  const prev = server
  bindHost = host
  rebindLeft = 20
  const next = http.createServer(handleRequest)
  next.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && rebindLeft > 0) {
      rebindLeft--
      setTimeout(() => next.listen(PORT, host), 500)
      return
    }
    onServerError(err)
  })
  next.listen(PORT, host, () => {
    console.log(
      `[workbuddy-bridge] listening on http://${host}:${PORT}` +
        (host === '0.0.0.0' ? '（局域网已开启：仅接受内网来源）' : ''),
    )
    // 旧监听句柄释放；已在途的连接留着跑完，不打断正在进行的对话
    if (prev) prev.close(() => {})
  })
  server = next
}

/** 优雅退出：停收新连接，给在途流 3 秒收尾 */
let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[workbuddy-bridge] ${signal} received, shutting down`)
  server?.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

/**
 * 兜底：单个请求里漏网的异常不能带走整个服务。
 *
 * 真实踩过：`seedCa()` 的一个 mkdir 抛出来，整个 bridge 直接退出，
 * 用户界面上就成了「网关未连接」，而且没有任何提示指向真正原因。
 * 这里只记日志、不退出 —— 本地网关卡住一次请求，比整个掉线好。
 */
process.on('uncaughtException', (err) => {
  const text = err && err.stack ? err.stack : String(err)
  console.error('[workbuddy-bridge] uncaught exception:', text)
  try {
    pushLog(admin.log, `[fatal] ${text.split('\n')[0]}`)
  } catch {
    /* 日志都写不进去就算了 */
  }
})
process.on('unhandledRejection', (err) => {
  const text = err && err.stack ? err.stack : String(err)
  console.error('[workbuddy-bridge] unhandled rejection:', text)
  try {
    pushLog(admin.log, `[reject] ${text.split('\n')[0]}`)
  } catch {
    /* ignore */
  }
})

applyBind(bindHost)

console.log(`[workbuddy-bridge] mode=${MODE} upstream=${GATEWAY_URL || UPSTREAM_BASE}`)
if (GATEWAY_IGNORED) {
  console.warn(
    '[workbuddy-bridge] 检测到 WORKBUDDY_GATEWAY_URL 但没有 WORKBUDDY_EXPERIMENTAL=1，' +
      '已忽略并按 live 运行（网关模式会污染 WorkBuddy 会话，不属于正式能力）',
  )
}
if (bindHost === '0.0.0.0') {
  const urls = lan.status().urls
  console.log(`[workbuddy-bridge] 局域网地址：${urls.join('  ') || '（未探测到内网地址）'}`)
}
console.log(`[workbuddy-bridge] local token: ${TOKEN_FILE}`)
console.log(`[workbuddy-bridge] capture key: ${CAPTURE_KEY_FILE}`)
console.log(`[workbuddy-bridge] config: ${join(__dirname, '.bridge-config.json')}`)
// 预热探测缓存：首次读状态要 spawn python / mitmdump，冷启动要 4 秒左右；
// 启动时先探一次，设置页打开时就是热缓存。
admin.status({ fresh: true }).catch(() => {})
