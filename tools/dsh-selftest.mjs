#!/usr/bin/env node
/**
 * DSH × bridge 端到端自测
 *
 * 做的是真事：起一个 mock bridge，用本机 DeepSeek Harness 的真实运行时
 * 建一个临时 headless profile，装上我们的路由，跑一次 agent 请求，
 * 断言模型输出来自 bridge。
 *
 * 依赖：本机已安装 DeepSeek Harness（读取它的 app.asar 作为运行时）。
 * 产物：<系统临时目录>/dsh-selftest-runtime（首次解包运行时，约 430MB）、
 *       <系统临时目录>/dsh-selftest-home
 *       放系统临时目录而不是仓库里：跨盘/机械盘上解包 1.5 万个小文件会慢一个量级。
 *
 *   node tools/dsh-selftest.mjs             # 跑一次
 *   node tools/dsh-selftest.mjs --fresh     # 重新解包运行时
 *   DSH_RUNTIME=<dir> node tools/dsh-selftest.mjs   # 复用已解包的运行时
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderPatchBlock, upsertBlock } from '../packages/dsh-plugin-workbuddy/lib/route.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const RUNTIME = join(tmpdir(), 'dsh-selftest-runtime')
const HOME = join(tmpdir(), 'dsh-selftest-home')
const PORT = 8791
const TOKEN = 'wb_selftest_token_0001'
const FRESH = process.argv.includes('--fresh')

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
}

function findAsar() {
  const candidates = [
    join(process.env.LOCALAPPDATA || '', 'Programs/DeepSeek Harness/resources/app.asar'),
    'C:/Users/Stud/AppData/Local/Programs/DeepSeek Harness/resources/app.asar',
  ]
  return candidates.find((p) => p && existsSync(p) && p.endsWith('.asar'))
}

/**
 * 异步跑子进程。
 * 不用 spawnSync：部分受限环境里同步创建子进程会直接 EBUSY。
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0 && !opts.allowFail) {
        reject(new Error(`命令失败: ${cmd} ${args.join(' ')} (exit ${code})\n${(stderr || stdout).slice(0, 800)}`))
        return
      }
      resolve({ status: code, stdout, stderr })
    })
  })
}

function ensureRuntime() {
  const roots = [process.env.DSH_RUNTIME, RUNTIME].filter(Boolean)
  for (const root of roots) {
    const bin = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    if (existsSync(bin) && !FRESH) return bin
  }
  const asar = findAsar()
  if (!asar) {
    console.error(c.bad('找不到 DeepSeek Harness 的 app.asar；先安装 DeepSeek Harness 或设置 DSH_RUNTIME'))
    process.exit(1)
  }
  return asar
}

async function prepareRuntime() {
  const roots = [process.env.DSH_RUNTIME, RUNTIME].filter(Boolean)
  for (const root of roots) {
    const bin = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    if (existsSync(bin) && !FRESH) return bin
  }
  const asar = ensureRuntime()
  console.log(c.dim(`解包运行时: ${asar}`))
  await run(process.execPath, [join(ROOT, 'tools/asar-extract-dir.mjs'), asar, 'dsh/node_modules', join(RUNTIME, 'node_modules')])
  const unpacked = join(dirname(asar), 'app.asar.unpacked/dsh/node_modules')
  if (existsSync(unpacked)) cpSync(unpacked, join(RUNTIME, 'node_modules'), { recursive: true })
  const bin = join(RUNTIME, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  if (!existsSync(bin)) {
    console.error(c.bad(`解包后仍找不到 CLI: ${bin}`))
    process.exit(1)
  }
  return bin
}

async function waitHealth(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
      if (r.ok) return await r.json()
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

async function main() {
  console.log(c.b('\nDSH × WorkBuddy bridge 自测'))

  const bin = await prepareRuntime()

  // 1. mock bridge
  const bridge = spawn(process.execPath, [join(ROOT, 'packages/bridge/server.mjs')], {
    env: { ...process.env, WORKBUDDY_MOCK: '1', WORKBUDDY_PORT: String(PORT), WORKBUDDY_LOCAL_TOKEN: TOKEN },
    stdio: 'ignore',
  })
  const health = await waitHealth(PORT)
  if (!health) throw new Error('mock bridge 启动失败')
  console.log(`  ${c.ok('✓')} bridge :${PORT} mode=${health.mode}`)

  try {
    // 2. 临时 home + headless profile
    rmSync(HOME, { recursive: true, force: true })
    mkdirSync(join(HOME, 'profiles'), { recursive: true })
    writeFileSync(join(HOME, '.credentials.yaml'), `version: 1\nrefs:\n  WORKBUDDY_BRIDGE_TOKEN: ${TOKEN}\n`)

    const env = { ...process.env, DSH_HOME: HOME }
    const created = await run(
      process.execPath,
      [bin, '--profile', 'selftest', '--from-default-profile', 'headless', '--dump-config'],
      { env, allowFail: true },
    )
    const patchFile = join(HOME, 'profiles/selftest/cordis.patch.yml')
    if (!existsSync(patchFile)) {
      throw new Error(`模板 profile 创建失败：${(created.stderr || created.stdout || '').slice(0, 400)}`)
    }
    console.log(`  ${c.ok('✓')} profile selftest 已创建`)

    // 3. 装路由：headless 默认关掉了 credentials，这里打开（桌面 profile 本来就是开的）
    let patch = readFileSync(patchFile, 'utf8')
    patch = upsertBlock(patch, renderPatchBlock({ baseUrl: `http://127.0.0.1:${PORT}/v1` }))
    patch +=
      '\n# 测试专用：headless 模板默认 disabled，桌面 profile 不需要这一段\n' +
      "- id: credentials\n  name: '@deepseek-ai/dsh-credentials-local'\n  disabled: false\n" +
      "- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n  config:\n    provider: workbuddy\n    model: auto\n"
    writeFileSync(patchFile, patch)

    // 4. 跑一次真实 agent 请求
    const res = await run(process.execPath, [bin, '--profile', 'selftest', '只回答一个词：ok'], { env, allowFail: true })
    const out = `${res.stdout || ''}${res.stderr || ''}`
    if (out.includes('Hello from WorkBuddy bridge.')) {
      console.log(`  ${c.ok('✓')} agent 回复来自 bridge: ${c.dim(out.trim().split('\n').pop())}`)
      console.log(`\n${c.ok('通过')}：DSH agent loop → llm-pi-ai(workbuddy) → bridge → SSE 全链路可用\n`)
    } else {
      console.log(`  ${c.bad('✗')} 未收到 bridge 输出，原始输出：\n${out.slice(0, 1200)}`)
      process.exitCode = 1
    }
  } finally {
    bridge.kill()
  }
}

main().catch((err) => {
  console.error(c.bad(`\n自测失败: ${err.message}`))
  process.exit(1)
})
