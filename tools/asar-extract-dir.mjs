import fs from 'node:fs'
import path from 'node:path'
const [file, inner, outDir] = process.argv.slice(2)
const fd = fs.openSync(file, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const baseOffset = 8 + head.readUInt32LE(4)
const jsonLen = head.readUInt32LE(12)
const buf = Buffer.alloc(jsonLen)
fs.readSync(fd, buf, 0, jsonLen, 16)
const header = JSON.parse(buf.toString('utf8'))
function find(node, parts) {
  if (!parts.length) return node
  const next = node.files?.[parts[0]]
  return next ? find(next, parts.slice(1)) : null
}
const root = find(header, inner.split('/').filter(Boolean))
if (!root?.files) { console.error('not a dir'); process.exit(1) }
let n = 0
function walk(node, rel) {
  for (const [k, v] of Object.entries(node.files || {})) {
    const p = path.join(rel, k)
    if (v.files) walk(v, p)
    else if (!v.unpacked) {
      const target = path.join(outDir, rel, k)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const b = Buffer.alloc(v.size)
      fs.readSync(fd, b, 0, v.size, baseOffset + Number(v.offset))
      fs.writeFileSync(target, b)
      n++
    }
  }
}
walk(root, '')
console.log('extracted', n, 'files to', outDir)
