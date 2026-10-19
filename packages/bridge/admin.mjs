/**
 * 抓包环境的运维能力（供 UI 面板调用）
 *
 * 四件事：
 *   1. 检测/安装 mitmproxy（装到 bridge/.tools/mitm 的独立 venv，不污染系统 Python）
 *   2. 把随包附带的 CA 装进当前用户的 Root 证书库（certutil -user，无需管理员）
 *   3. 启停 mitmdump 子进程（带 WB_BRIDGE / WB_CAPTURE_KEY）
 *   4. 接管客户端流量（`--proxy-server` 启动参数，不写注册表），停止时把客户端拉回原样
 *
 * 全部只在 Windows 上完整可用；其他平台只做检测与起停。
 *
 * 代理这一环**完全不碰注册表**：老版本写 HKCU\...\Internet Settings 再刷 WinINet，
 * 在受限环境里 `reg.exe` 在程序黑名单上，写不进去整条链路就卡死。现在改成重启
 * WorkBuddy 时带 Chromium 的 `--proxy-server`，只影响这一个进程。
 *
 * CA：证书与私钥随包放在 `bridge/certs/`，mitmdump 用 `--set confdir=<bridge>/.ca`
 * 强制使用它，于是「安装证书」不再依赖「先跑一次抓包生成证书」这一步。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { createWorkBuddyClient } from './workbuddy-client.mjs'

const IS_WIN = process.platform === 'win32'
const MAX_LOG = 200

/** 随包 CA 的名字：证书库检测、卸载脚本都按它找 */
export const CA_CN = 'WorkBuddy Bridge Local CA'
/** 随包 CA 文件名（mitmproxy 认这套固定名字） */
export const CA_FILES = {
  pem: 'mitmproxy-ca.pem',
  certPem: 'mitmproxy-ca-cert.pem',
  cer: 'mitmproxy-ca-cert.cer',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 往设置页日志里加一行（server 的局域网/密钥操作也复用同一份日志） */
export function pushLog(bucket, line) {
  const text = String(line).replace(/\r/g, '').trimEnd()
  if (!text) return
  bucket.push(text)
  if (bucket.length > MAX_LOG) bucket.splice(0, bucket.length - MAX_LOG)
}

/**
 * 子进程输出的解码。
 *
 * certutil / reg 这类 Windows 自带的 exe 在中文系统上吐的是 GBK，直接按 UTF-8 读
 * 会得到一串乱码 —— 而这些输出恰恰是要显示给用户看的错误原因，所以先按 UTF-8 严格
 * 解一次，失败再退到 GBK。
 */
function decodeText(buf) {
  if (!buf.length) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return buf.toString('latin1')
    }
  }
}

/**
 * 跑一个子进程并把输出收进数组。
 *
 * 必须带超时：某些安全策略会把 certutil / reg 这类进程「挂住」而不是杀掉，
 * 没有超时的话设置页那一次请求会永远悬在那里，用户看到的就是一直转圈。
 */
function run(cmd, args, { cwd, env, onLine, timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    const bufs = { out: [], err: [] }
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    let child
    try {
      child = spawn(cmd, args, { cwd, env: env || process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: -1, out: '', err: String(e.message) })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经被杀掉了 */
      }
      finish({
        code: -1,
        out: decodeText(Buffer.concat(bufs.out)),
        err: `${decodeText(Buffer.concat(bufs.err))}\n[超时 ${timeout}ms：${cmd}]`.trim(),
        timeout: true,
      })
    }, timeout)
    const feed = (chunk, sink) => {
      bufs[sink].push(chunk)
      if (onLine) chunk.toString('utf8').split(/\r?\n/).forEach((l) => l && onLine(l))
    }
    child.stdout.on('data', (c) => feed(c, 'out'))
    child.stderr.on('data', (c) => feed(c, 'err'))
    child.on('error', (e) => finish({ code: -1, out: decodeText(Buffer.concat(bufs.out)), err: `${decodeText(Buffer.concat(bufs.err))}${e.message}` }))
    child.on('close', (code) =>
      finish({ code: code ?? -1, out: decodeText(Buffer.concat(bufs.out)), err: decodeText(Buffer.concat(bufs.err)) }),
    )
  })
}

export function createAdmin({ dir, capturePort = 8899, bridgePort = 8790, captureKey, addonPath }) {
  const TOOLS = join(dir, '.tools')
  const VENV = join(TOOLS, 'mitm')
  const MITMDUMP = IS_WIN ? join(VENV, 'Scripts', 'mitmdump.exe') : join(VENV, 'bin', 'mitmdump')
  const VENV_PY = IS_WIN ? join(VENV, 'Scripts', 'python.exe') : join(VENV, 'bin', 'python')
  // 旧版本用它记录 HKCU 里的原值；现在只用来识别「上一个版本留下的残局」
  const PROXY_BACKUP = join(dir, '.proxy-backup.json')
  // 随包 CA（随 zip 分发，装机即用）；运行期 confdir 复制一份，避免 mitmdump 往包目录里写东西
  const CERTS = join(dir, 'certs')
  const CA_DIR = join(dir, '.ca')
  const CER = join(CA_DIR, CA_FILES.cer)
  const BUNDLE_CER = join(CERTS, CA_FILES.cer)
  const BUNDLE_PEM = join(CERTS, CA_FILES.pem)
  const CA_SCRIPT = join(CERTS, 'install-ca.cmd')

  // 客户端进程接管（找 exe / 重启带参数 / 恢复），注册表那条路已经拆掉
  const wbc = createWorkBuddyClient({ dir })

  // 「这份 bridge 是不是从 WorkBuddy 里拉起的」。父进程链在进程存活期间不会变，
  // 且探一次要起 PowerShell（几百毫秒），所以首次调用后记住结果。
  // /health 带这个字段：start.cmd 发现自托管会先换掉再起，DSH 的 host 半体同理。
  let selfHostedCache = null
  async function selfHosted() {
    if (selfHostedCache === null) {
      try {
        selfHostedCache = await wbc.isSelfHosted()
      } catch {
        selfHostedCache = false
      }
    }
    return selfHostedCache
  }

  const log = []
  const state = {
    install: { running: false, phase: 'idle', error: null, startedAt: null, finishedAt: null },
    capture: { running: false, pid: null, port: capturePort, startedAt: null, proxy: false, error: null },
    proxy: { enabled: false, server: null, mode: 'launch', client: null, orphan: false },
  }

  let captureChild = null
  let statusCache = null
  let statusInflight = null
  // python / mitmdump / 证书探测都要 spawn 进程，几秒一次太贵：单独做一层 30s 缓存
  let probeCache = { at: 0, python: null, mitm: null, ca: false }
  const PROBE_TTL = 30_000

  /** 找到可用的 Python（优先环境变量，其次 PATH） */
  async function findPython() {
    const candidates = [
      process.env.WORKBUDDY_PYTHON && { cmd: process.env.WORKBUDDY_PYTHON, args: [] },
      { cmd: 'python', args: [] },
      { cmd: 'py', args: ['-3'] },
      { cmd: 'python3', args: [] },
    ].filter(Boolean)
    for (const c of candidates) {
      const r = await run(c.cmd, [...c.args, '-c', 'import sys;print(sys.version.split()[0])'])
      if (r.code === 0) return { ...c, version: r.out.trim() }
    }
    return null
  }

  /** venv 里的解释器路径是写死的绝对路径：换机器或升级 Python 后就跑不起来了 */
  async function venvPythonVersion() {
    if (!existsSync(VENV_PY)) return null
    const r = await run(VENV_PY, ['-c', 'import sys;print(sys.version.split()[0])'])
    return r.code === 0 ? r.out.trim() : null
  }

  /**
   * 把一个失效的 venv 挪开。
   *
   * 直接递归删 3000+ 个小文件在 Windows 上又慢又容易被占用（还有安全策略拦截批量删除），
   * 重命名是常数时间；新环境立刻可以建，旧目录放后台慢慢清。
   */
  function retireVenv() {
    const stale = `${VENV}.stale-${Date.now()}`
    try {
      renameSync(VENV, stale)
    } catch (err) {
      pushLog(log, `[venv] 旧环境重命名失败（${err.code || err.message}），先原地重建`)
      return
    }
    // 之前留下的残骸也顺手清掉，清不掉就算了，不影响使用
    setTimeout(() => {
      for (const name of readdirSync(TOOLS)) {
        if (!name.startsWith('mitm.stale-')) continue
        try {
          rmSync(join(TOOLS, name), { recursive: true, force: true })
        } catch {
          /* 被占用就留到下次 */
        }
      }
    }, 3000)
  }

  /** mitmdump 的三种状态：可用 / 装过但解释器失效 / 没装 */
  async function mitmState() {
    if (!existsSync(MITMDUMP)) return { installed: false, broken: false, version: null, path: null }
    const r = await run(MITMDUMP, ['--version'])
    if (r.code !== 0) {
      return {
        installed: false,
        broken: true,
        version: null,
        path: MITMDUMP,
        error: (r.err || r.out || `exit ${r.code}`).replace(/\s+/g, ' ').trim().slice(0, 300),
      }
    }
    const m = (r.out + r.err).match(/Mitmproxy:\s*(\S+)/i)
    return { installed: true, broken: false, version: m ? m[1] : 'unknown', path: MITMDUMP }
  }

  /**
   * 把随包 CA 铺到运行期 confdir。
   *
   * mitmproxy 只认 `<confdir>/mitmproxy-ca.pem`（私钥+证书在同一个文件里）。
   * 包里自带一份，所以第一次装证书不必先跑一次抓包去「生成」。
   * 包里的 CA 被人删掉时退回老行为：让 mitmproxy 自己在 confdir 生成一份。
   */
  function seedCa() {
    // 这里任何一个异常都不能往上抛：它挂在 /setup/status 的调用链上，
    // 一个 mkdir 失败就会把整个 bridge 进程搞死（实测过一次，界面直接变「网关未连接」）。
    try {
      if (!existsSync(CA_DIR)) mkdirSync(CA_DIR, { recursive: true })
    } catch (err) {
      pushLog(log, `[ca] 建 .ca/ 失败：${err.code || err.message}`)
      return null
    }

    // 三个文件各自比对、各自补齐：只盯 ca.pem 的话，
    // 一旦 ca.pem 在而另外两个缺了，证书库和 mitmdump 就会对不上
    const files = [
      [CA_FILES.pem, BUNDLE_PEM],
      [CA_FILES.certPem, join(CERTS, CA_FILES.certPem)],
      [CA_FILES.cer, join(CERTS, CA_FILES.cer)],
    ]
    let copied = 0
    for (const [name, src] of files) {
      const dst = join(CA_DIR, name)
      if (!existsSync(src)) continue
      try {
        const a = readFileSync(src)
        const b = existsSync(dst) ? readFileSync(dst) : null
        if (b && a.equals(b)) continue
        copyFileSync(src, dst)
        copied++
      } catch (err) {
        pushLog(log, `[ca] 同步 ${name} 失败：${err.code || err.message}`)
      }
    }
    if (copied) pushLog(log, `[ca] 已从 certs/ 同步随包 CA 到 .ca/（${copied} 个文件）`)

    const target = join(CA_DIR, CA_FILES.pem)
    return existsSync(target) ? target : null
  }

  /** DER 的 sha1 就是证书库里的 Cert Hash：用来确认装进去的确实是「这一份」CA */
  function thumbprint(file) {
    try {
      return createHash('sha1').update(readFileSync(file)).digest('hex').toUpperCase()
    } catch {
      return null
    }
  }

  async function caInstalled() {
    if (!IS_WIN) return false
    const file = existsSync(CER) ? CER : existsSync(BUNDLE_CER) ? BUNDLE_CER : null
    const r = await run('certutil', ['-user', '-store', 'Root', CA_CN], { timeout: 20_000 })
    if (r.code !== 0) return false
    const text = r.out + r.err
    if (!text.includes(CA_CN)) return false
    // 同名但换过一代 CA（用户自己重新生成过）时，这里只记一条日志、不拦人：
    // 拦下来会让用户彻底没法抓包，而实际症状（WorkBuddy 报证书错误）本身就很显眼
    const hash = file ? thumbprint(file) : null
    if (hash && !text.replace(/\s/g, '').toUpperCase().includes(hash)) {
      pushLog(log, '[ca] 证书库里的同名 CA 与随包 CA 指纹不一致，抓包前建议重装一次证书')
    }
    return true
  }

  function caInfo(installed) {
    const file = existsSync(CER) ? CER : existsSync(BUNDLE_CER) ? BUNDLE_CER : null
    return {
      cn: CA_CN,
      file,
      // bundled=true 表示证书随包附带，不需要先抓一次包去生成
      bundled: existsSync(BUNDLE_PEM),
      exists: Boolean(file),
      installed: Boolean(installed),
      script: existsSync(CA_SCRIPT) ? CA_SCRIPT : null,
      thumbprint: file ? thumbprint(file) : null,
    }
  }

  /**
   * 当前「代理」状态 = WorkBuddy 客户端有没有被我们用 `--proxy-server` 接管。
   *
   * 旧版本这里读 HKCU 的 ProxyEnable / ProxyServer，受限环境下 `reg.exe` 被黑名单
   * 拦掉，读回来是「未开启」，于是每次抓包都停在「代理设置未生效」。现在状态的唯一
   * 依据是 `.launch-state.json` + 进程是否真的在跑，全程不碰注册表。
   */
  async function readProxy() {
    return wbc.status(capturePort)
  }

  /** 上个版本可能留下系统代理备份；顺手清掉并提醒一句，免得用户以为还挂在 8899 上 */
  function reapLegacyBackup() {
    if (!existsSync(PROXY_BACKUP)) return null
    try {
      rmSync(PROXY_BACKUP, { force: true })
    } catch {
      return null
    }
    return '已清理旧版遗留的 .proxy-backup.json；如果之前手动改过系统代理，记得去 Windows 设置里确认已关闭'
  }

  /**
   * 状态快照。
   *
   * 每次取状态要 spawn 4~5 个子进程（python / mitmdump / certutil / reg），
   * 设置页又是轮询的，所以加一层 1.5s 的短缓存：UI 连点也不会把 CPU 打满。
   */
  async function collectStatus({ fresh = false } = {}) {
    const now = Date.now()
    seedCa()
    const probeStale = fresh || !probeCache.at || now - probeCache.at > PROBE_TTL
    if (probeStale) {
      const [python, mitm] = await Promise.all([findPython(), mitmState()])
      probeCache = { at: Date.now(), python, mitm, ca: await caInstalled() }
    }
    // 代理是唯一需要实时的项（用户刚点过开关就要看到结果）
    const proxy = await readProxy()
    return {
      platform: process.platform,
      python: probeCache.python ? { found: true, cmd: probeCache.python.cmd, version: probeCache.python.version } : { found: false },
      mitmproxy: probeCache.mitm,
      ca: caInfo(probeCache.ca),
      proxy,
      capture: { ...state.capture, running: Boolean(captureChild) },
      install: { ...state.install },
      logs: log.slice(-40),
      at: now,
    }
  }

  async function status({ fresh = false } = {}) {
    const now = Date.now()
    if (!fresh && statusCache && now - statusCache.at < 1500) return statusCache
    if (statusInflight) return statusInflight
    statusInflight = collectStatus({ fresh })
      .then((value) => {
        statusCache = value
        return value
      })
      .finally(() => {
        statusInflight = null
      })
    return statusInflight
  }

  async function install() {
    if (state.install.running) return { started: false, reason: 'already-running' }
    const py = await findPython()
    if (!py) {
      state.install = { running: false, phase: 'error', error: '找不到 Python，请先安装 Python 3.10+', startedAt: null, finishedAt: Date.now() }
      return { started: false, reason: 'no-python' }
    }
    state.install = { running: true, phase: 'venv', error: null, startedAt: Date.now(), finishedAt: null }
    log.push(`[install] python ${py.version} (${py.cmd})`)

    ;(async () => {
      try {
        mkdirSync(TOOLS, { recursive: true })
        // venv 里记的是创建时那个 Python 的绝对路径；路径变了（换机器/升级 Python）
        // 目录还在但跑不起来 —— 这种残骸必须删掉重建，否则 pip 永远起不来。
        if (existsSync(VENV)) {
          const alive = await venvPythonVersion()
          if (!alive) {
            state.install.phase = 'venv-reset'
            pushLog(log, '[venv] 旧虚拟环境解释器已失效，挪开重建')
            retireVenv()
          }
        }
        if (!existsSync(VENV_PY)) {
          const r = await run(py.cmd, [...py.args, '-m', 'venv', VENV], {
            onLine: (l) => pushLog(log, `[venv] ${l}`),
            timeout: 180_000,
          })
          if (r.code !== 0) throw new Error((r.err || r.out || 'venv 创建失败').slice(0, 400))
        }
        state.install.phase = 'install'
        const pipArgs = ['-m', 'pip', 'install', '--disable-pip-version-check']
        // 国内网络下 PyPI 经常很慢，允许用环境变量换镜像
        if (process.env.WORKBUDDY_PIP_INDEX) pipArgs.push('--index-url', process.env.WORKBUDDY_PIP_INDEX)
        pipArgs.push('mitmproxy')
        const r = await run(VENV_PY, pipArgs, {
          onLine: (l) => pushLog(log, `[pip] ${l}`),
          timeout: 900_000, // 装 mitmproxy 动辄几分钟，别被默认超时掐掉
        })
        if (r.code !== 0) throw new Error((r.err || r.out || 'pip install 失败').slice(0, 600))
        const version = await mitmState()
        if (!version.installed) throw new Error(`装完仍无法运行 mitmdump：${version.error || '未知原因'}`)
        state.install.phase = 'done'
        state.install.finishedAt = Date.now()
        pushLog(log, `[install] mitmproxy ${version.version} 安装完成`)
      } catch (e) {
        state.install.phase = 'error'
        state.install.error = e.message
        state.install.finishedAt = Date.now()
        pushLog(log, `[install] 失败: ${e.message}`)
      } finally {
        state.install.running = false
        invalidate() // 下次读状态重新探测
      }
    })()

    return { started: true }
  }

  /** 改完状态立刻让缓存失效，UI 刷新不用等 TTL */
  function invalidate() {
    statusCache = null
    probeCache = { at: 0, python: null, mitm: null, ca: false }
  }

  async function installCa() {
    if (!IS_WIN) return { ok: false, error: '仅支持 Windows' }
    seedCa()
    let file = existsSync(CER) ? CER : null
    if (!file) file = existsSync(BUNDLE_CER) ? BUNDLE_CER : null
    if (!file) {
      // 包里没有 CA（被删了）：退回老路，跑一次 mitmdump 让它自己生成
      const started = await startCapture({ proxy: false, quiet: true })
      if (!started.ok) return { ok: false, error: started.error }
      for (let i = 0; i < 20 && !existsSync(CER); i++) await sleep(300)
      await stopCapture({ quiet: true })
      file = existsSync(CER) ? CER : null
    }
    if (!file) return { ok: false, error: `CA 文件缺失：${CER}（从包里恢复 bridge/certs/ 后重试）` }

    // 主路：certutil 写当前用户 Root（不需要管理员）
    // 超时设短：受限环境会把 certutil 挂住，不能让它把这次请求拖死
    let r = await run('certutil', ['-user', '-addstore', '-f', 'Root', file], { timeout: 20_000 })
    if (r.code === 0) {
      invalidate()
      pushLog(log, '[ca] 已装入当前用户根证书库')
      return { ok: true, file, cn: CA_CN }
    }

    // 兜底：PowerShell 的证书提供程序（受限环境里两者都可能被拦，所以都试一遍）
    const ps =
      `Import-Certificate -FilePath '${file.replace(/'/g, "''")}' ` +
      '-CertStoreLocation Cert:\\CurrentUser\\Root | Out-Null'
    const r2 = await run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      timeout: 20_000,
    })
    if (r2.code === 0) {
      invalidate()
      pushLog(log, '[ca] 已通过 PowerShell 装入当前用户根证书库')
      return { ok: true, file, cn: CA_CN }
    }

    invalidate()
    // 只挑一句最有用的原因给用户看：certutil 的超时栈没有信息量，PowerShell 的报错才有
    const parts = []
    if (r.timeout) parts.push('certutil 20s 无响应（被安全策略挂住）')
    else {
      const line = (r.err || r.out || '').split(/\r?\n/).filter((l) => /失败|error|NTE_|denied/i.test(l))[0]
      if (line) parts.push(line.trim())
    }
    const psErr = (r2.err || r2.out || '').replace(/\s+/g, ' ').replace(/^\s*Import-Certificate\s*:\s*/, '').trim()
    if (psErr) parts.push(`PowerShell：${psErr.split(' 所在位置')[0].slice(0, 100)}`)
    const detail = parts.join('；').slice(0, 220)
    pushLog(log, `[ca] 安装失败: ${detail}`)
    // 写证书库被策略拦住时，把「用户自己双击一下」的路径直接给出去
    const hint = existsSync(CA_SCRIPT)
      ? `双击 ${CA_SCRIPT}（或右键「以管理员身份运行」），完成后点「重新检测」`
      : `手工导入 ${file} 到「受信任的根证书颁发机构」`
    return { ok: false, manual: true, file, script: existsSync(CA_SCRIPT) ? CA_SCRIPT : null, error: `写入证书库被拦截：${hint}。${detail}` }
  }

  /**
   * 开关「客户端接管」。
   *
   * 语义变了但接口名不变（server.mjs / ctl.mjs / UI 都按这个调）：
   *   - true  → 重启 WorkBuddy 并带 --proxy-server，抓完的流量进 mitmdump
   *   - false → 杀掉被接管的那份，原来开着就按普通方式重新拉起
   *
   * 不写注册表、不要求管理员、不影响用户其它程序 —— 这也是这次改造的全部理由。
   */
  async function setProxy(enabled) {
    if (!IS_WIN) return { ok: false, error: '仅支持 Windows' }

    const hint = reapLegacyBackup()
    if (hint) pushLog(log, `[proxy] ${hint}`)

    const r = enabled ? await wbc.takeOver(capturePort) : await wbc.release()
    invalidate()

    const after = await readProxy()
    state.proxy = {
      enabled: after.enabled,
      server: after.server,
      mode: after.mode,
      client: after.client,
      orphan: after.orphan,
    }

    if (enabled) {
      if (r.ok) {
        pushLog(
          log,
          r.already
            ? `[proxy] 客户端已被接管（pid=${r.pid}）`
            : `[proxy] 已给 WorkBuddy 注入 HTTP_PROXY=${r.proxy} 并重启${r.restarted ? '（原来在跑，已重启）' : ''}`,
        )
        return { ok: true, proxy: after, restarted: Boolean(r.restarted), pid: r.pid, exe: r.exe, mode: 'launch' }
      }
      pushLog(log, `[proxy] 接管失败：${r.error}`)
      return { ok: false, code: r.code || null, error: r.error, proxy: after }
    }

    if (r.ok) {
      pushLog(log, r.noop ? '[proxy] 没有接管中的客户端，无需恢复' : '[proxy] 已退出接管，客户端已恢复普通启动')
      return { ok: true, proxy: after, relaunched: Boolean(r.relaunched) }
    }
    pushLog(log, `[proxy] 恢复失败：${r.error}`)
    return { ok: false, code: r.code || null, error: r.error, proxy: after }
  }

  async function portOpen(port, tries = 40) {
    for (let i = 0; i < tries; i++) {
      const ok = await new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => {
          socket.destroy()
          resolve(true)
        })
        socket.on('error', () => resolve(false))
        socket.setTimeout(400, () => {
          socket.destroy()
          resolve(false)
        })
      })
      if (ok) return true
      await sleep(300)
    }
    return false
  }

  async function startCapture({ proxy = true, quiet = false } = {}) {
    if (captureChild) return { ok: true, already: true }
    if (!existsSync(MITMDUMP)) return { ok: false, error: '还没安装 mitmproxy' }
    if (!(await venvPythonVersion())) {
      return { ok: false, error: 'mitmproxy 装过但虚拟环境已失效（解释器路径变了），请在设置页点「重新安装」' }
    }
    // 证书没装就开抓包，用户只会看到 WorkBuddy 里一片证书错误 —— 提前拦住并指出下一步。
    // 例外：证书装在「本地计算机」证书库（不是当前用户）时我们查不到，给一个显式开关。
    if (IS_WIN && !quiet && process.env.WORKBUDDY_SKIP_CA_CHECK !== '1' && !(await caInstalled())) {
      return {
        ok: false,
        needsCa: true,
        error: 'CA 还没装进本机证书库：先点「安装到本机」，否则 WorkBuddy 的 HTTPS 会报证书错误',
      }
    }
    // 只监听回环：代理端口别暴露到局域网
    // confdir 指向随包 CA：保证 mitmdump 签出来的叶子证书能对上用户装的那张根证书
    seedCa()
    const args = [
      '-s',
      addonPath,
      '--listen-host',
      '127.0.0.1',
      '--listen-port',
      String(capturePort),
      '--set',
      'block_global=false',
      '--set',
      `confdir=${CA_DIR.replace(/\\/g, '/')}`,
    ]
    try {
      captureChild = spawn(MITMDUMP, args, {
        env: { ...process.env, WB_BRIDGE: `http://127.0.0.1:${bridgePort}`, WB_CAPTURE_KEY: captureKey },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (e) {
      captureChild = null
      return { ok: false, error: e.message }
    }
    captureChild.stdout.on('data', (c) => pushLog(log, `[mitm] ${c}`))
    captureChild.stderr.on('data', (c) => pushLog(log, `[mitm] ${c}`))
    captureChild.on('close', (code) => {
      pushLog(log, `[mitm] 退出 code=${code}`)
      captureChild = null
      state.capture.running = false
    })
    state.capture = { running: true, pid: captureChild.pid, port: capturePort, startedAt: Date.now(), proxy: false, error: null }

    const up = await portOpen(capturePort)
    if (!up) {
      state.capture.error = 'mitmdump 没能在端口上就绪，看日志'
      if (!quiet) pushLog(log, '[mitm] 端口未就绪')
    }
    if (proxy) {
      const p = await setProxy(true)
      state.capture.proxy = Boolean(p.ok)
      // 接管失败就别留一个「mitmdump 在跑但流量没进来」的空转状态：
      // 用户看到的会是「运行中 :8899」+ 面板一片安静，比直接报错更难查
      if (!p.ok) {
        await stopCapture({ proxy: false, quiet: true })
        return {
          ok: false,
          port: capturePort,
          code: p.code || 'PROXY_FAILED',
          error: `抓包没能接管 WorkBuddy 流量：${p.error || '原因未知'}`,
          proxy: p.proxy,
        }
      }
    }
    invalidate()
    return {
      ok: up,
      port: capturePort,
      pid: captureChild.pid,
      restarted: Boolean(state.capture.proxy),
      error: up ? null : state.capture.error,
    }
  }

  async function stopCapture({ proxy = true, quiet = false } = {}) {
    if (captureChild?.pid) {
      const pid = captureChild.pid
      if (IS_WIN) await run('taskkill', ['/PID', String(pid), '/T', '/F'])
      else captureChild.kill('SIGTERM')
      captureChild = null
      state.capture.running = false
      state.capture.pid = null
      if (!quiet) pushLog(log, `[mitm] 已停止 pid=${pid}`)
    }
    // 接管是幂等的：没接管过就是 noop，别再用「备份文件是否存在」来判断
    if (proxy) await setProxy(false)
    invalidate()
    return { ok: true }
  }

  return { status, install, installCa, caInstalled, seedCa, startCapture, stopCapture, setProxy, readProxy, selfHosted, log }
}
