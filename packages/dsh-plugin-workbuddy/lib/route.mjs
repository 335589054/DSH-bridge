/**
 * 路由配置渲染
 *
 * DSH 的 llm-pi-ai 适配器本身就支持「手写网关」：一条 route 只要声明
 * api / baseURL / models，就能把请求发到任何 OpenAI Chat Completions 端点，
 * 并且 apiKeyEnv 会经 harness 的凭证服务按请求解析。
 *
 * 所以插件不需要自己实现 LlmAdapter，只需要生成这一块 patch。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = join(__dirname, '..')

export const BLOCK_START = '# >>> dsh-plugin-workbuddy (managed) >>>'
export const BLOCK_END = '# <<< dsh-plugin-workbuddy (managed) <<<'
export const DEFAULT_TOKEN_REF = 'WORKBUDDY_BRIDGE_TOKEN'
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8790/v1'
export const PROVIDER_KEY = 'workbuddy'

/** YAML 单引号标量的转义规则：内部单引号写两次 */
function q(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

export function loadModels(file = join(PACKAGE_ROOT, 'models.json')) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const list = Array.isArray(parsed) ? parsed : parsed.models
  return list.map((m) => (typeof m === 'string' ? { id: m } : m)).filter((m) => m && m.id)
}

/**
 * 渲染可追加到 cordis.patch.yml 的托管块。
 * 顶层是数组，所以直接追加 `- id:` 条目即可，不会破坏已有条目。
 */
export function renderPatchBlock({
  baseUrl = DEFAULT_BASE_URL,
  tokenRef = DEFAULT_TOKEN_REF,
  models = loadModels(),
  displayName = 'WorkBuddy',
} = {}) {
  const lines = [
    BLOCK_START,
    '# 本块由 dsh-plugin-workbuddy 生成，重装或同步模型时整块替换，请勿手改。',
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    `      ${PROVIDER_KEY}:`,
    `        displayName: ${q(displayName)}`,
    '        api: openai-completions',
    `        baseURL: ${q(baseUrl)}`,
    `        apiKeyEnv: ${q(tokenRef)}`,
    '        # 上游把思考内容放在 reasoning_content，按 deepseek 方言解析',
    '        compat:',
    '          thinkingFormat: deepseek',
    '        models:',
  ]
  for (const m of models) {
    lines.push(`          - id: ${q(m.id)}`)
    if (m.name && m.name !== m.id) lines.push(`            name: ${q(m.name)}`)
    if (m.contextWindow) lines.push(`            contextWindow: ${Number(m.contextWindow)}`)
    if (m.maxTokens) lines.push(`            maxTokens: ${Number(m.maxTokens)}`)
    if (Array.isArray(m.input) && m.input.length) lines.push(`            input: [${m.input.join(', ')}]`)
  }
  lines.push(BLOCK_END)
  return lines.join('\n') + '\n'
}

/**
 * 新 profile 的 cordis.patch.yml 用裸 `[]` 表示空数组。
 * 直接在其后追加 `- id:` 会变成「两个根节点」，YAML 解析失败，所以先摘掉。
 */
function stripEmptyRoot(content) {
  return content.replace(/^[ \t]*\[\][ \t]*(#[^\n]*)?$/m, '')
}

/** 把托管块写进一个 patch 文件内容（返回新内容） */
export function upsertBlock(content, block) {
  const start = content.indexOf(BLOCK_START)
  const end = content.indexOf(BLOCK_END)
  if (start !== -1 && end !== -1 && end > start) {
    return stripEmptyRoot(content.slice(0, start)) + block + content.slice(end + BLOCK_END.length + 1)
  }
  const trimmed = stripEmptyRoot(content).replace(/\s*$/, '\n')
  return (trimmed.trim() === '' ? '' : trimmed + '\n') + block
}

/** 移除块后如果文件里一条 entry 都不剩，补回空数组根，避免变成空文档 */
function ensureArrayRoot(content) {
  if (/^\s*-\s/m.test(content)) return content
  return content.replace(/\s*$/, '\n') + '\n[]\n'
}

export function removeBlock(content) {
  const start = content.indexOf(BLOCK_START)
  const end = content.indexOf(BLOCK_END)
  if (start === -1 || end === -1) return content
  const next = (content.slice(0, start) + content.slice(end + BLOCK_END.length)).replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
  return ensureArrayRoot(next)
}

/** 检测托管块之外是否已经有人配过 llm-pi-ai（会被本块整行覆盖） */
export function hasForeignPiAiRow(content) {
  const withoutBlock = removeBlock(content)
  return /^\s*-?\s*id:\s*['"]?llm-pi-ai['"]?\s*$/m.test(withoutBlock)
}

/** 默认模型行：让新会话直接用 WorkBuddy，卸载时还原 */
export const DEFAULT_MODEL_BLOCK_START = '# >>> dsh-plugin-workbuddy default-model (managed) >>>'
export const DEFAULT_MODEL_BLOCK_END = '# <<< dsh-plugin-workbuddy default-model (managed) <<<'

export function renderDefaultModelBlock(model = 'auto', provider = PROVIDER_KEY) {
  return [
    DEFAULT_MODEL_BLOCK_START,
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    `    provider: ${q(provider)}`,
    `    model: ${q(model)}`,
    DEFAULT_MODEL_BLOCK_END,
  ].join('\n') + '\n'
}

export function upsertDefaultModelBlock(content, model) {
  const start = content.indexOf(DEFAULT_MODEL_BLOCK_START)
  const end = content.indexOf(DEFAULT_MODEL_BLOCK_END)
  const block = renderDefaultModelBlock(model)
  if (start !== -1 && end !== -1) return content.slice(0, start) + block + content.slice(end + DEFAULT_MODEL_BLOCK_END.length + 1)
  const trimmed = stripEmptyRoot(content).replace(/\s*$/, '\n')
  return (trimmed.trim() === '' ? '' : trimmed + '\n') + '\n' + block
}

export function removeDefaultModelBlock(content) {
  const start = content.indexOf(DEFAULT_MODEL_BLOCK_START)
  const end = content.indexOf(DEFAULT_MODEL_BLOCK_END)
  if (start === -1 || end === -1) return content
  const next = (content.slice(0, start) + content.slice(end + DEFAULT_MODEL_BLOCK_END.length)).replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
  return ensureArrayRoot(next)
}

/**
 * 本包自己的 cordis.patch.yml。
 *
 * 比用户补丁多一行 insert：给 UI 半体一个可寻址的行（Client 模块按 package 名加载）。
 * 路由部分与用户补丁完全一致。
 */
export function renderBundlePatch({ models = loadModels(), baseUrl = DEFAULT_BASE_URL } = {}) {
  const header = [
    '# 本文件由 sync-models.mjs 生成，请勿手改。',
    '# 第一行给 UI 半体挂一个可寻址的行；后面是 llm-pi-ai 的 workbuddy 路由。',
    '- insert:',
    '    - id: workbuddy-ui',
    `      name: 'dsh-plugin-workbuddy'`,
    '',
  ].join('\n')
  return header + renderPatchBlock({ models, baseUrl })
}
