#!/usr/bin/env node
// src/core/ が ui/ net/ data/ や外部パッケージを import していないことを機械的に保証する。
// src/engine/（ルールエンジン・DESIGN.md §5.4）も同じ扱い。ただし engine は core を import してよい。
//
// DESIGN.md §3:「core/ が ui/ や net/ を import することは禁止。これだけ守れば移植性は保たれる。」
// レビュー観点として書くだけでは必ず破られるので、npm run build の最初に走らせる。
// ESLint を入れていないため、依存ゼロの自前チェッカにしてある。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CORE = path.join(ROOT, 'src', 'core')
const ENGINE = path.join(ROOT, 'src', 'engine')

/** 層ごとに import してよいフォルダ */
const LAYERS = [
  { name: 'core', dir: CORE, allowed: [CORE] },
  { name: 'engine', dir: ENGINE, allowed: [CORE, ENGINE] },
]

/** `from '...'` と副作用 import `import '...'` の両方を拾う */
const SPECIFIER_RE = /(?:\bfrom\s*|(?:^|[;\n])\s*(?:import|export)\s*)['"]([^'"]+)['"]/g

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p)
  }
  return out
}

if (!fs.existsSync(CORE)) {
  console.error('src/core/ が見つかりません')
  process.exit(1)
}

const violations = []

for (const layer of LAYERS) {
if (!fs.existsSync(layer.dir)) continue
for (const file of walk(layer.dir)) {
  const src = fs.readFileSync(file, 'utf8')
  for (const m of src.matchAll(SPECIFIER_RE)) {
    const spec = m[1]
    const rel = path.relative(ROOT, file).replaceAll('\\', '/')

    if (!spec.startsWith('.')) {
      // 'react' 'dexie' 'fflate' … 外部パッケージはすべて禁止（node 標準も含む）
      violations.push(`${rel}: 外部パッケージ '${spec}' を import しています`)
      continue
    }
    const resolved = path.resolve(path.dirname(file), spec)
    const ok = layer.allowed.some((d) => resolved.startsWith(d + path.sep) || resolved === d)
    if (!ok) {
      violations.push(`${rel}: ${layer.name}/ から許されていない '${spec}' を import しています`)
    }
  }
}
}

if (violations.length > 0) {
  console.error('❌ core/・engine/ の分離が壊れています（DESIGN.md §3・§5.4）:')
  for (const v of violations) console.error('   ' + v)
  console.error('\n   core/ は純TypeScript。React・DOM・通信・Dexie に依存させないでください。')
  process.exit(1)
}

console.log('✅ core/・engine/ の分離OK（ui/ net/ data/ と外部パッケージへの import なし。engine→core は可）')
