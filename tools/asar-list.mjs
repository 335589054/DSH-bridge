import fs from 'node:fs'
const file = process.argv[2]
const filter = process.argv[3] || ''
const fd = fs.openSync(file, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
// asar: [u32 size_of_size_pickle][u32 header_size][u32 header_object_size][u32 json_len]
const jsonLen = head.readUInt32LE(12)
const buf = Buffer.alloc(jsonLen)
fs.readSync(fd, buf, 0, jsonLen, 16)
const header = JSON.parse(buf.toString('utf8'))
const out = []
function walk(node, prefix) {
  for (const [k, v] of Object.entries(node.files || {})) {
    const p = prefix + '/' + k
    if (v.files) walk(v, p)
    else out.push(p + (v.unpacked ? ' [unpacked]' : '') + ' ' + (v.size ?? ''))
  }
}
walk(header, '')
console.log('total files:', out.length)
const re = filter ? new RegExp(filter) : null
for (const p of out) if (!re || re.test(p)) console.log(p)
