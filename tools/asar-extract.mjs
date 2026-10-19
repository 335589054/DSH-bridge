import fs from 'node:fs'
import path from 'node:path'
const [file, inner, out] = process.argv.slice(2)
const fd = fs.openSync(file, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(4)
const jsonLen = head.readUInt32LE(12)
const buf = Buffer.alloc(jsonLen)
fs.readSync(fd, buf, 0, jsonLen, 16)
const header = JSON.parse(buf.toString('utf8'))
const baseOffset = 8 + headerSize
function find(node, parts) {
  if (!parts.length) return node
  const next = node.files?.[parts[0]]
  if (!next) return null
  return find(next, parts.slice(1))
}
const node = find(header, inner.split('/').filter(Boolean))
if (!node) { console.error('not found'); process.exit(1) }
if (node.files) { console.error('is dir'); process.exit(1) }
const start = baseOffset + Number(node.offset)
const b = Buffer.alloc(node.size)
fs.readSync(fd, b, 0, node.size, start)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, b)
console.log('wrote', out, node.size)
