#!/usr/bin/env node
// src/core/ が ui/ net/ data/ や外部パッケージを import していないことを機械的に保証する。
//
// DESIGN.md §3:「core/ が ui/ や net/ を import することは禁止。これだけ守れば移植性は保たれる。」
// レビュー観点として書くだけでは必ず破られるので、npm run build の最初に走らせる。
// ESLint を入れていないため、依存ゼロの自前チェッカにしてある。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CORE = path.join(ROOT, 'src', 'core')

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

for (const file of walk(CORE)) {
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
    if (!resolved.startsWith(CORE + path.sep) && resolved !== CORE) {
      violations.push(`${rel}: core/ の外 '${spec}' を import しています`)
    }
  }
}

if (violations.length > 0) {
  console.error('❌ core/ の分離が壊れています（DESIGN.md §3）:')
  for (const v of violations) console.error('   ' + v)
  console.error('\n   core/ は純TypeScript。React・DOM・通信・Dexie に依存させないでください。')
  process.exit(1)
}

console.log('✅ core/ の分離OK（ui/ net/ data/ と外部パッケージへの import なし）')
