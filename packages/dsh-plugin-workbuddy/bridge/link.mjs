#!/usr/bin/env node
/**
 * 抓取「桥接链接」
 *
 * 把 DSH 之外任何 OpenAI 兼容客户端要填的三样东西一次拿全：地址、令牌、模型。
 * 数据来自 bridge 的 GET /setup/link（同一份数据也喂给 DSH 设置页的「桥接链接」卡片），
 * bridge 没起的时候回落到本地令牌文件，仍然能给出地址和令牌。
 *
 * 用法：
 *   node packages/bridge/link.mjs            # 人读
 *   node packages/bridge/link.mjs --json     # 机读
 *   node packages/bridge/link.mjs --copy     # 把地址+令牌复制到剪贴板
 *   node packages/bridge/link.mjs --port 8791
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valueOf = (f, d) => {
  const i = argv.indexOf(f)
  if (i === -1) return d
  const next = argv[i + 1]
  return next && !next.startsWith('--') ? next : d
}

const PORT = Number(valueOf('--port', process.env.WORKBUDDY_PORT || 8790))
const WANT_JSON = has('--json')
const WANT_COPY = has('--copy')
const TOKEN_FILE = join(__dirname, '.bridge-token')

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
}

function readLocalToken() {
  if (!existsSync(TOKEN_FILE)) return null
  return readFileSync(TOKEN_FILE, 'utf8').trim() || null
}

/** 走 bridge 的 /setup/link；失败返回 null（不抛，脚本要保持可用） */
async function fromBridge() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/setup/link`, {
      headers: { 'x-bridge-admin': '1' },
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    return await res.json()
  } catch (err) {
    return { error: err.message }
  }
}

/** bridge 没起：用本地令牌拼一份最小可用的链接 */
function offlineLink(token) {
  const baseUrl = `http://127.0.0.1:${PORT}/v1`
  const model = 'auto'
  return {
    ok: false,
    offline: true,
    baseUrl,
    endpoint: `${baseUrl}/chat/completions`,
    modelsUrl: `${baseUrl}/models`,
    apiKey: token,
    apiKeyMasked: token ? `${token.slice(0, 4)}${'•'.repeat(Math.max(4, token.length - 8))}${token.slice(-4)}` : null,
    provider: 'workbuddy',
    defaultModel: model,
    models: [model],
    copyText: ['WorkBuddy 桥接（OpenAI Chat Completions 兼容）', `地址：${baseUrl}`, `令牌：${token || '（未生成）'}`, `模型：${model}`].join('\n'),
    snippets: {
      env: token ? `OPENAI_BASE_URL=${baseUrl}\nOPENAI_API_KEY=${token}` : '',
      curl: '',
    },
  }
}

function copyToClipboard(text) {
  if (process.platform !== 'win32') return false
  // 用 Set-Clipboard；stdin 传值，避免引号/换行在命令行里被拆开
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value ([Console]::In.ReadToEnd())'], {
    input: text,
    windowsHide: true,
    encoding: 'utf8',
  })
  return r.status === 0
}

function printHuman(info) {
  console.log(`\n${c.b('WorkBuddy 桥接链接')}${info.offline ? c.warn('  （bridge 未运行，信息来自本地令牌文件）') : ''}\n`)
  console.log(`  地址   ${c.ok(info.baseUrl)}`)
  console.log(`  端点   ${c.dim(info.endpoint)}`)
  console.log(`  令牌   ${info.apiKey || c.err('（未生成）')}`)
  console.log(`  模型   ${info.defaultModel}${info.models.length > 1 ? c.dim(`（共 ${info.models.length} 个，见 ${info.modelsUrl}）`) : ''}`)
  if (info.mode) console.log(`  模式   ${info.mode}${info.mode === 'mock' ? c.warn('  —— 不会真的请求上游') : ''}`)
  if (info.captured !== undefined) console.log(`  会话   ${info.captured ? c.ok('已捕获') : c.warn('尚未捕获（去 WorkBuddy 发一条消息）')}`)

  if (info.snippets?.env) {
    console.log(`\n${c.dim('# .env')}`)
    console.log(info.snippets.env)
  }
  if (info.snippets?.json) {
    console.log(`\n${c.dim('# JSON（多数客户端的自定义 provider 用这个形状）')}`)
    console.log(info.snippets.json)
  }
  if (info.snippets?.curl) {
    console.log(`\n${c.dim('# curl')}`)
    console.log(info.snippets.curl)
  }
  console.log(`\n${c.dim('提示：DSH 设置页 → WorkBuddy 里也有同一份「桥接链接」卡片，可一键复制。')}\n`)
}

async function main() {
  const localToken = readLocalToken()
  const live = await fromBridge()
  let info

  if (live && live.ok) {
    info = live
  } else {
    info = offlineLink(localToken)
    if (live?.error) console.error(c.warn(`bridge 不可用（${live.error}），改用离线信息（需要先启动 bridge 才能真的调用）`))
  }

  if (WANT_JSON) {
    process.stdout.write(JSON.stringify(info, null, 2) + '\n')
    return
  }

  printHuman(info)

  if (WANT_COPY) {
    const text = info.copyText || `${info.baseUrl}\n${info.apiKey || ''}`
    const done = copyToClipboard(text)
    console.log(done ? c.ok('已复制到剪贴板') : c.err('复制失败：请手动选中上面的内容'))
  }
}

main().catch((err) => {
  console.error(c.err(`抓取桥接链接失败: ${err.message}`))
  process.exit(1)
})
