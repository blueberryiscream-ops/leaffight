// FAQ テストの実行器 — DESIGN.md §5.4「FAQ テストの形式」・PHASE-R1 §3-4
//
// ケース本体（FAQ の逐語・カードの読み合わせ）は非公開側 _local/rules/faq/*.ts にある。
// ここは公開側の実行器で、ケースの「形」を機械で確かめて数えるだけ（エンジンはまだ無い＝T は全部「保留」）。
//   1. quote.q / quote.a が oldfaq.txt の faq の行範囲に逐語で含まれる（空白の違いだけ無視）
//   2. cards[].id（inPool: true）が pool.json にある（dist-data/leaffight-data.zip から読む）
//   3. setup・steps・expect の中の ref がすべて setup で定義されている
//   4. grade T なら setup・steps・expect がそろう／N・outOfPool なら whyNot がある
//   5. holes の ID が src/engine/holes.ts にある
//   6. 窓の指定（at）が原典の宣言の機会の段か（R2a）
// 実行（R2a §3-3）: grade T のケースを setup → steps → drive → expect でエンジンに通す（scripts/lib/faq-run.ts）。
//   ✅ 通った／❌ 期待と違う／保留（理由つき）。R2a・R2b・R3 の対象（_local/rules/faq/_r2a-scope.json・_r2b-scope.json・_r3-scope.json）の ❌ は終了コード1。
//   対象の外のケースも実行して記録するが、❌ は「参考」として保留に数える（R2b 以降の手順・記述の無いカードが多いため）。
// _local/rules/faq が無い環境（公開リポジトリだけ）では 0件・スキップで成功する。

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { unzipSync, strFromU8 } from 'fflate'
import type { FaqCase, Step, Expect, CardSpec, BoardSpec } from '../src/engine/faqCase'
import { HOLES } from '../src/engine/holes'
import type { CardDef } from '../src/engine/dsl'
import type { CardInfo, EngineCtx } from '../src/engine/ctx'
import { parseCostText } from '../src/engine/cost'
import { cardInfoOf, runCase, type CaseResult } from './lib/faq-run'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const faqDir = join(root, '_local', 'rules', 'faq')
const faqTxt = join(root, '_local', 'oldfaq.txt')
const zipPath = join(root, 'dist-data', 'leaffight-data.zip')

if (!existsSync(faqDir)) {
  console.log('FAQ ケース: 0件（_local/rules が無いのでスキップ）')
  process.exit(0)
}

let failures = 0
const fail = (id: string, msg: string) => { failures++; console.error(`❌ ${id}: ${msg}`) }

// ── 材料
const faqLines = existsSync(faqTxt) ? readFileSync(faqTxt, 'utf8').replace(/^﻿/, '').split(/\r\n|\n|\r/) : null
if (!faqLines) console.warn('⚠ _local/oldfaq.txt が無いので確かめ1を飛ばす')
let poolIds: Set<string> | null = null
/** 本文ケース（faq: 'pool.json:<id>'）の逐語を確かめる材料: カード id → 能力の本文 */
const poolTexts = new Map<string, string[]>()
const cardInfos: Record<string, CardInfo> = {}
if (existsSync(zipPath)) {
  const files = unzipSync(readFileSync(zipPath), { filter: (f) => f.name === 'pool.json' })
  const pool = JSON.parse(strFromU8(files['pool.json'])) as Parameters<typeof cardInfoOf>[0][]
  poolIds = new Set(pool.map((c) => c.id))
  for (const p of pool as unknown as { id: string; abilities?: { text: string }[] }[]) poolTexts.set(p.id, (p.abilities ?? []).map((a) => a.text))
  for (const p of pool) cardInfos[p.id] = cardInfoOf(p)
} else console.warn('⚠ dist-data/leaffight-data.zip が無いので確かめ2と実行を飛ばす')

// ── ケースを読む
const files = readdirSync(faqDir).filter((f) => f.endsWith('.ts')).sort()
const cases: (FaqCase & { file: string })[] = []
for (const f of files) {
  const mod = (await import(pathToFileURL(join(faqDir, f)).href)) as { cases?: FaqCase[] }
  if (!Array.isArray(mod.cases)) { fail(f, 'export const cases が無い'); continue }
  for (const c of mod.cases) cases.push({ ...c, file: f })
}

/** 原典の「アクション宣言の機会」がある段（15-13-1・16-1・15-4-2・15-5-1・17-3・18-2・19-2・20-4・10-4・10-7）。phase の空配列＝段の確かめをしない */
const WINDOW_STEPS: Record<string, number[]> = {
  ability: [8, 11, 13], event: [8, 11, 13], costGen: [3], damage: [1, 3, 4, 5], down: [2, 4],
  item: [8, 13], field: [8, 13], battleCard: [8, 12],
  battle: [2, 4, 6, 8, 10, 13, 15, 17, 19, 20, 22, 25, 27, 29], phase: [],
}
/** 期待の at（その段以降で最初に止まった点）: 手順の段の範囲（R2b） */
const LAST_STEPS: Record<string, number> = { ability: 14, event: 14, damage: 6, down: 7, item: 13, field: 13, battleCard: 12, battle: 29, phase: 5 }

const squash = (s: string) => s.replace(/\s+/g, '')
const isRef = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(s) && s !== 'you' && s !== 'opponent'

function setupRefs(b: BoardSpec): Set<string> {
  const refs = new Set<string>()
  const add = (cs?: CardSpec) => { if (!cs) return; refs.add(cs.ref); cs.equips?.forEach(add) }
  for (const side of [b.you, b.opponent]) {
    add(side.leader); side.field?.forEach(add); add(side.fieldCard); side.battleCards?.forEach(add)
    side.hand?.forEach(add); side.trash?.forEach(add); side.deckTop?.forEach(add)
    // R4b-3a-2: costs に ref を振ったコストトークンも choose で名指しできる（交渉売買・amount chosen）
    for (const c of side.costs ?? []) if (c.ref) refs.add(c.ref)
  }
  return refs
}
/** Op の中の { ref: 'slot', slot } を拾う（force はケースの ref を slot で指す） */
function slotRefs(x: unknown, out: string[]) {
  if (Array.isArray(x)) { x.forEach((y) => slotRefs(y, out)); return }
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>
    if (o.ref === 'slot' && typeof o.slot === 'string') out.push(o.slot)
    for (const v of Object.values(o)) slotRefs(v, out)
  }
}
function usedRefs(c: FaqCase): string[] {
  const out: string[] = []
  const b = c.setup
  if (b?.battle) { if (b.battle.battleCard) out.push(b.battle.battleCard); for (const v of Object.values(b.battle.participants ?? {})) out.push(...(v ?? [])) }
  for (const s of (c.steps ?? []) as Step[]) {
    if ('declare' in s) { out.push(s.declare.source); out.push(...(s.declare.targets ?? [])); out.push(...(s.declare.payWith ?? [])) }
    else if ('generateCost' in s) out.push(s.generateCost.source)
    else if ('choose' in s) { const p = s.choose.pick; for (const x of Array.isArray(p) ? p : [p]) if (isRef(x)) out.push(x) }
    else if ('challenge' in s) { out.push(s.challenge.participant); if (s.challenge.battleCard) out.push(s.challenge.battleCard) }
    else if ('force' in s) slotRefs(s.force, out)
  }
  for (const e of (c.expect ?? []) as Expect[]) {
    if ('kiryoku' in e) out.push(e.kiryoku[0])
    else if ('zone' in e) out.push(e.zone[0])
    else if ('ready' in e) out.push(e.ready[0])
    else if ('stat' in e) out.push(e.stat[0])
    else if ('order' in e) out.push(...e.order.filter(isRef))
    else if ('battleCard' in e) out.push(e.battleCard)
  }
  return out.filter((r) => r !== 'you' && r !== 'opponent')
}

// ── 確かめる
const ids = new Set<string>()
for (const c of cases) {
  const id = `${c.file}:${c.id}`
  if (ids.has(c.id)) fail(id, 'id が重複')
  ids.add(c.id)
  // 1. 逐語
  const m = /^oldfaq\.txt:(\d+)-(\d+)$/.exec(c.faq)
  const mt = /^pool\.json:(.+)$/.exec(c.faq)
  if (mt) {
    // 本文ケース（R4c・id は text-<カードid>-<n>）: quote.a がそのカードの能力の本文と一致する
    if (!/^text-/.test(c.id)) fail(id, 'pool.json: の faq は text- のケースだけ')
    const texts = poolTexts.get(mt[1])
    if (poolIds && !texts) fail(id, `本文ケースのカードが pool.json に無い: ${mt[1]}`)
    else if (texts && !texts.some((t) => squash(t) === squash(c.quote?.a ?? ''))) fail(id, 'quote.a が pool.json のカードの能力の本文と一致しない')
  } else if (!m) fail(id, `faq の形が違う: ${c.faq}`)
  else if (faqLines) {
    const span = squash(faqLines.slice(Number(m[1]) - 1, Number(m[2])).join(''))
    if (!c.quote?.q || !span.includes(squash(c.quote.q))) fail(id, 'quote.q が原文の行範囲に逐語で無い')
    if (!c.quote?.a || !span.includes(squash(c.quote.a))) fail(id, 'quote.a が原文の行範囲に逐語で無い')
  }
  // 2. カード
  for (const cd of c.cards ?? []) {
    if (cd.inPool && poolIds && !poolIds.has(cd.id)) fail(id, `cards の id が pool.json に無い: ${cd.id}`)
    if (!cd.gist) fail(id, `cards の要点（gist）が空: ${cd.name}`)
  }
  if (!c.reading) fail(id, 'reading が無い')
  // 3. ref
  if (c.setup) {
    const defined = setupRefs(c.setup)
    for (const r of usedRefs(c)) if (!defined.has(r)) fail(id, `ref が setup に無い: ${r}`)
    const cardIds: string[] = []
    const collect = (cs?: CardSpec) => { if (!cs) return; cardIds.push(cs.card); cs.equips?.forEach(collect) }
    for (const side of [c.setup.you, c.setup.opponent]) {
      collect(side.leader); side.field?.forEach(collect); collect(side.fieldCard); side.battleCards?.forEach(collect)
      side.hand?.forEach(collect); side.trash?.forEach(collect); side.deckTop?.forEach(collect)
    }
    if (poolIds) for (const cid of cardIds) if (!poolIds.has(cid)) fail(id, `setup のカードが pool.json に無い: ${cid}`)
  } else if (c.steps || c.expect) fail(id, 'setup が無いのに steps/expect がある')
  const nSteps = c.steps?.length ?? 0
  for (const e of (c.expect ?? []) as Expect[]) {
    const step = 'illegal' in e ? e.illegal.step : 'legal' in e ? e.legal.step : 'fizzled' in e ? e.fizzled.step : null
    if (step !== null && (step < 0 || step >= nSteps)) fail(id, `expect の step 番号が範囲外: ${step}`)
  }
  // 3'. 窓の指定（WindowRef）: 手順と段番号が原典の「アクション宣言の機会」の段か（R2a で足した形）
  for (const [i, s] of ((c.steps ?? []) as Step[]).entries()) {
    const at = 'declare' in s ? s.declare.at : 'generateCost' in s ? s.generateCost.at : 'pass' in s && typeof s.pass === 'object' ? s.pass.at : undefined
    if (!at) continue
    const ok = WINDOW_STEPS[at.proc]
    if (!ok) fail(id, `steps[${i}] の at.proc が不明: ${at.proc}`)
    else if (ok.length && !ok.includes(at.step)) fail(id, `steps[${i}] の at が宣言の機会の段でない: ${at.proc}[${at.step}]`)
  }
  for (const e of (c.expect ?? []) as Expect[]) {
    if (e.at && !(e.at.proc in LAST_STEPS && e.at.step >= 1 && e.at.step <= LAST_STEPS[e.at.proc])) fail(id, `expect の at が手順の段でない: ${e.at.proc}[${e.at.step}]`)
    if ('fizzled' in e) { const s = c.steps?.[e.fizzled.step]; if (s && !('declare' in s)) fail(id, `fizzled の step が宣言でない: ${e.fizzled.step}`) }
  }
  // 4. grade
  if (c.grade === 'T' && !(c.setup && c.steps?.length && c.expect?.length)) fail(id, 'T なのに setup・steps・expect がそろっていない')
  if ((c.grade === 'N' || c.grade === 'outOfPool') && !c.whyNot) fail(id, `${c.grade} なのに whyNot が無い`)
  if (c.grade === 'T?' && !c.concepts?.length) fail(id, 'T? なのに concepts が無い')
  // 5. 穴
  for (const h of c.holes ?? []) if (!(h in HOLES)) fail(id, `holes の ID が holes.ts に無い: ${h}`)
}

// ── 数える
const tally = (xs: string[]) => Object.fromEntries(Object.entries(xs.reduce<Record<string, number>>((a, x) => { a[x] = (a[x] ?? 0) + 1; return a }, {})).sort((a, b) => b[1] - a[1]))
const grade = tally(cases.map((c) => c.grade))
const concepts = tally(cases.flatMap((c) => c.concepts ?? []))
const holes = tally(cases.flatMap((c) => c.holes ?? []))
const notes = cases.flatMap((c) => ((c.expect ?? []) as Expect[]).filter((e) => 'note' in e).map(() => c.id))
const pending = cases.filter((c) => c.grade === 'T').map((c) => c.id) // エンジン未実装（R2 から）
const report = {
  generatedBy: 'scripts/test-faq.ts',
  cases: cases.length,
  files: files.length,
  grade, concepts, holes,
  noteCount: notes.length, noteCases: [...new Set(notes)],
  pendingEngine: pending.length,
  failures,
  ids: cases.map((c) => c.id),
  byGrade: Object.fromEntries(Object.keys(grade).map((g) => [g, cases.filter((c) => c.grade === g).map((c) => c.id)])),
}
writeFileSync(join(faqDir, '_r1-report.json'), JSON.stringify(report, null, 1) + '\n')

console.log(`FAQ ケース: ${cases.length}件（${files.length}ファイル）`)
console.log(`  grade: ${JSON.stringify(grade)}`)
console.log(`  concepts: ${JSON.stringify(concepts)}`)
console.log(`  holes: ${JSON.stringify(holes)}`)
console.log(`  note: ${notes.length}件`)
console.log(`  保留（エンジン未実装）: ${pending.length}件`)
if (failures) { console.error(`❌ 確かめ1〜6 の失敗: ${failures}件`); process.exit(1) }
console.log('✅ 確かめ1〜6: 失敗 0件')

// ── 実行（R2a §3-3）
const cardsDir = join(root, '_local', 'rules', 'cards')
const defs: Record<string, CardDef> = {}
const defProblems: string[] = []
if (existsSync(cardsDir)) {
  for (const f of readdirSync(cardsDir).filter((f) => f.endsWith('.ts') && !f.startsWith('_')).sort()) {
    const mod = (await import(pathToFileURL(join(cardsDir, f)).href)) as { def?: CardDef }
    if (!mod.def) { defProblems.push(`${f}: export const def が無い`); continue }
    defs[mod.def.id] = mod.def
    // 記述の使用代償が、pool.json の元表記の読み取り（エンジンが実際に使う方）と一致するか
    const info = cardInfos[mod.def.id]
    if (!info) { defProblems.push(`${f}: pool.json に無い`); continue }
    for (const ab of mod.def.abilities) {
      if (ab.kind !== 'activated') continue
      const printed = info.abilities.find((a) => a.header === ab.name)
      // 17-7-1 アクションアイテム（見出しも使用代償の表記も無い）: 使用代償が「このアイテムをゴミ箱送りにする」だけのアイテムの起動型は印刷との突き合わせの対象外
      const o = ab.cost.other
      if (!printed && info.kind === 'i' && ab.cost.icons.length === 0 && o?.length === 1 && 'trash' in o[0]) continue
      // 《病気》のように使用代償が [W] だけ（解除。FAQ:625。R4c G11a-2）も同じ（印刷に見出しが無い）
      if (!printed && info.kind === 'i' && ab.cost.icons.length > 0 && ab.cost.icons.every((i) => i === 'W') && !o?.length) continue
      if (!printed) { defProblems.push(`${f}: 能力「${ab.name}」が pool.json に無い`); continue }
      const { cost, unknown } = parseCostText(printed.cost)
      if (unknown.length || JSON.stringify(cost) !== JSON.stringify(ab.cost)) defProblems.push(`${f}: 「${ab.name}」の cost が元表記「${printed.cost}」の読み取りと違う`)
    }
  }
}
for (const p of defProblems) console.error(`❌ 記述: ${p}`)

const readScope = (name: string) => {
  const p = join(faqDir, name)
  return new Set<string>(existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { ids: string[] }).ids : [])
}
const scopeA = readScope('_r2a-scope.json')
const scopeB = readScope('_r2b-scope.json')
const scopeC = readScope('_r3-scope.json')
// R4a（_r4a-scope.json）: PHASE-R4a-2 §3-11 で正式 gate に組み込んだ（対象30件が✅・❌0になったため）
const scopeD = readScope('_r4a-scope.json')
// R4b（_r4b-scope.json）: R4b-3b-1 から束ごとに足す（PHASE-R4b §2(E)）。対象の ❌ は終了コード1
const scopeE = readScope('_r4b-scope.json')
// R4c（_r4c-scope.json）: 束ごとに足す（PHASE-R4c）。本文ケース（text-*）を含む。対象の ❌ は終了コード1
const scopeF = readScope('_r4c-scope.json')
const scope = new Set<string>([...scopeA, ...scopeB, ...scopeC, ...scopeD, ...scopeE, ...scopeF])
if (Object.keys(cardInfos).length) {
  const ctx: EngineCtx = { cards: cardInfos, defs, shuffle: (xs) => xs }
  const results: (CaseResult & { inScope: boolean })[] = []
  for (const c of cases.filter((c) => c.grade === 'T')) {
    const r = runCase(c, ctx)
    const inScope = scope.has(c.id)
    if (!inScope && r.verdict === '❌') {
      r.verdict = '保留'
      r.reasons.unshift('対象外（R2a・R2b・R3 の外）の参考実行で期待と違った')
    }
    results.push({ ...r, inScope })
  }
  const count = (xs: typeof results) => ({ total: xs.length, ok: xs.filter((r) => r.verdict === '✅').length, hold: xs.filter((r) => r.verdict === '保留').length, ng: xs.filter((r) => r.verdict === '❌').length })
  // R2a・R2b の対象ごとに結果のファイルを書く（inScope はそのフェイズの対象か）
  let ng = 0
  for (const [name, sc] of [['R2a', scopeA], ['R2b', scopeB], ['R3', scopeC], ['R4a', scopeD], ['R4b', scopeE], ['R4c', scopeF]] as const) {
    const rs = results.map((r) => ({ ...r, inScope: sc.has(r.id) }))
    const inS = rs.filter((r) => r.inScope)
    const missing = [...sc].filter((id) => !rs.some((r) => r.id === id))
    const summary = { scope: count(inS), outOfScope: count(rs.filter((r) => !r.inScope)), scopeMissing: missing, okWithManual: inS.filter((r) => r.verdict === '✅' && r.manual.length).map((r) => r.id) }
    writeFileSync(join(faqDir, `_${name.toLowerCase()}-result.json`), JSON.stringify({ generatedBy: 'scripts/test-faq.ts', summary, results: rs }, null, 1) + String.fromCharCode(10))
    console.log(`実行（${name} の対象 ${sc.size}件）: ✅ ${summary.scope.ok}／保留 ${summary.scope.hold}／❌ ${summary.scope.ng}${missing.length ? `／見つからない ${missing.length}` : ''}（✅ のうち manual を含む ${summary.okWithManual.length}）`)
    for (const r of inS.filter((r) => r.verdict !== '✅')) console.log(`  ${r.verdict} ${r.id}: ${[...r.reasons, ...r.failures].join(' / ')}`)
    ng += summary.scope.ng + missing.length
  }
  const out = results.filter((r) => !r.inScope)
  console.log(`実行（対象の外・参考 ${out.length}件）: ✅ ${out.filter((r) => r.verdict === '✅').length}／保留 ${out.filter((r) => r.verdict === '保留').length}`)
  // tested の数（D25(c)・_local/rules/tools/tested.ts の判定を読む。_r*-result.json を書いた後に呼ぶ）
  const testedToolPath = join(root, '_local', 'rules', 'tools', 'tested.ts')
  if (existsSync(testedToolPath)) {
    const { computeTested } = (await import(pathToFileURL(testedToolPath).href)) as { computeTested: (root: string) => Promise<{ counts: { tested: number; draft: number; manual: number }; missingReviewCount: number }> }
    const { counts, missingReviewCount } = await computeTested(root)
    console.log(`tested の数: tested ${counts.tested}／draft ${counts.draft}／manual ${counts.manual}（faqReview が足りなくて tested になれなかった枚数: ${missingReviewCount}）`)
  }
  if (ng || defProblems.length) process.exit(1)
} else console.log('実行: pool.json が無いのでスキップ')
