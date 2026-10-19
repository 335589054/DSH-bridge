import fs from 'node:fs'
const [file, filter] = process.argv.slice(2)
const fd = fs.openSync(file, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const jsonLen = head.readUInt32LE(12)
const buf = Buffer.alloc(jsonLen)
fs.readSync(fd, buf, 0, jsonLen, 16)
const header = JSON.parse(buf.toString('utf8'))
const re = new RegExp(filter)
let total = 0, count = 0
function walk(node, prefix) {
  for (const [k, v] of Object.entries(node.files || {})) {
    const p = prefix + '/' + k
    if (v.files) walk(v, p)
    else if (re.test(p)) { total += v.size || 0; count++ }
  }
}
walk(header, '')
console.log(count, 'files', (total / 1024 / 1024).toFixed(1), 'MB')
