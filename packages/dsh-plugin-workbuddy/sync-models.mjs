#!/usr/bin/env node
/**
 * 从 bridge 拉取真实模型目录，重写 models.json、本包的 cordis.patch.yml，
 * 以及（若已安装）profile 里的托管块。
 *
 *   node sync-models.mjs            # 走网络：GET http://127.0.0.1:8790/v1/models
 *   node sync-models.mjs --offline  # 不联网，只用现有 models.json 重渲染
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_BASE_URL,
  PACKAGE_ROOT,
  loadModels,
  renderBundlePatch,
  renderPatchBlock,
  upsertBlock,
} from './lib/route.mjs'

const argv = process.argv.slice(2)
const OFFLINE = argv.includes('--offline')
const PROFILE = argv.includes('--profile') ? argv[argv.indexOf('--profile') + 1] : 'desktop'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PATCH_FILE = join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')
const MODELS_FILE = join(PACKAGE_ROOT, 'models.json')
const BUNDLE_PATCH = join(PACKAGE_ROOT, 'cordis.patch.yml')
const BRIDGE_DIR = existsSync(join(PACKAGE_ROOT, 'bridge', 'server.mjs'))
  ? join(PACKAGE_ROOT, 'bridge')
  : join(PACKAGE_ROOT, '..', 'bridge')

function readToken() {
  const file = join(BRIDGE_DIR, '.bridge-token')
  if (process.env.WORKBUDDY_LOCAL_TOKEN) return process.env.WORKBUDDY_LOCAL_TOKEN
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
}

/** 上游目录里常见的字段名不统一，这里做一次归一化 */
function normalize(raw) {
  const id = raw.id || raw.model || raw.name
  if (!id) return null
  const model = { id }
  const name = raw.name || raw.displayName || raw.display_name
  if (name && name !== id) model.name = name
  const ctx = raw.context_window || raw.contextWindow || raw.max_input_tokens || raw.maxContextTokens
  if (Number.isFinite(Number(ctx)) && Number(ctx) > 0) model.contextWindow = Number(ctx)
  const max = raw.max_tokens || raw.maxTokens || raw.max_output_tokens
  if (Number.isFinite(Number(max)) && Number(max) > 0) model.maxTokens = Number(max)
  if (Array.isArray(raw.input) && raw.input.length) model.input = raw.input.map(String)
  return model
}

/** 保持安装时用过的 baseURL（端口可能被 --port 改过） */
function baseUrlOf(content) {
  const m = content.match(/baseURL:\s*'([^']+)'/)
  return m ? m[1] : DEFAULT_BASE_URL
}

function writeModels(models) {
  const doc = {
    source: OFFLINE ? readDoc().source : 'bridge:/v1/models',
    capturedAt: new Date().toISOString().slice(0, 10),
    note: 'DSH 路由的模型目录；node sync-models.mjs 可从 bridge 重新抓取',
    models,
  }
  writeFileSync(MODELS_FILE, JSON.stringify(doc, null, 2) + '\n')

  // bundle 的补丁多一行：给 UI 半体挂可寻址的行
  writeFileSync(BUNDLE_PATCH, renderBundlePatch({ models }))

  if (existsSync(PATCH_FILE)) {
    const content = readFileSync(PATCH_FILE, 'utf8')
    if (content.includes('dsh-plugin-workbuddy (managed)')) {
      writeFileSync(PATCH_FILE, upsertBlock(content, renderPatchBlock({ baseUrl: baseUrlOf(content), models })))
      console.log(`已更新 profile 托管块: ${PATCH_FILE}`)
    }
  }
  console.log(`已写入 ${models.length} 个模型 -> ${MODELS_FILE}`)
}

function readDoc() {
  try {
    const parsed = JSON.parse(readFileSync(MODELS_FILE, 'utf8'))
    return Array.isArray(parsed) ? { source: 'models.json', models: parsed } : parsed
  } catch {
    return { source: 'models.json', models: [] }
  }
}

async function main() {
  let models = loadModels()
  if (!OFFLINE) {
    const token = readToken()
    if (!token) {
      console.error('缺少 bridge 令牌，先用 node ../bridge/server.mjs 启动一次，或加 --offline')
      process.exit(1)
    }
    const res = await fetch(`${DEFAULT_BASE_URL}/models`, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) {
      console.error(`GET /v1/models 失败: HTTP ${res.status}`)
      process.exit(1)
    }
    const payload = await res.json()
    const list = (payload.data || payload.models || []).map(normalize).filter(Boolean)
    if (!list.length) {
      console.error('上游返回了空目录，保留原 models.json')
      process.exit(1)
    }
    models = list
  }
  writeModels(models)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
