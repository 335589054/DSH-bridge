import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 校验 cordis.patch.yml 能不能被解析。
 *
 * js-yaml 不随仓库走：优先用本机 DSH profile 里那份（它一定在），
 * 其次才是当前项目能不能 require 到。
 */
const require = createRequire(import.meta.url)
const candidates = [
  process.env.DSH_YAML,
  join(homedir(), '.dsh/profiles/desktop/node_modules/js-yaml'),
  join(homedir(), '.dsh/profiles/web/node_modules/js-yaml'),
  'js-yaml',
].filter(Boolean)

let yaml = null
for (const id of candidates) {
  try {
    yaml = require(id)
    break
  } catch {
    /* 换下一个 */
  }
}

if (!yaml) {
  console.error('找不到 js-yaml：设置 DSH_YAML=<js-yaml 目录> 或先装一个 DSH profile')
  process.exit(1)
}

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('用法: node tools/yamlcheck.mjs <file.yml> [...]')
  process.exit(1)
}

// js-yaml v4 叫 load，旧的自编译版本叫 parse
const parseYaml = yaml.load || yaml.parse

let bad = 0
for (const f of files) {
  try {
    const doc = parseYaml(readFileSync(f, 'utf8'), { logLevel: 'silent' })
    const kind = Array.isArray(doc) ? 'array' : 'map'
    const n = Array.isArray(doc) ? doc.length : Object.keys(doc || {}).length
    console.log('OK   ' + f + '  (' + kind + ', ' + n + ' entries)')
  } catch (e) {
    bad++
    console.log('FAIL ' + f + '  ' + String(e.message).split('\n')[0])
  }
}
process.exit(bad ? 1 : 0)
