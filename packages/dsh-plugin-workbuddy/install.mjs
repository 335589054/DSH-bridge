#!/usr/bin/env node
/**
 * dsh-plugin-workbuddy 安装器（DeepSeek Harness 桌面版 / profile 方式）
 *
 * 做四件事，全部可逆：
 *   1. 拉起 bridge（127.0.0.1:8790），并把本地令牌登记到 harness 凭证文件
 *   2. 把本包登记成 profile 的 bundle（这样 Plugins 页能看到它）
 *   3. 把 llm-pi-ai 的 workbuddy 路由写进 profile 的 cordis.patch.yml（托管块）
 *   4. 可选：把 agent-default-model 指到 workbuddy，最后打印自检
 *
 * 用法：
 *   node install.mjs                 # 安装（不改默认模型）
 *   node install.mjs --quick         # 安装 + 装证书 + 抓一次会话，一步到位
 *   node install.mjs --default-model # 同时把默认模型设为 workbuddy/auto
 *   node install.mjs --ca            # 只补装随包 CA
 *   node install.mjs --uninstall     # 还原（bundle 登记 + 补丁 + 凭证引用）
 *
 * 参数：
 *   --profile <name>   默认 desktop
 *   --port <n>         默认 8790
 *   --force            允许覆盖已有的 llm-pi-ai 配置行
 *   --no-start         不自动拉起 bridge
 *   --no-bundle        只写路由补丁，不登记成 bundle（插件列表里不会出现）
 *   --capture          安装后开始抓包（默认等 120s 抓到会话就自动停）
 *   --no-capture       --quick 时不抓包，只装到「点一下就等抓包」的状态
 *   --wait <秒>        抓包等待上限，默认 120
 */

import { spawn } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  BLOCK_START,
  DEFAULT_BASE_URL,
  DEFAULT_TOKEN_REF,
  PACKAGE_ROOT,
  hasForeignPiAiRow,
  loadModels,
  removeBlock,
  removeDefaultModelBlock,
  renderPatchBlock,
  upsertBlock,
  upsertDefaultModelBlock,
} from './lib/route.mjs'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valueOf = (f, d) => {
  const i = argv.indexOf(f)
  if (i === -1) return d
  const next = argv[i + 1]
  // `--default-model` 不带值时不要吞掉后面的开关
  return next && !next.startsWith('--') ? next : d
}

const PROFILE = valueOf('--profile', 'desktop')
const PORT = Number(valueOf('--port', 8790))
const UNINSTALL = has('--uninstall')
const FORCE = has('--force')
const WANT_DEFAULT_MODEL = has('--default-model')
const NO_START = has('--no-start')
const NO_BUNDLE = has('--no-bundle')
const DEFAULT_MODEL = valueOf('--default-model', 'auto')
const QUICK = has('--quick')
const WANT_CA = QUICK || has('--ca')
const WANT_CAPTURE = has('--capture') || (QUICK && !has('--no-capture'))
const WAIT_SEC = Math.max(5, Number(valueOf('--wait', 120)) || 120)

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const PATCH_FILE = join(PROFILE_DIR, 'cordis.patch.yml')
const CRED_FILE = join(DSH_HOME, '.credentials.yaml')
// bridge 的两种落点：git/npm 形态打进包内 <pkg>/bridge，仓库/zip 形态是 <pkg>/../bridge
const BRIDGE_DIR = existsSync(join(PACKAGE_ROOT, 'bridge', 'server.mjs'))
  ? join(PACKAGE_ROOT, 'bridge')
  : resolve(PACKAGE_ROOT, '..', 'bridge')
const BRIDGE_ENTRY = join(BRIDGE_DIR, 'server.mjs')
const BRIDGE_LOG = join(BRIDGE_DIR, 'bridge.log')
const BRIDGE_TOKEN_FILE = join(BRIDGE_DIR, '.bridge-token')

const BASE_URL = DEFAULT_BASE_URL.replace(':8790', `:${PORT}`)
const PROVIDER_HINT = 'workbuddy'
const BUNDLE_NAME = 'dsh-plugin-workbuddy'

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
}

function step(msg) {
  console.log(`\n${c.b('›')} ${msg}`)
}
function ok(msg) {
  console.log(`  ${c.ok('✓')} ${msg}`)
}
function warn(msg) {
  console.log(`  ${c.warn('!')} ${msg}`)
}
function die(msg) {
  console.error(`\n${c.err('✗')} ${msg}`)
  process.exit(1)
}

function backup(file) {
  if (!existsSync(file)) return null
  const target = `${file}.workbuddy-backup-${Date.now()}`
  copyFileSync(file, target)
  // 只保留最近 3 份，避免反复安装时堆积
  try {
    const dir = dirname(file)
    const prefix = `${basename(file)}.workbuddy-backup-`
    const olds = readdirSync(dir)
      .filter((n) => n.startsWith(prefix))
      .sort()
      .slice(0, -3)
    for (const n of olds) rmSync(join(dir, n), { force: true })
  } catch {
    /* 清理失败不影响安装 */
  }
  return target
}

async function health(timeoutMs = 1200) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/** 调 bridge 的管理接口（和设置页走同一套：x-bridge-admin + 回环 Origin） */
async function adminApi(path, body) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: 'POST',
      headers: { 'x-bridge-admin': '1', 'content-type': 'application/json', origin: `http://127.0.0.1:${PORT}` },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(180_000),
    })
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { error: { message: text.slice(0, 300) } }
    }
    return { ok: res.ok, data: data || {} }
  } catch (err) {
    return { ok: false, unreachable: true, data: { error: { message: String((err && err.message) || err) } } }
  }
}

async function adminGet(path) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      headers: { 'x-bridge-admin': '1' },
      signal: AbortSignal.timeout(20_000),
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/** 装 CA：优先用随包证书，失败时把「用户双击一下」的路径给出来 */
async function installCaStep() {
  step('设备证书')
  const res = await adminApi('/setup/ca')
  if (res.unreachable) {
    warn('bridge 没在跑，没法替你装证书')
    console.log(`  ${c.dim('双击运行')} ${join(BRIDGE_DIR, 'certs', 'install-ca.cmd')}`)
    return false
  }
  const data = res.data || {}
  if (data.ok) {
    ok(`CA 已装入当前用户根证书库（${data.cn || 'WorkBuddy Bridge Local CA'}）`)
    return true
  }
  if (data.manual) {
    warn('自动写入证书库被安全策略拦截，需要你手动点一下')
    console.log(`  ${c.dim('证书文件')} ${data.file || ''}`)
    console.log(`  ${c.dim('双击运行')} ${data.script || ''}`)
    if (data.error) console.log(`  ${c.dim('原因')} ${data.error}`)
    return false
  }
  warn(data.error || '证书安装失败')
  return false
}

/**
 * 抓一次会话：接管客户端 → 等用户在 WorkBuddy 里发一句话 → 自动还原。
 *
 * 这是产品唯一的取证路径，所以安装器把它做成「等一下就自动收工」，
 * 用户不需要记住「先开抓包、再发消息、再关代理」这套顺序。
 */
async function captureStep(waitSec) {
  step('抓一次会话')
  const started = await adminApi('/capture/start', { proxy: true })
  if (started.unreachable) {
    warn('bridge 没在跑，抓包这一步跳过；等它起来后在设置页点「开始抓包」即可')
    return false
  }
  const s = started.data || {}
  if (!s.ok) {
    warn(s.error || '抓包启动失败')
    if (s.needsCa) warn('先把上面「设备证书」那一步做完，再重来一次安装')
    return false
  }
  ok(`mitmdump 已在 127.0.0.1:8899 监听，WorkBuddy 已注入 HTTP_PROXY 重新拉起（不写注册表）`)
  console.log('')
  console.log(`  ${c.b('现在去 WorkBuddy 客户端里随便发一条消息')}（它刚被重启过，等窗口回来再发）`)
  console.log(c.dim(`  桥会从这条真实请求里取走鉴权头；最多等 ${waitSec}s，抓到就自动停止抓包并还原客户端。`))
  console.log('')

  const deadline = Date.now() + waitSec * 1000
  let captured = null
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    const st = await adminGet('/capture/status')
    if (st && st.captured && !st.expired) {
      captured = st
      break
    }
    if (Date.now() + 1000 >= deadline) process.stdout.write(c.dim(' 等待超时\n'))
  }

  // 抓到没抓到都还原：客户端不该一直开着一个只在抓包时有用的进程
  await adminApi('/capture/stop', { proxy: true })
  if (captured) {
    ok(`已抓到会话${captured.userId ? `（账号 ${captured.userId}）` : ''}，客户端已恢复正常启动`)
    return true
  }
  warn(`这 ${waitSec}s 内没抓到会话，客户端已恢复正常启动`)
  console.log(`  ${c.dim('稍后再来：设置页 → WorkBuddy →「开始抓包」，发完消息点「停止并还原」')}`)
  return false
}

function printLink(link) {
  if (!link) return
  step('桥接链接')
  console.log(`  ${c.dim('地址')} ${link.baseUrl}`)
  console.log(`  ${c.dim('令牌')} ${link.apiKeyMasked || ''}`)
  console.log(`  ${c.dim('模型')} ${link.defaultModel}`)
  console.log(`  ${c.dim('命令行随时取')} node bridge/link.mjs --copy`)
}

async function ensureBridge() {
  const live = await health()
  if (live) {
    ok(`bridge 已在运行（${live.mode} 模式）`)
    return live
  }
  if (NO_START) {
    warn('bridge 未运行，且指定了 --no-start')
    return null
  }
  if (!existsSync(BRIDGE_ENTRY)) die(`找不到 bridge 入口: ${BRIDGE_ENTRY}`)
  mkdirSync(BRIDGE_DIR, { recursive: true })
  const fd = openSync(BRIDGE_LOG, 'a')
  const child = spawn(process.execPath, [BRIDGE_ENTRY], {
    cwd: BRIDGE_DIR,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, WORKBUDDY_PORT: String(PORT) },
  })
  child.unref()
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    const h = await health(500)
    if (h) {
      ok(`bridge 已启动，pid=${child.pid}，日志 ${BRIDGE_LOG}`)
      return h
    }
  }
  die(`bridge 启动失败，请查看 ${BRIDGE_LOG}`)
}

function readBridgeToken() {
  if (!existsSync(BRIDGE_TOKEN_FILE)) die(`找不到 bridge 令牌文件: ${BRIDGE_TOKEN_FILE}（先启动一次 bridge）`)
  return readFileSync(BRIDGE_TOKEN_FILE, 'utf8').trim()
}

/** 在凭证文件 refs 段写入/替换一条引用 */
function upsertRef(content, name, value) {
  const lines = content.split(/\r?\n/)
  const refIdx = lines.findIndex((l) => /^refs:\s*$/.test(l))
  if (refIdx === -1) {
    const head = content.replace(/\s*$/, '\n')
    return `${head}refs:\n  ${name}: ${value}\n`.replace(/^\n/, '')
  }
  let insertAt = refIdx + 1
  for (let i = refIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() !== '' && !/^\s/.test(line)) break
    if (new RegExp(`^\\s+${name}:`).test(line)) {
      lines[i] = `  ${name}: ${value}`
      return lines.join('\n')
    }
    if (line.trim() !== '') insertAt = i + 1
  }
  lines.splice(insertAt, 0, `  ${name}: ${value}`)
  return lines.join('\n')
}

function removeRef(content, name) {
  const re = new RegExp(`^\\s+${name}:.*\\r?\\n?`, 'm')
  return content.replace(re, '')
}

function applyCredentials(token) {
  if (!existsSync(CRED_FILE)) {
    writeFileSync(CRED_FILE, `version: 1\nrefs:\n  ${DEFAULT_TOKEN_REF}: ${token}\n`, { mode: 0o600 })
    return ok(`新建凭证文件 ${CRED_FILE}`)
  }
  const before = readFileSync(CRED_FILE, 'utf8')
  const after = upsertRef(before, DEFAULT_TOKEN_REF, token)
  if (after === before) return ok(`${DEFAULT_TOKEN_REF} 已是最新`)
  const b = backup(CRED_FILE)
  writeFileSync(CRED_FILE, after, { mode: 0o600 })
  ok(`已写入 ${DEFAULT_TOKEN_REF}（备份 ${b}）`)
}

function applyPatch(models, { withDefaultModel, defaultModel }) {
  if (!existsSync(PATCH_FILE)) die(`找不到 profile 补丁: ${PATCH_FILE}`)
  const before = readFileSync(PATCH_FILE, 'utf8')
  if (hasForeignPiAiRow(before) && !FORCE) {
    die(
      'profile 补丁里已经有一行 llm-pi-ai（不在托管块内）。\n' +
        '  本插件会整行替换 llm-pi-ai 的 config，可能覆盖你已有的 provider。\n' +
        '  确认要覆盖请加 --force，或先手工合并。',
    )
  }
  let next = upsertBlock(before, renderPatchBlock({ baseUrl: BASE_URL, models }))
  if (withDefaultModel) next = upsertDefaultModelBlock(next, defaultModel)
  if (next === before) {
    ok(`路由已是当前内容（${models.length} 个模型），无需改动`)
    return
  }
  const b = backup(PATCH_FILE)
  writeFileSync(PATCH_FILE, next)
  ok(`已写入路由到 ${PATCH_FILE}（${models.length} 个模型，备份 ${b}）`)
  if (withDefaultModel) ok(`已把默认模型设为 ${PROVIDER_HINT}/${defaultModel}`)
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function bundlePaths() {
  return {
    pkgFile: join(PROFILE_DIR, 'package.json'),
    link: join(PROFILE_DIR, 'node_modules', BUNDLE_NAME),
  }
}

/**
 * 把本包登记成 profile 的 bundle。
 *
 * Plugins 页（plugin_manager）只列 profile 的 bundles 与依赖；
 * 纯 patch 覆盖不会出现在插件列表里。所以要补两件事：
 *   1. package.json 的 dependencies + dsh.profile.bundles
 *   2. node_modules 里的目录联接（pnpm 的 hoisted 布局对 link: 不建顶层链）
 */
function installBundleLayer() {
  if (NO_BUNDLE) {
    warn('指定了 --no-bundle：只写补丁，插件列表里不会出现')
    return false
  }
  const { pkgFile, link } = bundlePaths()
  if (!existsSync(pkgFile)) {
    warn(`找不到 ${pkgFile}，跳过 bundle 登记`)
    return false
  }
  const before = readFileSync(pkgFile, 'utf8')
  const pkg = JSON.parse(before)
  const spec = `link:${PACKAGE_ROOT.replace(/\\/g, '/')}`
  pkg.dependencies = { ...(pkg.dependencies || {}), [BUNDLE_NAME]: spec }
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  if (!bundles.includes(BUNDLE_NAME)) bundles.push(BUNDLE_NAME)
  pkg.dsh.profile.bundles = bundles
  const next = JSON.stringify(pkg, null, 2) + '\n'

  // 目录联接：开发时改代码立即生效，不用重装
  mkdirSync(dirname(link), { recursive: true })
  try {
    if (existsSync(link) || isLink(link)) rmSync(link, { force: true })
    symlinkSync(PACKAGE_ROOT, link, 'junction')
  } catch (err) {
    try {
      cpSync(PACKAGE_ROOT, link, { recursive: true })
      warn(`建链接失败（${err.code || err.message}），已改为复制目录；改代码后需重跑安装`)
    } catch (copyErr) {
      warn(`无法放置插件包：${copyErr.message}`)
      return false
    }
  }

  if (next !== before) {
    backup(pkgFile)
    writeFileSync(pkgFile, next)
    ok(`已登记为 profile bundle：${BUNDLE_NAME}`)
  } else {
    ok(`插件已在列表里（${BUNDLE_NAME}）`)
  }
  return true
}

function removeBundleLayer() {
  const { pkgFile, link } = bundlePaths()
  try {
    if (existsSync(link) || isLink(link)) rmSync(link, { force: true })
  } catch {
    /* 目录被占用时忽略，用户可手动删 */
  }
  if (!existsSync(pkgFile)) return
  const before = readFileSync(pkgFile, 'utf8')
  const pkg = JSON.parse(before)
  let changed = false
  if (pkg.dependencies && BUNDLE_NAME in pkg.dependencies) {
    delete pkg.dependencies[BUNDLE_NAME]
    changed = true
  }
  const bundles = pkg.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes(BUNDLE_NAME)) {
    pkg.dsh.profile.bundles = bundles.filter((b) => b !== BUNDLE_NAME)
    changed = true
  }
  if (!changed) return warn('profile 清单里没有本插件的登记')
  backup(pkgFile)
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
  ok('已从 profile bundle 列表移除')
}

/** bundle 层已经提供路由时，把用户补丁里的旧托管块摘掉，避免两处重复 */
function clearRouteBlock() {
  if (!existsSync(PATCH_FILE)) return false
  const content = readFileSync(PATCH_FILE, 'utf8')
  if (!content.includes(BLOCK_START)) return false
  backup(PATCH_FILE)
  writeFileSync(PATCH_FILE, removeBlock(content))
  ok('已从用户补丁里移除路由块（改由 bundle 提供，避免两处重复）')
  return true
}

function setDefaultModelBlock(model) {
  if (!existsSync(PATCH_FILE)) return
  const content = readFileSync(PATCH_FILE, 'utf8')
  const next = upsertDefaultModelBlock(content, model)
  if (next === content) return ok(`默认模型已是 ${PROVIDER_HINT}/${model}`)
  backup(PATCH_FILE)
  writeFileSync(PATCH_FILE, next)
  ok(`已把默认模型设为 ${PROVIDER_HINT}/${model}`)
}

function bundleState() {
  const { pkgFile, link } = bundlePaths()
  if (!existsSync(pkgFile)) return { listed: false, linked: false }
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  return {
    listed: (pkg.dsh?.profile?.bundles || []).includes(BUNDLE_NAME),
    linked: existsSync(link) || isLink(link),
  }
}

/**
 * 安装源诊断。
 *
 * 同一台机器上常常同时存在好几份插件副本：仓库源码
 * `packages/dsh-plugin-workbuddy`、解压出来的安装包
 * `dist/workbuddy-dsh-plugin/dsh-plugin-workbuddy`、Downloads 里再解压的一份……
 * 而安装器永远只把「自己所在的那一份」登记进 profile。
 *
 * 于是最典型的一个坑：改了源码、重启了 Harness，界面还是旧的样子 ——
 * 因为刚才双击的是安装包副本里的 install.mjs，profile 指向的是那份静态快照。
 * 把源目录、版本、以及「这次覆盖了哪个旧路径」显式打出来，就不用猜了。
 */
function sourceInfo() {
  let version = '?'
  try {
    version = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version || '?'
  } catch {
    /* 版本读不到不影响安装 */
  }
  // 仓库源码的判据：往上两级还有 packages/dsh-plugin-workbuddy
  const isRepo = existsSync(join(PACKAGE_ROOT, '..', '..', 'packages', 'dsh-plugin-workbuddy'))
  let linkedTo = null
  try {
    const { pkgFile } = bundlePaths()
    if (existsSync(pkgFile)) {
      const dep = JSON.parse(readFileSync(pkgFile, 'utf8')).dependencies?.[BUNDLE_NAME]
      if (dep) linkedTo = String(dep).replace(/^link:/, '')
    }
  } catch {
    /* profile 清单坏了会有别的报错兜着 */
  }
  return { version, isRepo, linkedTo, dir: PACKAGE_ROOT }
}

function samePath(a, b) {
  if (!a || !b) return false
  return resolve(a).replace(/\\/g, '/').toLowerCase() === resolve(b).replace(/\\/g, '/').toLowerCase()
}


function doUninstall() {
  step('卸载')
  removeBundleLayer()
  if (existsSync(PATCH_FILE)) {
    const content = readFileSync(PATCH_FILE, 'utf8')
    const next = removeDefaultModelBlock(removeBlock(content))
    if (next !== content) {
      backup(PATCH_FILE)
      writeFileSync(PATCH_FILE, next)
      ok('已移除 profile 补丁里的托管块')
    } else warn('profile 补丁里没有托管块')
  }
  if (existsSync(CRED_FILE)) {
    const content = readFileSync(CRED_FILE, 'utf8')
    if (content.includes(DEFAULT_TOKEN_REF)) {
      backup(CRED_FILE)
      writeFileSync(CRED_FILE, removeRef(content, DEFAULT_TOKEN_REF), { mode: 0o600 })
      ok(`已移除凭证引用 ${DEFAULT_TOKEN_REF}`)
    }
  }
  console.log(`\n${c.dim('bridge 进程未自动结束；需要的话按端口找 PID 再 taskkill')}`)
}

async function main() {
  console.log(c.b('\nDSH × WorkBuddy 插件安装器'))
  console.log(c.dim(`DSH_HOME=${DSH_HOME}  profile=${PROFILE}  bridge=:${PORT}`))

  const src = sourceInfo()
  step('安装源')
  console.log(`  ${c.dim('目录')} ${src.dir}`)
  console.log(`  ${c.dim('版本')} ${src.version}${src.isRepo ? c.dim('（仓库源码）') : c.dim('（安装包副本）')}`)
  if (!src.isRepo) {
    warn('这是安装包副本（zip 解压目录）—— 它是一份静态快照，改仓库源码不会影响这里')
    warn('正在改源码的话，请改用仓库里的 packages/dsh-plugin-workbuddy/install.mjs 重装')
  }
  if (src.linkedTo && !samePath(src.linkedTo, src.dir)) {
    warn(`profile 原本指向 ${src.linkedTo}`)
    warn(`本次改成 ${src.dir}（旧路径里那份不会再被加载）`)
  }

  if (UNINSTALL) return doUninstall()

  if (!existsSync(PROFILE_DIR)) {
    die(`找不到 profile 目录: ${PROFILE_DIR}\n  先启动一次 DeepSeek Harness，或指定 --profile 名称。`)
  }

  step('bridge')
  const h = await ensureBridge()
  // --no-start 且从没起过 bridge 时，令牌文件还不存在：这不算错误，跳过凭证登记
  const token = existsSync(BRIDGE_TOKEN_FILE) ? readBridgeToken() : null
  if (h) {
    ok(`mode=${h.mode} upstream=${h.upstream}`)
    if (h.capture?.captured) {
      ok(`已捕获客户端会话，账号 ${h.capture.userId || '未知'}`)
    } else if (h.authReady) {
      ok('凭证就绪（来自 API Key 或桌面登录文件）')
    } else {
      warn(`凭证尚未就绪：${h.error || '还没有抓到 WorkBuddy 会话'}`)
      warn('重启 DSH 后打开 Settings → WorkBuddy，可以一键装 mitmproxy / 装 CA / 开始抓包')
    }
  }

  step('凭证')
  if (token) applyCredentials(token)
  else warn('bridge 还没启动过，没有本地令牌可写；等它起来后重跑一次安装（不要带 --no-start）')

  step('插件登记')
  const bundled = installBundleLayer()

  step('profile 补丁')
  const models = loadModels()
  if (bundled) {
    // 路由由 bundle 层的 cordis.patch.yml 提供，Plugins 页的开关才有意义
    clearRouteBlock()
    if (WANT_DEFAULT_MODEL) setDefaultModelBlock(DEFAULT_MODEL)
  } else {
    applyPatch(models, { withDefaultModel: WANT_DEFAULT_MODEL, defaultModel: DEFAULT_MODEL })
  }

  step('自检')
  const h2 = await health()
  if (h2) ok('/health 可达')
  else warn('/health 不可达（bridge 没在跑：去掉 --no-start 再跑一次）')
  ok(`安装源 ${src.isRepo ? '仓库源码' : c.warn('安装包副本')} · v${src.version}`)
  const patch = readFileSync(PATCH_FILE, 'utf8')
  const st0 = bundleState()
  const routeFrom = st0.listed ? 'bundle 层' : patch.includes('dsh-plugin-workbuddy (managed)') ? '用户补丁' : null
  ok(`路由来源 ${routeFrom ? routeFrom : c.err('缺失')}`)
  const st = bundleState()
  ok(`插件列表登记 ${st.listed ? '已登记' : c.warn('未登记（--no-bundle?）')}，目录链接 ${st.linked ? '就绪' : c.err('缺失')}`)
  ok(`模型条目 ${models.length} 个：${models.slice(0, 3).map((m) => m.id).join(', ')} …`)

  // 装证书 + 抓一次会话：这是「装完就能用」和「装完还要自己折腾」的分界线
  let caOk = null
  let captureOk = null
  if (WANT_CA) caOk = await installCaStep()
  if (WANT_CAPTURE && caOk !== false) captureOk = await captureStep(WAIT_SEC)
  if (WANT_CAPTURE && caOk === false) warn('证书没装上，跳过抓包（证书不装，抓到的 HTTPS 也解不开）')

  printLink(await adminGet('/setup/link'))

  console.log(`\n${c.b('下一步')}`)
  if (captureOk) {
    console.log(`  1. 重启一次 DeepSeek Harness（加载设置页的新代码）`)
    console.log(`  2. 模型选择器里选 ${c.b('WorkBuddy')} → ${c.b('Auto（自动选择）')}，发一句话`)
    console.log(`  3. 日常只管用；抓到的凭证过期时，设置页会提示重新抓一次`)
  } else if (caOk === false) {
    console.log(`  1. ${c.b('装证书')}：双击 ${c.dim('bridge\\certs\\install-ca.cmd')}，完成后回到设置页点「重新检测」`)
    console.log(`  2. 设置页 → WorkBuddy →「开始抓包」，去 WorkBuddy 发一条消息，再点「停止并还原代理」`)
    console.log(`  3. 重启一次 DeepSeek Harness 后即可在模型选择器里看到 ${c.b('WorkBuddy')}`)
  } else {
    console.log(`  1. 重启一次 DeepSeek Harness（加载设置页的新代码）`)
    console.log(`  2. Settings → Plugins 里能看到 ${c.b('WorkBuddy 模型')}`)
    console.log(`  3. 设置页右上「安装到本机」装证书 →「开始抓包」→ 去 WorkBuddy 发一条消息 →「停止并还原代理」`)
    console.log(`  4. 模型选择器里选 ${c.b('WorkBuddy')} → ${c.b('Auto（自动选择）')}，发一句话`)
  }
  console.log(`  日志：${c.dim(join(BRIDGE_DIR, 'bridge.log'))}    指南：${c.dim('README.md / GUIDE.md')}`)
  console.log(`\n${c.dim('还原：node install.mjs --uninstall')}\n`)
}

main().catch((err) => die(err.stack || err.message))
