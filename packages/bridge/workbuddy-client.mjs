/**
 * 接管 WorkBuddy 客户端流量 —— 全程不碰注册表。
 *
 * 老做法是把系统代理（HKCU\...\Internet Settings）指到 8899，受限环境里
 * `reg.exe` 在程序黑名单上，写不进去就整条链路卡死。这里改成：
 *
 *   1. 找到 WorkBuddy.exe（环境变量 WORKBUDDY_CLIENT_EXE 可覆盖）
 *   2. 让它先退出（Electron 有单实例锁，不退出新进程只会把旧窗口顶到前台）
 *   3. 用 `HTTP_PROXY=http://127.0.0.1:8899` 重新拉起 —— 这是客户端自己的代码路径：
 *      启动时 `configureRendererSessionProxy()` 会读 `HTTP_PROXY`/`http_proxy`，然后
 *      `session.setProxy({proxyRules})` 只作用于它自己的 defaultSession
 *   4. 抓完把这份进程杀掉，按接管前的环境重新拉起（原来没开就不拉起）
 *
 * 为什么是环境变量而不是 `--proxy-server`：客户端启动时会显式调 `session.setProxy`
 * （读过 app.asar 确认），命令行开关会被它覆盖掉 —— 写了也不生效。
 *
 * 为什么不是「改 WorkBuddy 自己的配置文件」：它的 userData 里没有代理项
 * （app-config.json 只有一个版本号），没有可写的开关。
 *
 * 状态落 `<bridge>/.launch-state.json`，bridge 重启后靠它判断「客户端现在是不是
 * 被我们接管着」；pid 已经不在、但状态文件还在 = 上一次没收尾，面板会提示恢复。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const IS_WIN = process.platform === 'win32'
/** 默认镜像名；改名版 / 自测替身可以用 WORKBUDDY_CLIENT_IMAGE 覆盖 */
const DEFAULT_IMAGE = 'WorkBuddy.exe'
const STATE_FILE = '.launch-state.json'

/** 极简子进程执行：这里只跑 tasklist / taskkill / powershell，输出都是短文本 */
function run(cmd, args, { timeout = 20_000 } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    const finish = (code, extra = '') => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, out: out + extra, err })
    }
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: -1, out: '', err: String(e.message) })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
      finish(-1, '\n[超时]')
    }, timeout)
    child.stdout.on('data', (c) => (out += c.toString('utf8')))
    child.stderr.on('data', (c) => (err += c.toString('utf8')))
    child.on('error', (e) => finish(-1, String(e.message)))
    child.on('close', (code) => finish(code ?? -1))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 缓存：UI 每 1.5s 轮询一次状态，别每次都去扫盘 / 跑 tasklist */
let exeCache
let exeMissAt = 0
let pidsCache = { at: 0, pids: [] }
const PIDS_TTL = 1500

export function createWorkBuddyClient({ dir, env = process.env } = {}) {
  const STATE = join(dir, STATE_FILE)
  const IMAGE = env.WORKBUDDY_CLIENT_IMAGE || DEFAULT_IMAGE
  const IMAGE_STEM = IMAGE.replace(/\.exe$/i, '')

  function readState() {
    if (!existsSync(STATE)) return null
    try {
      const raw = JSON.parse(readFileSync(STATE, 'utf8'))
      return raw && typeof raw === 'object' ? raw : null
    } catch {
      return null
    }
  }

  function writeState(value) {
    try {
      writeFileSync(STATE, JSON.stringify(value, null, 2))
    } catch {
      /* 写不进去不影响本次接管，只是重启后认不出来 */
    }
  }

  function clearState() {
    try {
      rmSync(STATE, { force: true })
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 找 WorkBuddy.exe。
   *
   * 顺序：环境变量 → 运行中进程的路径（PowerShell，可能被策略拦）→ 常见安装位置。
   * 盘符扫描是 existsSync，不存在的盘立刻失败，代价可以忽略。
   *
   * 两个省事的细节：
   *   - 客户端没在跑就不去问 PowerShell（那一步要 1~2 秒，面板还会轮询）
   *   - 没找到时记 60 秒负缓存，避免每次轮询都扫一遍盘
   */
  async function resolveExe({ fresh = false, running } = {}) {
    if (exeCache && !fresh) return exeCache
    if (!fresh && exeMissAt && Date.now() - exeMissAt < 60_000) return null
    if (env.WORKBUDDY_CLIENT_EXE && existsSync(env.WORKBUDDY_CLIENT_EXE)) {
      exeCache = env.WORKBUDDY_CLIENT_EXE
      exeMissAt = 0
      return exeCache
    }

    // 已经在跑的话，进程路径是最准的（用户可能装在任意盘符的任意目录）
    const hasProc = running === undefined ? (await listPids()).length > 0 : running
    if (hasProc) {
      const ps = await run(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `(Get-Process -Name '${IMAGE_STEM}' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1).Path`,
        ],
        { timeout: 8000 },
      )
      const fromPs = (ps.out || '').trim().split(/\r?\n/).pop()
      if (ps.code === 0 && fromPs && /\.exe$/i.test(fromPs) && existsSync(fromPs)) {
        exeCache = fromPs
        exeMissAt = 0
        return exeCache
      }
    }

    const candidates = []
    const local = env.LOCALAPPDATA
    if (local) {
      candidates.push(join(local, 'Programs', 'WorkBuddy', IMAGE))
      candidates.push(join(local, 'WorkBuddy', IMAGE))
    }
    for (const drive of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      candidates.push(`${drive}:\\Program Files\\WorkBuddy\\${IMAGE}`)
      candidates.push(`${drive}:\\Program Files (x86)\\WorkBuddy\\${IMAGE}`)
      candidates.push(`${drive}:\\WorkBuddy\\${IMAGE}`)
    }
    for (const file of candidates) {
      if (existsSync(file)) {
        exeCache = file
        exeMissAt = 0
        return exeCache
      }
    }
    exeCache = null
    exeMissAt = Date.now()
    return null
  }

  /** tasklist 的 CSV 输出：字段 2 就是 PID */
  async function listPids({ fresh = false } = {}) {
    if (!IS_WIN) return []
    if (!fresh && Date.now() - pidsCache.at < PIDS_TTL) return pidsCache.pids
    const r = await run('tasklist', ['/FI', `IMAGENAME eq ${IMAGE}`, '/FO', 'CSV', '/NH'], { timeout: 10_000 })
    const pids = []
    for (const line of (r.out || '').split(/\r?\n/)) {
      const m = line.match(/^\s*"([^"]+)","(\d+)"/)
      if (m && m[1].toLowerCase() === IMAGE.toLowerCase()) pids.push(Number(m[2]))
    }
    pidsCache = { at: Date.now(), pids }
    return pids
  }

  const isRunning = async ({ fresh = false } = {}) => (await listPids({ fresh })).length > 0

  /**
   * bridge 自己是不是跑在 WorkBuddy 里（WorkBuddy 的终端 / 内置 agent 拉起 node）。
   *
   * 是的话「重启客户端」会把 bridge 一起带走，抓包瞬间断链 —— 直接拒绝，让用户换个
   * 终端跑 bridge。父进程链查不到时（PowerShell 被拦）按「不是」处理，不拦人。
   */
  async function isSelfHosted() {
    if (!IS_WIN) return false
    if (env.WORKBUDDY_LAUNCH_FORCE === '1') return false
    const script =
      `$procId=${process.pid};` +
      'for($i=0;$i -lt 12;$i++){' +
      '$p=Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue;' +
      'if(-not $p){break};' +
      `if($p.Name -eq '${IMAGE}'){'YES';break};` +
      '$procId=$p.ParentProcessId}'
    const r = await run(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 10_000 },
    )
    if (r.code !== 0) return false
    return /\bYES\b/.test(r.out || '')
  }

  const PROXY_ENV_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']

  /** 接管前用户自己的代理环境变量：恢复时原样还回去，别把人家的网络设置带走 */
  function snapshotProxyEnv() {
    const saved = {}
    for (const k of PROXY_ENV_KEYS) saved[k] = k in env ? env[k] : null
    return saved
  }

  /**
   * 拉起客户端。
   *   - proxyUrl 有值：四个代理变量都指过去（客户端只认 HTTP_PROXY/http_proxy，
   *     另外两个是给主进程里走 Node 的请求用的）
   *   - envBefore 有值：按接管前拍下来的值还原（null = 原来就没有，删掉）
   *   - 都没有：原样继承当前环境
   *
   * ⚠️ 必须剥掉 ELECTRON_* 变量：bridge 若是 DSH 拉起的，环境里有
   * ELECTRON_RUN_AS_NODE=1 —— 原样传给 WorkBuddy.exe（同为 Electron）会让它
   * 以纯 Node 模式启动、无参数立即退出。真实事故：waitClient 20 秒看不到进程，
   * 回滚还原也秒死，用户只能手动重开客户端。已实测复现（spawn 后 <1.5s 退出）。
   */
  const CHILD_ENV_STRIP = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_ENABLE_LOGGING']

  function launch(exe, { proxyUrl, envBefore } = {}) {
    const childEnv = { ...env }
    for (const k of CHILD_ENV_STRIP) delete childEnv[k]
    for (const k of PROXY_ENV_KEYS) {
      if (proxyUrl) childEnv[k] = proxyUrl
      else if (envBefore && Object.prototype.hasOwnProperty.call(envBefore, k)) {
        if (envBefore[k] === null) delete childEnv[k]
        else childEnv[k] = envBefore[k]
      }
    }
    const child = spawn(exe, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: childEnv,
    })
    child.unref()
    return child.pid
  }

  async function waitNoClient(ms) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if ((await listPids({ fresh: true })).length === 0) return true
      await sleep(400)
    }
    return (await listPids({ fresh: true })).length === 0
  }

  async function waitClient(ms) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if ((await listPids({ fresh: true })).length > 0) return true
      await sleep(400)
    }
    return (await listPids({ fresh: true })).length > 0
  }

  const serverUrl = (port) => `http://127.0.0.1:${port}`

  /**
   * 接管：重启客户端并挂上 --proxy-server。
   * 返回 { ok, pid, exe, restarted, proxy } 或 { ok:false, error, code }。
   */
  async function takeOver(port) {
    if (!IS_WIN) return { ok: false, code: 'OS', error: '接管客户端只在 Windows 上可用' }
    const exe = await resolveExe()
    if (!exe) {
      return {
        ok: false,
        code: 'NO_EXE',
        error: '找不到 WorkBuddy.exe：用环境变量 WORKBUDDY_CLIENT_EXE 指到安装路径（例如 D:\\Program Files\\WorkBuddy\\WorkBuddy.exe）',
      }
    }

    const st = readState()
    if (st?.pid) {
      const pids = await listPids({ fresh: true })
      // 只有「记录的那个 pid 还在」才算接管中；pid 不在就当上次没收尾，
      // 清掉状态照常走下面的重启流程（否则会出现「以为接管了其实没接管」）
      if (pids.includes(st.pid)) {
        return { ok: true, already: true, pid: st.pid, exe: st.exe || exe, proxy: serverUrl(st.port || port) }
      }
      clearState()
    }

    if (await isSelfHosted()) {
      return {
        ok: false,
        code: 'SELF_HOSTED',
        pid: process.pid,
        error:
          `抓包会先重启 WorkBuddy，但当前 bridge（PID ${process.pid}）是从 WorkBuddy 里启动的` +
          '（父进程链里有 WorkBuddy.exe），会被一起带走。两个办法：' +
          '① 重启一次 DSH —— 它会自动换一份自己拉起的 bridge；' +
          `② 手动：先 taskkill /PID ${process.pid} /F 结束这份，再双击 packages\\bridge\\start.cmd 起一份新的。然后重试`,
      }
    }

    const wasRunning = (await listPids({ fresh: true })).length > 0
    if (wasRunning) {
      const killed = await run('taskkill', ['/IM', IMAGE, '/T', '/F'], { timeout: 20_000 })
      if (killed.code !== 0 && (await isRunning({ fresh: true }))) {
        return { ok: false, code: 'KILL_FAILED', error: '关不掉 WorkBuddy（可能被安全策略拦），先手动退出它再点「开始抓包」' }
      }
      if (!(await waitNoClient(12_000))) {
        return { ok: false, code: 'KILL_TIMEOUT', error: 'WorkBuddy 没能在 12 秒内退出，先手动关掉它再试' }
      }
    }

    const envBefore = snapshotProxyEnv()
    let spawned
    try {
      spawned = launch(exe, { proxyUrl: serverUrl(port) })
    } catch (e) {
      if (wasRunning) launch(exe, { envBefore })
      return { ok: false, code: 'SPAWN_FAILED', error: `拉起 WorkBuddy 失败：${e.message}` }
    }
    if (!(await waitClient(20_000))) {
      if (wasRunning) launch(exe, { envBefore })
      return { ok: false, code: 'SPAWN_TIMEOUT', error: '拉起 WorkBuddy 后 20 秒内没检测到进程，看下是不是被安全软件拦了启动' }
    }

    // 主进程可能会重新 exec 自己，实际 pid 以 tasklist 为准
    const pids = await listPids({ fresh: true })
    const pid = pids.includes(spawned) ? spawned : pids[0]
    writeState({
      pid,
      exe,
      wasRunning,
      port,
      proxy: serverUrl(port),
      envBefore,
      startedAt: new Date().toISOString(),
    })
    return { ok: true, pid, exe, restarted: wasRunning, proxy: serverUrl(port) }
  }

  /** 恢复：把被接管的进程关掉，原来开着就按普通方式重新拉起 */
  async function release() {
    if (!IS_WIN) return { ok: true, noop: true }
    const st = readState()
    if (!st) return { ok: true, noop: true }

    if (await isRunning({ fresh: true })) {
      await run('taskkill', ['/IM', IMAGE, '/T', '/F'], { timeout: 20_000 })
      await waitNoClient(12_000)
    }
    clearState()

    // 同步一下缓存，避免后面 status 还看到刚被杀掉的 pid
    pidsCache = { at: 0, pids: [] }

    const exe = st.exe && existsSync(st.exe) ? st.exe : await resolveExe({ fresh: true })
    if (st.wasRunning && exe && !(await isRunning({ fresh: true }))) {
      try {
        // 按接管前拍下来的环境还原：用户原来有自己的代理就还给他，别留一个指向 8899 的变量
        launch(exe, { envBefore: st.envBefore })
        await waitClient(20_000)
      } catch {
        /* 拉不起来就把路径告诉用户 */
        return { ok: false, code: 'RELAUNCH_FAILED', error: `已停止接管，但没能把 WorkBuddy 拉回来，手动打开：${exe}` }
      }
    }
    return { ok: true, relaunched: Boolean(st.wasRunning) }
  }

  /** 面板用的状态；和旧的 proxy 字段同名，UI 不用大改 */
  async function status(port) {
    const pids = await listPids()
    const exe = await resolveExe({ running: pids.length > 0 })
    const st = readState()
    // 判据必须是「我们记录的那个 pid 还在」，不是「有 WorkBuddy 在跑」：
    // 用户手动重开一份时进程名一样，但那份没带 --proxy-server
    const active = Boolean(st?.pid) && pids.includes(st.pid)
    return {
      mode: IS_WIN ? 'launch' : 'off', // launch = 启动参数接管；注册表那条路已经拆掉
      enabled: active,
      server: active ? st.proxy || serverUrl(st.port || port) : null,
      pid: st?.pid ?? null,
      since: st?.startedAt ?? null,
      orphan: Boolean(st?.pid) && !active,
      client: {
        found: Boolean(exe),
        exe: exe || null,
        running: pids.length > 0,
        count: pids.length,
      },
    }
  }

  return { resolveExe, listPids, isRunning, isSelfHosted, readState, clearState, takeOver, release, status, serverUrl }
}
