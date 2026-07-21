#!/usr/bin/env node
// leaffight-data.zip を作る。ローカルでのみ実行し、出力はコミットしない（dist-data/ は gitignore）。
//
//   npm run data:bundle
//
// 入力（すべて _local/。リポジトリには入っていない）:
//   sources/cards_v2.json      LFWIKI 由来の全4,570実体
//   cards.json                 tcg-db 由来（画像パス image を持つ）
//   card_images/{setDir}/{id}.jpg
//   sources/x_cards.csv        X @LEAFFIGHTTCG 由来（cardName, cardVer, file）
//   x_card_images/{tweetId}.jpg
//
// 出力: dist-data/leaffight-data.zip … pool.json / images/*.jpg / meta.json

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

// パスはスクリプト位置から導く。日本語パスを直書きしない（PHASE0 §10）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = path.join(ROOT, '_local')
const OUT_DIR = path.join(ROOT, 'dist-data')

// ---------------------------------------------------------------------------
// 標準プール = ver.1〜3（DESIGN.md §7.5.1）
//
// ★ この配列がプール定義の唯一の在処。ver.4 以降を足すときはここに追記するだけ。
//   並び順がそのまま版の新旧（左が古い）。刷りの畳み込みで「最も新しい刷り」を選ぶのに使う。
//   2.02A は wiki 上に存在するがカードが1枚も載っていない（実データ0件）。将来の追加に備えて残す。
// ---------------------------------------------------------------------------
const POOL_SETS = [
  '0.9β', '1.00', '1.01β', '1.01', '1.01A', '1.02', '1.03', '1.03A', '1.04',
  '2.00β', '2.00', '2.01', '2.02', '2.02A', '2.03', '3.00β', '3.00', '3.01',
]
const SET_ORDER = new Map(POOL_SETS.map((s, i) => [s, i]))

// β版（プロトタイプ）はプールから除外する。β版の刷りは名前・種別が OCR 誤字／語順違い／名前切れ／
// 別種別で壊れていることがあり、`kind + 正規化名` キーで本物と別カードに割れて「画像の当たらない幽霊」を生む。
// 実在カードは全て非β版に正しい形（正名・正種別・画像あり）で存在するため、β除外で幽霊が消え本物は
// 一枚も失われない。βは常に最古版なので、どの本物カードの表示内容（＝最新刷り採用）も変わらない。
// （統括の現物検証で6件全てが幽霊と確認、2026-07-18。DESIGN §7.5.1）
const BETA_SETS = new Set(['0.9β', '1.01β', '2.00β', '3.00β'])

// ---------------------------------------------------------------------------
// 名前の正規化（_local/sources/coverage.ps1 の Norm を移植）
//
// ⚠️ 突き合わせ用のキー専用。表示名は元の文字列を保持する（PHASE0 §10）。
//
// 本家 PowerShell からの意図的な差分が2つある:
//  1. 中黒を '/' ではなく「除去」する。'／'(全角) も同時に除去するので
//     「レミィ・マリィ」と「レミィ／マリィ」は本家同様に一致し、かつIDがファイル名に使える。
//  2. 長音「ー」を '-' に畳む。本家は StrConv(Narrow) が先に「ー」を半角「ｰ」へ変えてしまい、
//     直後のダッシュ統一ルールから漏れていた。この修正で ＨＭ－１３ と HMー13 が一致する（画像1枚増）。
// ---------------------------------------------------------------------------
const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
}
const htmlDecode = (s) => s.replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (m) => HTML_ENTITIES[m] ?? m)

function norm(s) {
  if (!s) return ''
  s = htmlDecode(htmlDecode(s)) // Xの本文は二重エンコード（&amp;amp;）
  s = s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角ASCII→半角（カタカナは触らない）
  s = s.replace(/　/g, ' ')
  s = s.replace(/[・‧·／/]/g, '')
  s = s.replace(/[ー－‐‑‒–—―]/g, '-')
  return s.replace(/\s+/g, '').trim()
}

// ---------------------------------------------------------------------------
// 入力の読み込み
// ---------------------------------------------------------------------------
function readJson(p) {
  // これらのファイルは PowerShell が BOM 付き UTF-8 で書いている。JSON.parse は BOM で落ちる。
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''))
}

/** 引用符・埋め込み改行に対応した最小CSVパーサ（x_cards.csv の desc 列が複数行） */
function readCsv(p) {
  const text = fs.readFileSync(p, 'utf8').replace(/^﻿/, '')
  const rows = []
  let row = [], cur = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++ } else quoted = false
      } else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cur); cur = '' }
    else if (ch === '\r') { /* skip */ }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = '' }
    else cur += ch
  }
  if (cur !== '' || row.length > 0) { row.push(cur); rows.push(row) }
  const header = rows.shift()
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])))
}

function requireFile(p, what) {
  if (!fs.existsSync(p)) {
    console.error(`入力が見つかりません: ${path.relative(ROOT, p)}（${what}）`)
    process.exit(1)
  }
  return p
}

const wikiCards = readJson(requireFile(path.join(LOCAL, 'sources', 'cards_v2.json'), 'LFWIKI パース結果'))
const tcgCards = readJson(requireFile(path.join(LOCAL, 'cards.json'), 'tcg-db（画像の対応表）'))
const xCards = readCsv(requireFile(path.join(LOCAL, 'sources', 'x_cards.csv'), 'X @LEAFFIGHTTCG の対応表'))
// 駿河屋: tcg-dbに無いカードだけを対象に、商品名でマッチ済みの対応表（scripts/../_local/sources/match_suruga.mjs が生成）
// ファイルが無い場合は空扱い（未実行でもbundle生成自体は壊さない）
const surugaMatchPath = path.join(LOCAL, 'sources', 'suruga_matched.csv')
const surugaCards = fs.existsSync(surugaMatchPath) ? readCsv(surugaMatchPath) : []

// ---------------------------------------------------------------------------
// 1. プール抽出
// ---------------------------------------------------------------------------
const pool = wikiCards.filter((c) => SET_ORDER.has(c.setVer) && !BETA_SETS.has(c.setVer))

// ---------------------------------------------------------------------------
// 既知フィールドの再抽出
//
// cards_v2.json の cost フィールドは信用できない。parse_lfwiki.ps1 が全セルを
// /^[WRGLT]+[力早賢根感]*$/ で走査するため、コストが '-' のカードでレアリティ 'R'（レア）を
// コストとして拾ってしまう（タッグはコスト欄自体が無いのに cost='R' になっている）。
// cells は原本なので、種別ごとの固定の並びから読み直す。
//
//   c: [名前(かな), 気力N, コスト, 属性, 性別, レアリティ, Ilus:, 能力値…]
//   t: [名前(かな), 気力N, 属性, 性別, レアリティ, Ilus:, 能力値…]   ← コスト欄なし
//   b: [名前(かな), 場所, コスト(属性), 攻:X 防:Y, レアリティ, Ilus:]
//   i/e/f: [名前(かな), コスト, 属性, レアリティ, Ilus:]
// ---------------------------------------------------------------------------
const blank = (v) => (v && v !== '-' ? v : '')

function extractCostAttr(kind, cells) {
  switch (kind) {
    case 'c':
      return { cost: blank(cells[2]), attr: blank(cells[3]) }
    case 't':
      return { cost: '', attr: blank(cells[2]) }
    case 'b': {
      // 'W(早)' = コストW＋属性アイコン早。'-(-)' と '(-)' はどちらもコスト無し。
      const m = /^(.*)\((.*)\)$/.exec(cells[2] ?? '')
      if (!m) return { cost: '', attr: '' }
      return { cost: blank(m[1].trim()), attr: blank(m[2].trim()) }
    }
    default: // i / e / f
      return { cost: blank(cells[1]), attr: blank(cells[2]) }
  }
}

function extractBattle(kind, cells) {
  if (kind !== 'b') return { battleAtk: '', battleDef: '' }
  const m = /攻:\s*(\S*)\s*防:\s*(\S*)/.exec(cells[3] ?? '')
  // 空欄の5実体は欠損ではなく '-' と同義（DESIGN.md §7.6）
  return { battleAtk: m?.[1] || '-', battleDef: m?.[2] || '-' }
}

// ---------------------------------------------------------------------------
// 2. 刷り → カードへの畳み込み（キー = kind + 正規化カード名）
// ---------------------------------------------------------------------------
const groups = new Map()
for (const printing of pool) {
  const id = `${printing.kind}_${norm(printing.name)}`
  const g = groups.get(id)
  if (g) g.push(printing)
  else groups.set(id, [printing])
}

const cards = []
for (const [id, printings] of groups) {
  // 版順で最も新しい刷りを採用する（後の版がエラッタ反映済みのため）
  printings.sort((a, b) => SET_ORDER.get(a.setVer) - SET_ORDER.get(b.setVer))
  const latest = printings[printings.length - 1]

  const { cost, attr } = extractCostAttr(latest.kind, latest.cells)
  const { battleAtk, battleDef } = extractBattle(latest.kind, latest.cells)

  cards.push({
    id, // `${kind}_${norm(name)}`
    kind: latest.kind,
    name: latest.name, // 表示名は元の文字列
    kana: latest.kana ?? '',
    setVer: latest.setVer,
    printings: [...new Set(printings.slice(0, -1).map((p) => p.setVer))],
    num: Number.isInteger(latest.num) ? latest.num : -1,
    kiryoku: latest.kiryoku ?? null,
    stats: latest.stats ?? null,
    cost,
    attr,
    battleAtk,
    battleDef,
    abilities: latest.abilities ?? [],
    illust: latest.illust ?? '',
    cells: latest.cells, // 生セル。絶対に落とさない
    image: null, // 次のステップで埋める
  })
}
cards.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id, 'ja'))

// ---------------------------------------------------------------------------
// 4. 画像の紐付け（第1候補 tcg-db のスキャン画像、第2候補 駿河屋の実物写真、第3候補 X の実物写真）
//
// 駿河屋はtcg-dbより解像度・撮影品質が安定して良いためXより優先する（ユーザー判断、2026-07-18）。
// suruga_matched.csv の holeId は「tcg-dbに画像が無いカードだけ」を対象に事前突合済みなので、
// ここでは card.id（= `${kind}_${norm(name)}`、holeIdと同じ形式）で引くだけでよい。
// ---------------------------------------------------------------------------
const CTYPE_TO_KIND = {
  'キャラ': 'c', 'リーダー': 'c', 'タッグキャラ': 't',
  'バトル': 'b', 'アイテム': 'i', 'イベント': 'e', 'フィールド': 'f',
}

const tcgByName = new Map()
for (const c of tcgCards) {
  const n = norm(c.name)
  if (!n) continue
  if (!tcgByName.has(n)) tcgByName.set(n, [])
  tcgByName.get(n).push(c)
}

const xByName = new Map()
for (const r of xCards) {
  const n = norm(r.cardName)
  if (!n || !r.file) continue
  if (!xByName.has(n)) xByName.set(n, [])
  xByName.get(n).push(r)
}

const surugaByHoleId = new Map()
for (const r of surugaCards) {
  if (!r.holeId || !r.surugaId) continue
  surugaByHoleId.set(r.holeId, r.surugaId)
}

/** 同名の画像が複数ある（tcg-db 73件 / X 78件）ので、決め方を固定して再現性を持たせる */
function pickTcg(candidates, kind) {
  const scored = candidates.map((c) => ({
    c,
    kindMatch: CTYPE_TO_KIND[c.ctype] === kind ? 0 : 1,
    // 'CH017_2' は ver.4以降のリーダー専用版で絵が差し替わっている。素の刷りを優先する
    variant: /_\d+$/.test(c.id) ? 1 : 0,
    poolEra: /^[123]/.test(c.setDir) ? 0 : 1,
  }))
  scored.sort(
    (a, b) =>
      a.kindMatch - b.kindMatch ||
      a.variant - b.variant ||
      a.poolEra - b.poolEra ||
      a.c.setDir.localeCompare(b.c.setDir) ||
      a.c.id.localeCompare(b.c.id),
  )
  return scored[0].c
}

function pickX(candidates) {
  const scored = candidates.map((r) => ({
    r,
    poolVer: SET_ORDER.has(r.cardVer) ? 0 : 1,
    leader: r.cardVer === 'リーダー' ? 1 : 0,
  }))
  scored.sort((a, b) => a.leader - b.leader || a.poolVer - b.poolVer || a.r.id.localeCompare(b.r.id))
  return scored[0].r
}

/** ZIP内のパス。id には '?' 等が入りうるので、ファイル名としては潰しておく */
const safePath = (id) => `images/${id.replace(/[\\/:*?"<>|]/g, '_')}.jpg`

const zipFiles = {}
const usedPaths = new Set()
const stats = { tcg: 0, suruga: 0, x: 0, none: 0 }

for (const card of cards) {
  const key = norm(card.name)
  let file = null

  const tcgHits = tcgByName.get(key)
  const xHits = xByName.get(key)
  const surugaId = surugaByHoleId.get(card.id)

  if (tcgHits) {
    const hit = pickTcg(tcgHits, card.kind)
    const p = path.join(LOCAL, 'card_images', hit.setDir, `${hit.id}.jpg`)
    if (fs.existsSync(p)) { file = p; stats.tcg++ }
  }
  if (!file && surugaId) {
    const p = path.join(LOCAL, 'suruga_card_images', `${surugaId.toLowerCase()}.jpg`)
    if (fs.existsSync(p)) { file = p; stats.suruga++ }
  }
  if (!file && xHits) {
    const hit = pickX(xHits)
    const p = path.join(LOCAL, 'x_card_images', hit.file)
    if (fs.existsSync(p)) { file = p; stats.x++ }
  }
  if (!file) { stats.none++; continue }

  const zipPath = safePath(card.id)
  if (usedPaths.has(zipPath)) {
    console.error(`画像パスが衝突しました: ${zipPath}（id=${card.id}）`)
    process.exit(1)
  }
  usedPaths.add(zipPath)

  card.image = zipPath
  // JPEGは再圧縮しても縮まないので無圧縮で格納する（level:0）。生成も展開も速くなる。
  zipFiles[zipPath] = [new Uint8Array(fs.readFileSync(file)), { level: 0 }]
}

// ---------------------------------------------------------------------------
// 5. 出力
// ---------------------------------------------------------------------------
const meta = {
  generatedAt: new Date().toISOString(),
  poolSets: POOL_SETS.filter((s) => pool.some((c) => c.setVer === s)),
  cardCount: cards.length,
  imageCount: stats.tcg + stats.suruga + stats.x,
}

// ---------------------------------------------------------------------------
// 4.5. 起動能力の注釈（ユーザー校正済み。PHASE3a-2b.md §3-1）
//
// _local/ability-annotations.json（無ければ空で続行＝旧ZIPと互換）を
// card.id（= `${kind}_${norm(name)}`）キーのオブジェクトに変換する。
// pool.json/images はそのまま、annotations.json を別ファイルで足すだけ。
// ---------------------------------------------------------------------------
const annotationsPath = path.join(LOCAL, 'ability-annotations.json')
const annotations = {}
if (fs.existsSync(annotationsPath)) {
  const raw = readJson(annotationsPath)
  for (const entry of raw) {
    const id = `${entry.kind}_${norm(entry.name)}`
    annotations[id] = entry.abilities ?? []
  }
}

const enc = new TextEncoder()
zipFiles['pool.json'] = [enc.encode(JSON.stringify(cards)), { level: 9 }]
zipFiles['meta.json'] = [enc.encode(JSON.stringify(meta, null, 2)), { level: 9 }]
zipFiles['annotations.json'] = [enc.encode(JSON.stringify(annotations)), { level: 9 }]

fs.mkdirSync(OUT_DIR, { recursive: true })
const outPath = path.join(OUT_DIR, 'leaffight-data.zip')
fs.writeFileSync(outPath, zipSync(zipFiles))

// ---------------------------------------------------------------------------
// 報告（統括セッションへ渡す数字）
// ---------------------------------------------------------------------------
const KIND_LABEL = { c: 'キャラ', t: 'タッグ', b: 'バトル', i: 'アイテム', e: 'イベント', f: 'フィールド' }
const withImage = cards.filter((c) => c.image).length
const pct = (n, d) => (d === 0 ? '  -  ' : `${((n / d) * 100).toFixed(0).padStart(3)}%`)

console.log(`プール: ${meta.poolSets.length} セット (${meta.poolSets.join(', ')})`)
console.log(`  刷り              : ${pool.length} 件`)
console.log(`  ユニークカード    : ${cards.length} 種  (kind + 正規化名 ベース)`)
console.log(`  ユニーク名のみ    : ${new Set(cards.map((c) => norm(c.name))).size} 種`)
console.log('')
console.log(`画像: ${withImage} 種 / ${cards.length} 種 (${((withImage / cards.length) * 100).toFixed(1)}%)`)
console.log(`  tcg-db 由来       : ${stats.tcg}`)
console.log(`  駿河屋 由来       : ${stats.suruga}`)
console.log(`  X 由来            : ${stats.x}`)
console.log(`  画像なし          : ${stats.none}`)
console.log('')
console.log('種別ごとの内訳:')
for (const kind of ['c', 't', 'b', 'i', 'e', 'f']) {
  const ks = cards.filter((c) => c.kind === kind)
  const hit = ks.filter((c) => c.image).length
  console.log(`  ${KIND_LABEL[kind].padEnd(6, '　')} ${String(ks.length).padStart(3)} 種  画像 ${String(hit).padStart(3)} (${pct(hit, ks.length)})`)
}
console.log('')
console.log(
  `起動能力の注釈: ${Object.keys(annotations).length} カード / ${Object.values(annotations).reduce((n, a) => n + a.length, 0)} 能力` +
    (fs.existsSync(annotationsPath) ? '' : '（_local/ability-annotations.json が無いため空）'),
)
console.log('')
console.log(`出力: ${path.relative(ROOT, outPath)}  (${(fs.statSync(outPath).size / 1048576).toFixed(1)} MB)`)
