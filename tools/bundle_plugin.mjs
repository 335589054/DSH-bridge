#!/usr/bin/env node
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = join(ROOT, 'packages', 'dsh-plugin-workbuddy')
const SRC_BRIDGE = join(ROOT, 'packages', 'bridge')
const SRC_CAPTURE = join(ROOT, 'packages', 'capture')
const DST_BRIDGE = join(PKG, 'bridge')

const SKIP_NAMES = new Set([
  '.bridge-token', '.capture-key', '.session.json', '.proxy-backup.json',
  '.launch-state.json', '.bridge-config.json', '.DS_Store',
])
const SKIP_DIRS = new Set(['node_modules', '.tools', '.ca', '__pycache__', '.git', 'dist', 'tests'])
const SKIP_SUFFIX = ['.log', '.pyc']

function shouldSkipFile(name) {
  if (SKIP_NAMES.has(name)) return true
  if (SKIP_SUFFIX.some((s) => name.endsWith(s))) return true
  if (name.includes('.workbuddy-backup-')) return true
  return false
}

function sweep(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) rmSync(full, { recursive: true, force: true })
      else sweep(full)
    } else if (shouldSkipFile(name)) {
      rmSync(full, { force: true })
    }
  }
}

/** cpSync 的过滤：目录返回 false 就整棵子树跳过，不复制再删（.tools 里有一整个 venv） */
function keep(src) {
  const name = src.split(/[\\/]/).pop()
  if (SKIP_DIRS.has(name)) return false
  if (shouldSkipFile(name)) return false
  return true
}

const clean = process.argv.includes('--clean')
if (clean && existsSync(DST_BRIDGE)) {
  rmSync(DST_BRIDGE, { recursive: true, force: true })
  console.log('cleaned old bundled bridge')
}
cpSync(SRC_BRIDGE, DST_BRIDGE, { recursive: true, filter: keep })
cpSync(SRC_CAPTURE, join(DST_BRIDGE, 'capture'), { recursive: true, filter: keep })
sweep(DST_BRIDGE)

console.log(`synced -> ${DST_BRIDGE}`)
console.log(`  server.mjs: ${existsSync(join(DST_BRIDGE, 'server.mjs'))}`)
console.log(`  certs: ${existsSync(join(DST_BRIDGE, 'certs', 'mitmproxy-ca.pem'))}`)
console.log(`  capture addon: ${existsSync(join(DST_BRIDGE, 'capture', 'mitm_addon.py'))}`)
