/**
 * Host 半体。
 *
 * 除了给 bundle 占一个可寻址的行，还负责「DSH 一启动就把本地网关拉起来」。
 *
 * 为什么要这么做：bridge 之前是安装器或人手起的临时进程，会话/终端一关就没了。
 * 用户再打开设置页看到的就是「网关未连接 / Failed to fetch」，而且界面里没有任何
 * 能把它启动起来的入口（bridge 都没跑，自然没有 API 可调）。放在这里最合适：
 * DSH 加载插件的时刻，就是「应该有一个网关」的时刻。
 *
 * 约定：绝不让这里抛异常。插件加载失败会连带整个 DSH 起不来，代价远大于网关缺席。
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.WORKBUDDY_PORT || 8790)
const HERE = dirname(fileURLToPath(import.meta.url))
// 桥的两种落点：
//   1) git/npm 安装形态：bridge 打进包内，位于 <pkg>/bridge（lib/ 上一级即包根）
//   2) 仓库/zip 源码形态：bridge 是包外的同级目录 <pkg>/../bridge
const PKG_ROOT = join(HERE, '..')
const BUNDLED_BRIDGE = join(PKG_ROOT, 'bridge')
const SIBLING_BRIDGE = join(HERE, '..', '..', 'bridge')
const BRIDGE_DIR = existsSync(join(BUNDLED_BRIDGE, 'server.mjs')) ? BUNDLED_BRIDGE : SIBLING_BRIDGE
const BRIDGE_ENTRY = join(BRIDGE_DIR, 'server.mjs')
const BRIDGE_LOG = join(BRIDGE_DIR, 'bridge.log')
const BRIDGE_TOKEN_FILE = join(BRIDGE_DIR, '.bridge-token')

// DSH 的凭证引用：路由里 apiKeyEnv=WORKBUDDY_BRIDGE_TOKEN，值来自这里
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CRED_FILE = join(DSH_HOME, '.credentials.yaml')
const TOKEN_REF = 'WORKBUDDY_BRIDGE_TOKEN'

let spawning = false

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 探活。返回 /health 的 JSON（起没起都返回，起不来返回 null） */
async function probe(timeoutMs = 800) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/**
 * 把 bridge 的本地令牌同步进 DSH 凭证文件。
 *
 * 为什么必须在 host 半体里做：路由用的是 `apiKeyEnv: WORKBUDDY_BRIDGE_TOKEN`，
 * 这个值来自 `$DSH_HOME/.credentials.yaml` 的 `refs:`。以前只有 `install.mjs` 写它，
 * 而 `dsh plugin add github:...` 这条路**不会**跑安装器 —— 于是 bridge 换一份新的
 * （令牌重新生成）、DSH 还拿着旧令牌，每个请求都 401。
 *
 * 约定：尽力而为，任何异常都只记日志（插件加载不能因为它失败）。
 * 只在值不同时写盘，避免每次启动都动用户的凭证文件。
 */
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

function syncCredential() {
  try {
    if (!existsSync(BRIDGE_TOKEN_FILE)) return 'no-token'
    const token = readFileSync(BRIDGE_TOKEN_FILE, 'utf8').trim()
    if (!token) return 'empty-token'
    if (!existsSync(CRED_FILE)) {
      mkdirSync(dirname(CRED_FILE), { recursive: true })
      writeFileSync(CRED_FILE, `version: 1\nrefs:\n  ${TOKEN_REF}: ${token}\n`, { mode: 0o600 })
      return 'created'
    }
    const before = readFileSync(CRED_FILE, 'utf8')
    const after = upsertRef(before, TOKEN_REF, token)
    if (after === before) return 'unchanged'
    writeFileSync(CRED_FILE, after, { mode: 0o600 })
    return 'updated'
  } catch (err) {
    return `error: ${(err && err.message) || err}`
  }
}

function startDetached() {
  if (spawning) return 'already-spawning'
  if (!existsSync(BRIDGE_ENTRY)) return `missing: ${BRIDGE_ENTRY}`
  spawning = true
  let out = null
  try {
    out = openSync(BRIDGE_LOG, 'a')
    const env = { ...process.env }
    // DSH 桌面版的 host 跑在 Electron 里，execPath 是 DeepSeek Harness.exe；
    // 只有加上这个环境变量才会按 Node 执行脚本，否则会再弹一个 GUI。
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    const child = spawn(process.execPath, [BRIDGE_ENTRY], {
      cwd: BRIDGE_DIR,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      env,
    })
    child.unref()
    return `spawned pid=${child.pid}`
  } catch (err) {
    return `error: ${(err && err.message) || err}`
  } finally {
    if (out !== null) {
      try {
        closeSync(out)
      } catch {
        /* 子进程已经接手这个 fd */
      }
    }
    setTimeout(() => {
      spawning = false
    }, 5000).unref?.()
  }
}

/**
 * 杀掉一份「来路不对」的 bridge，等端口释放。
 *
 * 自托管（父进程链里有 WorkBuddy.exe）的 bridge 是从 WorkBuddy 里被拉起来的 ——
 * 抓包时要重启客户端，会把它一起带走。这种 bridge 必须换成 DSH 自己拉起的。
 * 杀同级用户的进程不需要特权；杀不掉就由调用方继续用旧的，不硬撑。
 */
async function replaceSelfHosted(pid) {
  try {
    process.kill(pid)
  } catch {
    return false
  }
  for (let i = 0; i < 20; i++) {
    await sleep(250)
    if (!(await probe(400))) return true
  }
  return false
}

/** 网关没起就拉起来；已有一份但是自托管的，换成自己拉起的 */
export async function ensureBridge() {
  const health = await probe()
  if (health && health.ok && !health.selfHosted) {
    // 已经在跑也要同步：期间可能重装过插件，令牌换了而 DSH 还拿旧的
    const cred = syncCredential()
    if (process.env.WORKBUDDY_DEBUG === '1') console.log(`[workbuddy] credential ${cred}`)
    return 'already-running'
  }
  if (health && health.ok && health.selfHosted) {
    const replaced = await replaceSelfHosted(health.pid)
    if (!replaced) return `self-hosted bridge (pid=${health.pid}) 换不掉，继续用旧的`
    console.log(`[workbuddy] 换掉自托管 bridge (pid=${health.pid})，改为 DSH 自己拉起`)
  }
  const r = startDetached()
  if (r !== 'spawned') {
    if (process.env.WORKBUDDY_DEBUG === '1') console.log(`[workbuddy] bridge ${r}`)
    return r
  }
  // 给一点启动时间，让紧随其后的设置页请求不至于扑空
  for (let i = 0; i < 25; i++) {
    await sleep(200)
    if (await probe(400)) {
      // 令牌是 bridge 启动时生成的，这里才拿得到；同步到 DSH 凭证后请求才不会 401
      const cred = syncCredential()
      if (process.env.WORKBUDDY_DEBUG === '1') console.log(`[workbuddy] credential ${cred}`)
      return r
    }
  }
  return `${r} (health 未就绪)`
}

export function apply() {
  // 不 await：插件加载不该被网关启动拖住，也不能因为网关失败而失败
  ensureBridge().catch(() => {})
}
