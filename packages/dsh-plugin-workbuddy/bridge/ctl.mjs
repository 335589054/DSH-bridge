#!/usr/bin/env node
/**
 * 命令行运维入口 —— 设置页打不开时的等价操作。
 *
 *   node bridge/ctl.mjs status             # 运行状态 + 凭证 + 抓包环境 + 局域网/密钥
 *   node bridge/ctl.mjs capture start      # 开始抓包（重启 WorkBuddy 并接管它的代理）
 *   node bridge/ctl.mjs capture stop       # 停止抓包并把客户端拉回普通启动
 *   node bridge/ctl.mjs ca install         # 装随包 CA
 *   node bridge/ctl.mjs proxy off          # 只退出接管（恢复客户端）
 *   node bridge/ctl.mjs lan                # 看局域网状态（地址/密钥/API 开关）
 *   node bridge/ctl.mjs lan on|off         # 开/关局域网访问（仅内网来源）
 *   node bridge/ctl.mjs keys               # 列出 API 密钥
 *   node bridge/ctl.mjs keys new <名称>     # 生成一把 API 密钥（明文只显示一次）
 *   node bridge/ctl.mjs keys enable|disable <id>
 *   node bridge/ctl.mjs keys rm <id>
 *   node bridge/ctl.mjs keys verify <key>  # 本地校验一把密钥
 *   node bridge/ctl.mjs api                # 看 API 开关
 *   node bridge/ctl.mjs api chat|models on|off
 *
 * bridge 必须在跑（安装器会拉起它）。端口用 WORKBUDDY_PORT 覆盖，默认 8790。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.WORKBUDDY_PORT || 8790)
const BASE = `http://127.0.0.1:${PORT}`

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
}

async function req(path, method = 'GET', body) {
  let res
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: method === 'POST' ? { 'x-bridge-admin': '1', 'content-type': 'application/json' } : { 'x-bridge-admin': '1' },
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
      signal: AbortSignal.timeout(180_000),
    })
  } catch (err) {
    throw new Error(`连不上 bridge（${BASE}）：${err.message}\n先跑一次安装器，或 node bridge/server.mjs`)
  }
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { error: { message: text } }
  }
}

function localToken() {
  const file = join(HERE, '.bridge-token')
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
}

async function status() {
  const [health, setup, link] = await Promise.all([
    fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null),
    req('/setup/status?fresh=1'),
    req('/setup/link'),
  ])
  const cred = (health && health.credentials) || {}
  const ca = setup.ca || {}
  const mitm = setup.mitmproxy || {}
  const cap = setup.capture || {}
  const proxy = setup.proxy || {}
  const line = (k, v) => console.log(`  ${c.dim(k.padEnd(6))} ${v}`)

  console.log(c.b('\nWorkBuddy Bridge'))
  line('地址', `${BASE}  ${health ? c.ok('在线') : c.err('离线')}`)
  if (health) {
    line('模式', `${health.mode} → ${health.upstream}`)
    line('凭证', cred.ready ? c.ok('就绪') + (cred.capture && cred.capture.captured ? `（抓包 · ${cred.capture.userId || '账号未知'}）` : '') : c.warn('未就绪'))
  }
  line('mitm', mitm.installed ? `已安装 ${mitm.version || ''}` : mitm.broken ? c.warn('虚拟环境失效，需重装') : c.warn('未安装'))
  line('证书', ca.installed ? c.ok('已信任') : ca.exists ? c.warn('随包附带，未信任') + c.dim(`  ${ca.file}`) : c.err('缺失'))
  line('抓包', cap.running ? c.ok(`运行中 :${cap.port}`) : '未运行')
  // 「代理」这一环已经和注册表脱钩：状态只看 WorkBuddy 进程是不是我们带参数拉起来的
  line('接管', proxy.enabled ? c.warn(`已接管 → ${proxy.server}`) : '未接管（不写注册表）')
  const wbClient = proxy.client || {}
  if (wbClient.found === false) line('客户端', c.err('找不到 WorkBuddy.exe，用 WORKBUDDY_CLIENT_EXE 指定'))
  else if (wbClient.exe) line('客户端', wbClient.exe)
  if (proxy.orphan) line('残留', c.warn('上次接管没收尾，跑一次 node bridge/ctl.mjs proxy off 清掉'))
  if (link && link.baseUrl) {
    line('桥接', `${link.baseUrl}  令牌 ${link.apiKeyMasked}`)
    line('模型', `${link.defaultModel}（共 ${(link.models || []).length} 个）`)
  }
  const lanSt = setup.lan || {}
  line('局域网', lanSt.enabled ? c.ok('已开启 · 仅内网来源') : '未开启（仅本机）')
  if (lanSt.enabled && lanSt.urls && lanSt.urls.length) {
    line('内网', lanSt.urls.join('  '))
  }
  if (lanSt.enabled) {
    line('密钥', `${lanSt.activeKeyCount || 0} 把可用 / 共 ${lanSt.keyCount || 0} 把`)
    const apis = lanSt.apis || {}
    line('API', Object.entries(apis).map(([k, v]) => `${k}${v === false ? c.err(' 关') : c.ok(' 开')}`).join('  '))
    if (!lanSt.lanReady) console.log(c.warn('  局域网已开启但没有可用密钥：node bridge/ctl.mjs keys new 手机'))
  }
  console.log('')
  if (!cred.ready) console.log(c.dim('  下一步：node bridge/ctl.mjs capture start → 在 WorkBuddy 里发条消息 → capture stop\n'))
  return health
}

function printKeys(keys) {
  if (!keys.length) {
    console.log(c.dim('  还没有 API 密钥。生成一把：node bridge/ctl.mjs keys new 手机'))
    return
  }
  console.log(c.b('\nAPI 密钥（只存哈希，明文仅在生成时显示一次）\n'))
  for (const k of keys) {
    const state = k.enabled ? c.ok('启用') : c.err('停用')
    const used = k.lastUsedAt ? c.dim(`  最近使用 ${k.lastUsedAt.replace('T', ' ').slice(0, 19)}`) : ''
    console.log(`  ${c.b(k.id)}  ${k.name}  ${k.prefix}  ${state}${used}`)
  }
  console.log('')
}

async function lanCmd(sub) {
  if (!sub || sub === 'status') {
    const s = await req('/setup/status?fresh=1')
    const st = s.lan || {}
    console.log(c.b('\n局域网访问'))
    console.log(`  状态   ${st.enabled ? c.ok('已开启（仅内网来源）') : '未开启（仅本机 127.0.0.1）'}`)
    console.log(`  监听   ${st.bindHost}`)
    if (st.urls && st.urls.length) st.urls.forEach((u) => console.log(`  地址   ${c.ok(u)}`))
    console.log(`  密钥   ${st.activeKeyCount || 0} 把可用 / 共 ${st.keyCount || 0} 把`)
    const apis = st.apis || {}
    console.log(`  API    ${Object.entries(apis).map(([k, v]) => `${k}${v === false ? c.err(' 关') : c.ok(' 开')}`).join('  ')}`)
    console.log('')
    return
  }
  if (sub !== 'on' && sub !== 'off') throw new Error('lan 只支持 on / off / status')
  const r = await req('/setup/lan', 'POST', { enabled: sub === 'on' })
  if (!r.ok) {
    console.error(c.err(`✗ ${r.error}`))
    process.exitCode = 1
    return
  }
  console.log(c.ok(`✓ 局域网已${sub === 'on' ? '开启' : '关闭'}（${r.lan.bindHost}）`))
  if (sub === 'on' && r.lan.urls.length) r.lan.urls.forEach((u) => console.log(`  地址   ${u}`))
  if (sub === 'on' && !r.lan.lanReady) console.log(c.warn('  还没有可用密钥：node bridge/ctl.mjs keys new 手机'))
}

async function keysCmd(sub, arg) {
  if (!sub || sub === 'list') {
    const r = await req('/setup/keys')
    printKeys(r.keys || [])
    return
  }
  if (sub === 'new') {
    const r = await req('/setup/keys', 'POST', { name: arg || '未命名密钥' })
    if (!r.ok) {
      console.error(c.err(`✗ ${r.error}`))
      process.exitCode = 1
      return
    }
    console.log(c.b(`\n已生成密钥「${r.entry.name}」`))
    console.log(`  ${c.ok(r.key)}`)
    console.log(c.dim('  明文只显示这一次，现在复制走；之后只能看前缀。\n'))
    return
  }
  if (sub === 'enable' || sub === 'disable') {
    if (!arg) throw new Error(`${sub} 需要密钥 id`)
    const r = await req('/setup/keys/enable', 'POST', { id: arg, enabled: sub === 'enable' })
    console.log(r.ok ? c.ok(`✓ 已${sub === 'enable' ? '启用' : '停用'} ${arg}`) : c.err(`✗ ${r.error}`))
    if (!r.ok) process.exitCode = 1
    return
  }
  if (sub === 'rm' || sub === 'delete') {
    if (!arg) throw new Error('rm 需要密钥 id')
    const r = await req('/setup/keys/delete', 'POST', { id: arg })
    console.log(r.ok ? c.ok(`✓ 已删除 ${arg}`) : c.err(`✗ ${r.error}`))
    if (!r.ok) process.exitCode = 1
    return
  }
  if (sub === 'verify') {
    if (!arg) throw new Error('verify 需要密钥内容')
    const r = await req('/setup/keys/verify', 'POST', { key: arg })
    if (r.ok) {
      console.log(c.ok(`✓ ${r.message}`))
      console.log(c.dim(`  可用 API：${Object.entries(r.apis || {}).filter(([, v]) => v).map(([k]) => k).join(' / ') || '（无）'}`))
    } else {
      console.error(c.err(`✗ ${r.error}`))
      process.exitCode = 1
    }
    return
  }
  throw new Error('keys 只支持 list / new <名称> / enable <id> / disable <id> / rm <id> / verify <key>')
}

async function apiCmd(sub, arg) {
  const s = await req('/setup/status?fresh=1')
  const apis = (s.lan && s.lan.apis) || {}
  if (!sub) {
    console.log(c.b('\nAPI 开关'))
    for (const [name, on] of Object.entries(apis)) {
      console.log(`  ${name.padEnd(8)} ${on === false ? c.err('关') : c.ok('开')}`)
    }
    console.log('')
    return
  }
  if (!arg) throw new Error('api 需要 on / off')
  const r = await req('/setup/api', 'POST', { name: sub, enabled: arg === 'on' })
  console.log(r.ok ? c.ok(`✓ ${sub} 已${arg === 'on' ? '开启' : '关闭'}`) : c.err(`✗ ${r.error}`))
  if (!r.ok) process.exitCode = 1
}

async function main() {
  const [cmd, sub] = process.argv.slice(2)
  if (!cmd || cmd === 'status') {
    await status()
    return
  }
  if (cmd === 'link') {
    console.log(localToken() ? `${BASE}/v1\n${localToken()}` : `${BASE}/v1`)
    return
  }
  if (cmd === 'capture') {
    const body = { proxy: true }
    if (sub === 'stop') {
      console.log(JSON.stringify(await req('/capture/stop', 'POST', body)))
    } else if (sub === 'start') {
      const r = await req('/capture/start', 'POST', body)
      console.log(JSON.stringify(r))
      if (r.ok) console.log(c.dim('\nWorkBuddy 已重启并接管代理，等窗口回来后在里面发一条消息，然后 node bridge/ctl.mjs capture stop'))
    } else {
      throw new Error('capture 只支持 start / stop')
    }
    return
  }
  if (cmd === 'ca') {
    const r = await req('/setup/ca', 'POST', {})
    if (r.ok) console.log(c.ok(`✓ 证书已装入当前用户根证书库（${r.cn || ''}）`))
    else {
      console.error(c.err(`✗ ${r.error || '安装失败'}`))
      if (r.script) console.error(c.dim(`  双击：${r.script}`))
      process.exitCode = 1
    }
    return
  }
  if (cmd === 'proxy') {
    const r = await req('/proxy', 'POST', { enabled: sub === 'on' })
    console.log(r.ok ? c.ok(`✓ 代理已${sub === 'on' ? '开启' : '关闭'}`) : c.err(`✗ ${r.error}`))
    return
  }
  if (cmd === 'lan') {
    await lanCmd(sub)
    return
  }
  if (cmd === 'keys') {
    await keysCmd(sub, process.argv[4])
    return
  }
  if (cmd === 'api') {
    await apiCmd(sub, process.argv[4])
    return
  }
  console.error(`未知命令：${cmd}\n      node bridge/ctl.mjs status | capture start|stop | ca install | proxy on|off | lan on|off | keys | api <name> on|off`)
  process.exitCode = 1
}

main().catch((err) => {
  console.error(c.err(`\n✗ ${err.message}\n`))
  process.exit(1)
})
