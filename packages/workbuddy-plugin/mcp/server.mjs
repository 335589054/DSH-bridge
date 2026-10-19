#!/usr/bin/env node
/**
 * WorkBuddy 侧控制面（MCP / stdio）
 *
 * 只暴露只读诊断能力：bridge 是否在跑、会话是否已抓到、模型目录有什么。
 * 真正的模型流量走 HTTP，不经 MCP；MCP 只是让 WorkBuddy 自己也能"看见"这条链路。
 */

import readline from 'node:readline'

const BRIDGE = (process.env.WORKBUDDY_BRIDGE_URL || 'http://127.0.0.1:8790').replace(/\/$/, '')

const TOOLS = [
  {
    name: 'bridge_health',
    description: '查看本地 WorkBuddy bridge 的运行状态、上游地址、凭证模式与会话捕获情况（不返回任何令牌明文）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'capture_status',
    description: '查看本机会话捕获状态：是否已抓到 WorkBuddy 客户端的鉴权头、来源、过期时间。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bridge_models',
    description: '列出 bridge 当前可用的 WorkBuddy 模型 id。',
    inputSchema: { type: 'object', properties: {} },
  },
]

async function callTool(name) {
  if (name === 'bridge_health') {
    const res = await fetch(`${BRIDGE}/health`)
    return await res.json()
  }
  if (name === 'capture_status') {
    const res = await fetch(`${BRIDGE}/capture/status`)
    return await res.json()
  }
  if (name === 'bridge_models') {
    const token = process.env.WORKBUDDY_LOCAL_TOKEN || ''
    const res = await fetch(`${BRIDGE}/v1/models`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) throw new Error(`bridge 返回 ${res.status}`)
    const body = await res.json()
    return { models: (body.data || []).map((m) => m.id) }
  }
  throw new Error(`未知工具: ${name}`)
}

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

const rl = readline.createInterface({ input: process.stdin })

rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }

  if (msg.method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'workbuddy-bridge', version: '0.2.0' },
      },
    })
  }
  if (msg.method === 'tools/list') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
  }
  if (msg.method === 'tools/call') {
    try {
      const result = await callTool(msg.params?.name)
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      })
    } catch (err) {
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { isError: true, content: [{ type: 'text', text: String(err.message || err) }] },
      })
    }
  }
  if (msg.id != null) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
  }
})
