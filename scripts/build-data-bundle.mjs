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
import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zipSync } from 'fflate'
import { CHAR_TYPES, collectCharTypes, splitAbilities } from './lib/ability-split.mjs'

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
// 第4ソース「手動発見画像」: ユーザーが個別に見つけてきた画像。tcg-db/駿河屋/X のどれにも
// 無い穴を埋めるためのものなので優先度は最下位。対応表 manual_images.csv は
// cardId（= `${kind}_${norm(name)}`）で引ける形式。webp が混じるので拡張子はファイル名から取る。
const manualMapPath = path.join(LOCAL, 'manual_images.csv')
const manualCards = fs.existsSync(manualMapPath) ? readCsv(manualMapPath) : []

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

// 性別（PHASE-DB.md §3）。cells の種別ごとの固定位置から読む（DESIGN §7.6 の cells を正とする原則）。
// c: [名前, 気力, コスト, 属性, 性別, レアリティ, Ilus:, ...] / t: [名前, 気力, 属性, 性別, レアリティ, Ilus:, ...]
function extractSex(kind, cells) {
  const raw = kind === 'c' ? cells[4] : kind === 't' ? cells[3] : undefined
  return raw === '男性' || raw === '女性' ? raw : ''
}

// ---------------------------------------------------------------------------
// 能力の分割（PHASE-DB.md §3）と、使用代償/キャラタイプの分離（PHASE-E0.md §1-2）。
// 実装は scripts/lib/ability-split.mjs（テストがimportできる純粋関数として分離）。
//
// 🚨 文字を1文字も失わないこと（build内で検査する）。
// ---------------------------------------------------------------------------
const abilityCharLossExamples = []
/** カードごとのキャラタイプ抽出結果を後段レポート用に集める（cardId -> string[]） */
const charTypesByCard = new Map()
/** cost/Auto/なしの件数集計（PHASE-E0 §5） */
const costSplitStats = { withCost: 0, auto: 0, none: 0 }
/** 統括が抜き取りで確かめる中間データ（_local/scratch/E0-cost-split.json） */
const costSplitScratch = []

/**
 * 本文の1行目に残っている使用代償（R1 で発見・統括10が確認）。元の表記では使用代償の欄にあるが、
 * データでは本文の頭に入っている。本文から外して cost に「＋」でつなぐ（`R＋気力－１` と同じ書き方）。
 * 根拠: olderatta.txt:737-739「使用代償：R　このキャラをゴミ箱送りにする」（受け渡しの原文）・
 *       oldfaq.txt:3103「使用代償を支払った時点で、フィールドからリーダーキャラクターが失われた」（心の世界）
 */
const COST_IN_TEXT = [
  { cardId: 'c_マルチ', header: '受け渡し', line: 'このキャラをダウンさせる' },
  { cardId: 'c_牧部なつみ', header: '心の世界', line: 'このキャラをゴミ箱送りにする' },
]
const costInTextApplied = []

function moveCostOutOfText(cardId, a) {
  const fix = COST_IN_TEXT.find((f) => f.cardId === cardId && f.header === a.header)
  if (!fix || !(a.text || '').startsWith(fix.line + '\n')) return a
  costInTextApplied.push(`${cardId}/${a.header}`)
  return { ...a, cost: a.cost ? `${a.cost}＋${fix.line}` : fix.line, text: a.text.slice(fix.line.length + 1) }
}

function splitAbilitiesForCard(cardId, rawAbilities) {
  const withTag = splitAbilities(rawAbilities, abilityCharLossExamples).map((a) => moveCostOutOfText(cardId, a))
  charTypesByCard.set(cardId, collectCharTypes(withTag))
  return withTag.map((a) => {
    if (a.auto) costSplitStats.auto++
    else if (a.cost) costSplitStats.withCost++
    else costSplitStats.none++
    costSplitScratch.push({
      cardId,
      header: a.header,
      cost: a.cost,
      auto: a.auto,
      text先頭20字: (a.text || '').slice(0, 20),
    })
    return { header: a.header, cost: a.cost, auto: a.auto, text: a.text }
  })
}

// ---------------------------------------------------------------------------
// 1.5 旧方式（kind + 正規化名で束ね、最新刷りを採用）の id 集合。
//     新方式との差分（消える id・増える id）を出すためだけに使う。出力には使わない。
// ---------------------------------------------------------------------------
function buildOldScheme() {
  const g = new Map()
  for (const printing of pool) {
    const id = `${printing.kind}_${norm(printing.name)}`
    const arr = g.get(id)
    if (arr) arr.push(printing)
    else g.set(id, [printing])
  }
  const ids = new Set()
  for (const [id] of g) ids.add(id)
  return ids
}
const oldIds = buildOldScheme()

// ---------------------------------------------------------------------------
// 2. 刷り → カードへの畳み込み（キー = kind + num。num が無い刷りだけ従来どおり kind + 正規化名）
//    DESIGN.md §7.6「主キー = ver + kind + num」に合わせる（PHASE-DB.md §1）。
//    中身の正は New一覧（setVer==='New'）の同じ kind+num の1件。無ければ従来どおり最新刷りを採用。
// ---------------------------------------------------------------------------
const newList = wikiCards.filter((c) => c.setVer === 'New')
const newByKindNum = new Map() // `${kind}#${num}` -> [New entries]
for (const n of newList) {
  if (!Number.isInteger(n.num)) continue
  const key = `${n.kind}#${n.num}`
  const arr = newByKindNum.get(key)
  if (arr) arr.push(n)
  else newByKindNum.set(key, [n])
}

const overridesPath = path.join(LOCAL, 'card-id-overrides.json')
const overrides = fs.existsSync(overridesPath)
  ? readJson(overridesPath)
  : { idByNum: {}, aliases: {} }

const groups = new Map() // key(`${kind}#${num}` or `${kind}_${norm(name)}`) -> printings[]
let noNumCount = 0
for (const printing of pool) {
  const key = Number.isInteger(printing.num)
    ? `${printing.kind}#${printing.num}`
    : `${printing.kind}_${norm(printing.name)}`
  if (!Number.isInteger(printing.num)) noNumCount++
  const g = groups.get(key)
  if (g) g.push(printing)
  else groups.set(key, [printing])
}

const newDupLog = [] // New一覧内で同じkind+numに複数エントリがあったケース
const newFallbackLog = [] // New一覧に該当が無くフォールバックしたケース
const splitTraceLog = [] // 版によって名前が割れている刷り（PHASE §1-4）

const cards = []
for (const [key, printings] of groups) {
  printings.sort((a, b) => SET_ORDER.get(a.setVer) - SET_ORDER.get(b.setVer))
  const latestPrinting = printings[printings.length - 1]

  // 同じ kind+num の中で名前が割れている刷りはログに出す（PHASE-DB.md §1-4）
  const namesInGroup = new Set(printings.map((p) => norm(p.name)))
  if (namesInGroup.size > 1) {
    splitTraceLog.push({ key, names: printings.map((p) => `${p.setVer}:${p.name}`) })
  }

  const isNumKey = /^.#-?\d+$/.test(key)
  let content = null
  let source = 'latest-wins'
  if (isNumKey) {
    const newEntries = newByKindNum.get(key)
    if (newEntries && newEntries.length === 1) {
      content = newEntries[0]
      source = 'New'
    } else if (newEntries && newEntries.length > 1) {
      // New一覧自身に同じ kind+num の重複行がある（例: c#38 柳川祐也/裕也）。
      // POOL_SETS に載っている ver を優先し、その中で最も新しいものを採用する
      const scored = newEntries.map((e) => ({
        e,
        inPool: SET_ORDER.has(e.ver) ? 0 : 1,
        order: SET_ORDER.has(e.ver) ? SET_ORDER.get(e.ver) : -1,
      }))
      scored.sort((a, b) => a.inPool - b.inPool || b.order - a.order)
      content = scored[0].e
      source = 'New(dup)'
      newDupLog.push({ key, chosen: content.name, candidates: newEntries.map((e) => `${e.name}(ver=${e.ver})`) })
    } else {
      newFallbackLog.push({ key, name: latestPrinting.name })
    }
  }
  if (!content) content = latestPrinting

  const { cost, attr } = extractCostAttr(content.kind, content.cells)
  const { battleAtk, battleDef } = extractBattle(content.kind, content.cells)
  const sex = extractSex(content.kind, content.cells)

  const num = Number.isInteger(content.num) ? content.num : Number.isInteger(latestPrinting.num) ? latestPrinting.num : -1
  const overrideKey = `${content.kind}#${num}`
  const override = overrides.idByNum?.[overrideKey]
  const displayName = override?.name ?? content.name
  const id = override?.id ?? `${content.kind}_${norm(displayName)}`

  cards.push({
    id,
    kind: content.kind,
    name: displayName,
    kana: content.kana ?? latestPrinting.kana ?? '',
    setVer: content.setVer,
    printings: [...new Set(printings.map((p) => p.setVer))].filter((v) => v !== latestPrinting.setVer),
    num,
    kiryoku: content.kiryoku ?? null,
    stats: content.stats ?? null,
    cost,
    attr,
    sex,
    battleAtk,
    battleDef,
    abilities: splitAbilitiesForCard(id, content.abilities ?? []),
    charTypes: charTypesByCard.get(id) ?? [],
    illust: content.illust ?? '',
    cells: content.cells, // 生セル。絶対に落とさない
    image: null, // 次のステップで埋める
    _foldKey: key, // 検証専用。最終出力前に削る
    _source: source,
    // 画像突き合わせ用。idByNumで表示名を変えたカード（例: スフィー(3.00)）でも、
    // tcg-db/X 側の対応表は wiki の元の名前（"スフィー"）でしか引けないため、
    // 元の名前を別途持っておく（PHASE-DB.md §5・画像の当たり率を落とさない）
    _imageSearchName: content.name,
  })
}
cards.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id, 'ja'))

// ---------------------------------------------------------------------------
// 2.0.1 検証: 能力分割で文字が消えていないこと（PHASE-DB.md §3 🚨）
// ---------------------------------------------------------------------------
if (abilityCharLossExamples.length > 0) {
  console.error(`🚨 能力の分割で文字が消えました（${abilityCharLossExamples.length}件）:`)
  for (const ex of abilityCharLossExamples.slice(0, 10)) {
    console.error(`  前: ${ex.before}`)
    console.error(`  後: ${ex.after}`)
  }
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 2.1 検証: id の衝突（idByNum で解消されていない衝突は build を失敗させる）
// ---------------------------------------------------------------------------
const idToKeys = new Map()
for (const c of cards) {
  const arr = idToKeys.get(c.id)
  if (arr) arr.push(c._foldKey)
  else idToKeys.set(c.id, [c._foldKey])
}
const unresolvedCollisions = [...idToKeys.entries()].filter(([, keys]) => keys.length > 1)
if (unresolvedCollisions.length > 0) {
  console.error('🚨 id の衝突が解決されていません（_local/card-id-overrides.json の idByNum に追記してください）:')
  for (const [id, keys] of unresolvedCollisions) console.error(`  ${id} <- ${keys.join(', ')}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 2.2 検証: 旧 id が新プールから消える場合、必ず aliases に載っていること
// ---------------------------------------------------------------------------
const newIds = new Set(cards.map((c) => c.id))
const removedIds = [...oldIds].filter((id) => !newIds.has(id))
const unaliased = removedIds.filter((id) => !overrides.aliases?.[id] || !newIds.has(overrides.aliases[id]))
if (unaliased.length > 0) {
  console.error('🚨 旧 pool から消える id が aliases に無い（または alias 先が新プールに無い）:')
  for (const id of unaliased) console.error(`  ${id} (alias先候補: ${overrides.aliases?.[id] ?? '(未設定)'})`)
  process.exit(1)
}
const addedIds = [...newIds].filter((id) => !oldIds.has(id))

// _foldKey/_source は検証用途のみ。最終出力からは削る
// _foldKey/_source/_imageSearchName は検証・画像突き合わせ専用。最終出力直前（zip書き出し前）に削る

// ---------------------------------------------------------------------------
// 2.5 エラッタの未反映を反映する（PHASE-E0.md §3-2）。
//
// _local/errata-overrides.json（無ければ空で続行）: [{ cardId, ability, from, to, source }]。
// `from` はその能力（`ability` が空文字ならカードの全能力を通して）の text 中に
// 🚨 ちょうど1回だけ現れることを確認してから置き換える。0回・2回以上ならビルドを失敗させる
// （New一覧の本文が変わって前提が崩れたときに気づけるように）。
// ---------------------------------------------------------------------------
const errataOverridesPath = path.join(LOCAL, 'errata-overrides.json')
const errataOverrides = fs.existsSync(errataOverridesPath) ? readJson(errataOverridesPath) : []
let errataApplied = 0
const errataErrors = []
for (const ov of errataOverrides) {
  const card = cards.find((c) => c.id === ov.cardId)
  if (!card) {
    errataErrors.push(`${ov.cardId}: カードが見つかりません`)
    continue
  }
  const targets = ov.ability ? card.abilities.filter((a) => a.header === ov.ability) : card.abilities
  const occurrences = targets.reduce((n, a) => n + (a.text.split(ov.from).length - 1), 0)
  if (occurrences !== 1) {
    errataErrors.push(
      `${ov.cardId}${ov.ability ? '/' + ov.ability : ''}: from が ${occurrences} 回現れました（1回のはず）: ${ov.from.slice(0, 40)}`,
    )
    continue
  }
  for (const a of targets) {
    if (a.text.includes(ov.from)) {
      a.text = a.text.replace(ov.from, ov.to)
      errataApplied++
    }
  }
}
if (errataErrors.length > 0) {
  console.error('🚨 エラッタの反映に失敗しました（_local/errata-overrides.json を確認してください）:')
  for (const e of errataErrors) console.error(`  ${e}`)
  process.exit(1)
}

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

// manual_images.csv は旧id（`${kind}_${norm(name)}`）で書かれている（PHASE-DB §5・作り直さない）。
// id が変わったカード（例: c_神岸あかりS → c_神岸あかりSP）は alias を経由して最終idで引く。
const manualById = new Map()
for (const r of manualCards) {
  if (!r.cardId || !r.file) continue
  const targetId = overrides.aliases?.[r.cardId] ?? r.cardId
  manualById.set(targetId, r.file)
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
// 拡張子は元ファイルのものを使う（webp混在。読み込み側は MIME を拡張子から決める）
const safePath = (id, ext) => `images/${id.replace(/[\\/:*?"<>|]/g, '_')}.${ext}`

const zipFiles = {}
const usedPaths = new Set()
const stats = { tcg: 0, suruga: 0, x: 0, manual: 0, none: 0 }

for (const card of cards) {
  const key = norm(card._imageSearchName ?? card.name)
  let file = null

  const tcgHits = tcgByName.get(key)
  const xHits = xByName.get(key)
  const surugaId = surugaByHoleId.get(card.id)

  // 手動の対応表は人が画像を見て決めたもの（id で直接指定）なので最優先にする。
  // 名前で引く他のソースだと、同名の別カード（神岸あかり と 神岸あかりSP は wiki 名がどちらも
  // 「神岸あかり」）が同じ画像を取り合う（統括8の検証で発覚: 両方が通常版の画像になっていた）。
  {
    const manualFile = manualById.get(card.id)
    if (manualFile) {
      const p = path.join(LOCAL, 'manual_card_images', manualFile)
      if (fs.existsSync(p)) { file = p; stats.manual++ }
    }
  }
  if (!file && tcgHits) {
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

  const ext = (path.extname(file).slice(1) || 'jpg').toLowerCase()
  const zipPath = safePath(card.id, ext)
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
    // entry.id があればそれを使う（同名の別カード＝card-id-overrides.json の idByNum 用。例: マジカルサンダーのスフィー）
    const id = entry.id ?? `${entry.kind}_${norm(entry.name)}`
    annotations[id] = entry.abilities ?? []
  }
}

// ---------------------------------------------------------------------------
// 4.5.1 Ability.cost と起動ボタンの注釈(cost)の機械突き合わせ（PHASE-E0.md §1）。
// 直さない。一致率と不一致の一覧だけレポートに出す。
// ---------------------------------------------------------------------------
const costAnnotationMismatches = []
let costAnnotationChecked = 0
let costAnnotationMatched = 0
for (const [cardId, annAbilities] of Object.entries(annotations)) {
  const card = cards.find((c) => c.id === cardId)
  if (!card) continue
  for (const ann of annAbilities) {
    const ability = card.abilities.find((a) => a.header === ann.name)
    if (!ability) continue // 分割の不一致8件（HANDOFF-DB参照・PHASE-E0ではやらない）
    costAnnotationChecked++
    const expectAuto = ann.type === '常時'
    const match = expectAuto ? ability.auto === true : !ability.auto && ability.cost === ann.cost
    if (match) costAnnotationMatched++
    else {
      costAnnotationMismatches.push({
        cardId,
        ability: ann.name,
        annotationCost: ann.cost,
        annotationType: ann.type,
        dataCost: ability.cost,
        dataAuto: ability.auto,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// 4.6. 割り込み（トリガー）の注釈（ユーザー校正済み54件。PHASE3c.md §1。annotations.jsonと同じ流儀）
//
// _local/interrupt-annotations.json（無ければ空で続行）を card.id キーのオブジェクトに変換する。
// 1カードが複数の割り込み能力を持ちうるので配列で束ねる（例: 蝉丸＆光岡は2件）。
// ---------------------------------------------------------------------------
const interruptAnnotationsPath = path.join(LOCAL, 'interrupt-annotations.json')
const interrupts = {}
if (fs.existsSync(interruptAnnotationsPath)) {
  const raw = readJson(interruptAnnotationsPath)
  for (const entry of raw) {
    const id = `${entry.kind}_${norm(entry.card)}`
    if (!interrupts[id]) interrupts[id] = []
    interrupts[id].push({
      ability: entry.ability,
      cost: entry.cost,
      subject: entry.subject,
      timings: entry.timings ?? [],
    })
  }
}

// ---------------------------------------------------------------------------
// 4.8. 種族タグの候補（PHASE-DB.md §3・データには入れない。統括/利用者の確認用の一覧のみ）
// ---------------------------------------------------------------------------
const traitCounts = new Map()
for (const c of cards) {
  if (c.kind !== 'c' && c.kind !== 't') continue
  for (const ab of c.abilities) {
    const matches = ((ab.header || '') + (ab.text || '')).match(/\[[^\]]{1,10}\]/g) || []
    // PHASE-E0で先頭のキャラタイプ行はtextから抽出済み（この候補表は機械抽出の生の目安として残す）
    for (const m of matches) {
      const inner = m.slice(1, -1)
      if (/^[力早賢根感]+$/.test(inner)) continue // 属性修飾ブラケット
      if (/^[WRGLT]+$/.test(inner)) continue // コストアイコン
      if (!traitCounts.has(inner)) traitCounts.set(inner, [])
      traitCounts.get(inner).push(c.name)
    }
  }
}
const traitSorted = [...traitCounts.entries()].sort((a, b) => b[1].length - a[1].length)
const traitMd =
  '# 種族タグ候補（機械抽出・データには入れていない。PHASE-DB.md §3）\n\n' +
  `キャラ/タッグの能力テキスト中の \`[...]\` 表記から、属性修飾（[力][早]等の単体・組み合わせ）とコストアイコン（[W][RG]等）を除いたもの。誤検出（[攻][防]等・種族でない可能性）も含めて全件出す。\n\n` +
  '| タグ | 件数 | 例（3枚） |\n|---|---|---|\n' +
  traitSorted.map(([tag, names]) => `| ${tag} | ${names.length} | ${[...new Set(names)].slice(0, 3).join(', ')} |`).join('\n') +
  '\n'
fs.writeFileSync(path.join(LOCAL, '種族タグ候補.md'), traitMd)

// ---------------------------------------------------------------------------
// 4.9. キャラタイプ（PoolCard.charTypes・PHASE-E0.md §2）の件数と全件
// ---------------------------------------------------------------------------
const charTypeCards = new Map(CHAR_TYPES.map((t) => [t, []]))
for (const c of cards) {
  for (const t of c.charTypes) {
    if (charTypeCards.has(t)) charTypeCards.get(t).push(`${c.name}(${c.id})`)
  }
}

// ---------------------------------------------------------------------------
// 4.10. 統括が抜き取りで確かめる中間データ（PHASE-E0.md §5）
// ---------------------------------------------------------------------------
const scratchDir = path.join(LOCAL, 'scratch')
fs.mkdirSync(scratchDir, { recursive: true })
fs.writeFileSync(path.join(scratchDir, 'E0-cost-split.json'), JSON.stringify(costSplitScratch, null, 1))

for (const c of cards) { delete c._foldKey; delete c._source; delete c._imageSearchName }

const enc = new TextEncoder()
zipFiles['pool.json'] = [enc.encode(JSON.stringify(cards)), { level: 9 }]
zipFiles['meta.json'] = [enc.encode(JSON.stringify(meta, null, 2)), { level: 9 }]
zipFiles['annotations.json'] = [enc.encode(JSON.stringify(annotations)), { level: 9 }]
zipFiles['interrupts.json'] = [enc.encode(JSON.stringify(interrupts)), { level: 9 }]
// aliases.json: 旧id→新idの読み替え表（PHASE-DB.md §2）。pool.json は既存どおり配列のまま保つ
// （src/data/bundle.ts の parse契約を壊さないため。別ファイルで足す＝annotations.json等と同じ流儀）
zipFiles['aliases.json'] = [enc.encode(JSON.stringify(overrides.aliases ?? {})), { level: 9 }]

// ---------------------------------------------------------------------------
// 4.11. カードの記述（ルールエンジン・DESIGN.md §5.4・PHASE-R2a §2-5）。_local/rules/cards/*.ts（非公開）の
// `export const def` を JSON にして carddefs.json に入れる。_ で始まるファイルは小道具なので読まない。
// フォルダが無ければ空の {} を入れる（data 層の読み込みは R2u）。
// ---------------------------------------------------------------------------
const cardDefsDir = path.join(LOCAL, 'rules', 'cards')
const cardDefs = {}
if (fs.existsSync(cardDefsDir)) {
  register('./ts-extensionless-loader.mjs', import.meta.url) // 記述は TS（型を外して読む）
  for (const f of fs.readdirSync(cardDefsDir).filter((f) => f.endsWith('.ts') && !f.startsWith('_')).sort()) {
    const mod = await import(pathToFileURL(path.join(cardDefsDir, f)).href)
    if (mod.def?.id) cardDefs[mod.def.id] = mod.def
    else console.warn(`⚠ カードの記述に def が無い: ${f}`)
  }
}
zipFiles['carddefs.json'] = [enc.encode(JSON.stringify(cardDefs)), { level: 9 }]

// ---------------------------------------------------------------------------
// 4.7. カード裏面（PHASE2.11.md §4）。_local/card-back.jpg（利用者提供・権利物）が
// あれば back.jpg として同梱する。無ければ入れずに続行（annotations.json と同じ流儀＝旧ZIP互換）。
// ---------------------------------------------------------------------------
const cardBackPath = path.join(LOCAL, 'card-back.jpg')
const hasCardBack = fs.existsSync(cardBackPath)
if (hasCardBack) {
  zipFiles['back.jpg'] = [new Uint8Array(fs.readFileSync(cardBackPath)), { level: 0 }]
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const outPath = path.join(OUT_DIR, 'leaffight-data.zip')
fs.writeFileSync(outPath, zipSync(zipFiles))

// ---------------------------------------------------------------------------
// 報告（統括セッションへ渡す数字）
// ---------------------------------------------------------------------------
const KIND_LABEL = { c: 'キャラ', t: 'タッグ', b: 'バトル', i: 'アイテム', e: 'イベント', f: 'フィールド' }
const withImage = cards.filter((c) => c.image).length
const pct = (n, d) => (d === 0 ? '  -  ' : `${((n / d) * 100).toFixed(0).padStart(3)}%`)

console.log(`カードの記述（carddefs.json）: ${Object.keys(cardDefs).length} 枚`)
console.log(`プール: ${meta.poolSets.length} セット (${meta.poolSets.join(', ')})`)
console.log(`  刷り              : ${pool.length} 件`)
console.log(`  ユニークカード    : ${cards.length} 種  (kind + 正規化名 ベース)`)
console.log(`  ユニーク名のみ    : ${new Set(cards.map((c) => norm(c.name))).size} 種`)
console.log('')
console.log(`画像: ${withImage} 種 / ${cards.length} 種 (${((withImage / cards.length) * 100).toFixed(1)}%)`)
console.log(`  tcg-db 由来       : ${stats.tcg}`)
console.log(`  駿河屋 由来       : ${stats.suruga}`)
console.log(`  手動発見 由来     : ${stats.manual}`)
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
console.log(
  `割り込みの注釈: ${Object.keys(interrupts).length} カード / ${Object.values(interrupts).reduce((n, a) => n + a.length, 0)} 件` +
    (fs.existsSync(interruptAnnotationsPath) ? '' : '（_local/interrupt-annotations.json が無いため空）'),
)
console.log('')
console.log('========== PHASE-E0 レポート（使用代償・キャラタイプ・エラッタ） ==========')
console.log(
  `\n[§1] 使用代償の分け方: cost あり ${costSplitStats.withCost} / Auto(常時) ${costSplitStats.auto} / なし ${costSplitStats.none}（全 ${costSplitStats.withCost + costSplitStats.auto + costSplitStats.none} 能力）`,
)
console.log(`[§1] 本文から使用代償へ移した行: ${costInTextApplied.length}/${COST_IN_TEXT.length} 件 ${costInTextApplied.join('・')}`)
if (costInTextApplied.length !== COST_IN_TEXT.length) throw new Error('COST_IN_TEXT の一部が当たらなかった（本文が変わった？）')
console.log(
  `[§1] 起動注釈との一致率: ${costAnnotationMatched} / ${costAnnotationChecked} (${costAnnotationChecked ? ((costAnnotationMatched / costAnnotationChecked) * 100).toFixed(1) : '-'}%)`,
)
console.log(`  不一致 ${costAnnotationMismatches.length} 件:`)
for (const m of costAnnotationMismatches) {
  console.log(`   ${m.cardId}/${m.ability}: 注釈cost=${JSON.stringify(m.annotationCost)}(${m.annotationType}) データ cost=${JSON.stringify(m.dataCost)} auto=${m.dataAuto}`)
}
console.log(`\n[§2] キャラタイプ件数（候補表 _local/種族タグ候補.md: 魔族8/ロボ7/鬼7/強化兵5/天使2）:`)
for (const t of CHAR_TYPES) {
  const names = charTypeCards.get(t)
  console.log(`  ${t}: ${names.length} 件 — ${names.join(', ')}`)
}
console.log(`\n[§3] エラッタ反映: ${errataApplied} 件（_local/errata-overrides.json ${errataOverrides.length} 件中）`)
console.log('\n========== PHASE-E0 レポートここまで ==========')
console.log('')
console.log(`出力: ${path.relative(ROOT, outPath)}  (${(fs.statSync(outPath).size / 1048576).toFixed(1)} MB)`)
console.log(
  `カード裏面: ${hasCardBack ? 'back.jpg を同梱' : '無し（_local/card-back.jpg が見つからないため未同梱）'}`,
)

// ---------------------------------------------------------------------------
// 5. DB作り直しの検証レポート（PHASE-DB.md §6 の自己点検用の生数値）
// ---------------------------------------------------------------------------
console.log('\n========== PHASE-DB 検証レポート ==========')

console.log(`\n[§1-2] New一覧の num とプールの num の一致（名前一致414件中）: 検証は事前調査で実施（0件不一致）`)
console.log(`  num の無い刷り（名前で束ねた件数）: ${noNumCount} 件`)

console.log(`\n[§1-4] 同じ kind+num の中で名前が割れている刷り: ${splitTraceLog.length} 件`)
for (const t of splitTraceLog) console.log(`  ${t.key}: ${t.names.join(' | ')}`)

console.log(`\n[New一覧] 該当なしでフォールバック（旧latest-wins採用）: ${newFallbackLog.length} 件`)
for (const f of newFallbackLog.slice(0, 20)) console.log(`  ${f.key} (${f.name})`)

console.log(`\n[New一覧] 同一kind+numに複数エントリ: ${newDupLog.length} 件`)
for (const d of newDupLog) console.log(`  ${d.key}: 採用=${d.chosen} / 候補=${d.candidates.join(', ')}`)

console.log(`\n[§2] idByNum 適用: ${Object.keys(overrides.idByNum ?? {}).length} 件`)
for (const [k, v] of Object.entries(overrides.idByNum ?? {})) console.log(`  ${k} -> ${v.id} (${v.name})`)

console.log(`\n[§2] 旧→新で消えた id（すべて aliases で読み替え済み）: ${removedIds.length} 件`)
for (const id of removedIds) console.log(`  ${id} -> ${overrides.aliases[id]}`)
console.log(`[§2] 新規に増えた id: ${addedIds.length} 件`)
for (const id of addedIds.slice(0, 20)) console.log(`  ${id}`)

console.log(`\n[§3] 性別データの充足率: ${cards.filter((c) => (c.kind === 'c' || c.kind === 't') && c.sex).length} / ${cards.filter((c) => c.kind === 'c' || c.kind === 't').length}`)

// 能力分割の精度（正解データ: _local/ability-annotations.json 90件）
const abilityAnnotationsPath = path.join(LOCAL, 'ability-annotations.json')
if (fs.existsSync(abilityAnnotationsPath)) {
  const rawAnno = readJson(abilityAnnotationsPath)
  let matched = 0
  let beforeMatched = 0
  const misses = []
  for (const entry of rawAnno) {
    const id = `${entry.kind}_${norm(entry.name)}`
    const card = cards.find((c) => c.id === id)
    if (!card) { misses.push({ name: entry.name, reason: 'id不一致（New一覧に無い/注釈名が壊れている）' }); continue }
    const gotNames = new Set(card.abilities.map((a) => a.header))
    const wantNames = new Set(entry.abilities.map((a) => a.name))
    const eq = gotNames.size === wantNames.size && [...wantNames].every((n) => gotNames.has(n))
    if (eq) matched++
    else misses.push({ name: entry.name, want: [...wantNames], got: [...gotNames] })
    if (gotNames.size >= 1 && [...wantNames].every((n) => n === [...gotNames][0]) === false && wantNames.size === 1 && [...gotNames].length >= 1) {
      // 分割前相当（先頭の名前だけ）との比較用
    }
  }
  console.log(`\n[§3] 能力分割の精度: 分割後 ${matched} / ${rawAnno.length}（分割前は常に 0/${rawAnno.length}。header に名前+コストが混在し注釈名と一致しないため）`)
  console.log(`  不一致 ${misses.length} 件:`)
  for (const m of misses) console.log(`   ${JSON.stringify(m)}`)
}

console.log('\n[§5] 神岸あかり/あかりSPの現物確認:')
for (const id of ['c_神岸あかり', 'c_神岸あかりSP']) {
  const c = cards.find((x) => x.id === id)
  console.log(`  ${id}: ${c ? `気力${c.kiryoku} / 能力=${c.abilities.map((a) => a.header).join('・')} / 画像=${c.image ?? '(無し)'}` : '(見つからない)'}`)
}
const c245 = cards.filter((c) => c.num === 245 && c.kind === 'c')
console.log(`[§5] No.245（吉井・岡田・松本 / 岡田・松本・吉井）の件数: ${c245.length} 件（${c245.map((c) => c.name).join(', ')}）`)

console.log('\n========== レポートここまで ==========')
