#!/usr/bin/env node
/**
 * SessionStart 钩子：bridge 不在就跑起来。
 * 只做健康探测与后台拉起，不阻塞会话，不读任何凭证。
 */

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BRIDGE_URL = (process.env.WORKBUDDY_BRIDGE_URL || 'http://127.0.0.1:8790').replace(/\/$/, '')
const ENTRY = process.env.WORKBUDDY_BRIDGE_ENTRY || resolve(__dirname, '../../../bridge/server.mjs')

try {
  const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(800) })
  if (res.ok) process.exit(0)
} catch {
  /* 没起，继续 */
}

const child = spawn(process.execPath, [ENTRY], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
  env: process.env,
})
child.unref()
process.exit(0)
