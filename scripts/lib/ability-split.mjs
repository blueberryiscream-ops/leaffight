// 能力の分割・使用代償の分離・キャラタイプの抽出（PHASE-E0.md §1-2）。
// build-data-bundle.mjs から呼ばれる純粋関数だけをここに集約する（テストが直接importできるように）。
// 🚨 このファイルはビルド専用スクリプト側の一部（core/ ではない）。ui/net/dataは触らない。

// キャラタイプ5種のみ（_local/種族タグ候補.md・DESIGN §5.3 下準備）
export const CHAR_TYPES = ['魔族', 'ロボ', '鬼', '強化兵', '天使']
const CHAR_TYPE_SET = new Set(CHAR_TYPES)

// 見出し行 = 能力名 + コスト。コストは W/R/G/L/T の記号列、Auto、'-'、気力－N（全角数字あり）、
// または「このキャラをゴミ箱送りにする」のような文章のこともある（cards_v2.json の header
// 実例579件から収集した語彙。card-data-fixes.md §Eの起動コスト一覧と一致）。
export const COST_RE_SRC =
  '(?:[WRGLT]{1,6}(?![WRGLT])' +
  '|Auto' +
  '|気力[－ー-](?:[0-9０-９]+|任意の数|回復数|回複数)' +
  '|このキャラを(?:ダウンさせる|ダウンする|ゴミ箱送りにする)' +
  '|手札の(?:キャラクターカード|アイテムカード)１枚をゴミ箱送りにする' +
  '|味方キャラ１体の気力[－ー-][0-9０-９]+' +
  '|(?:味方リーダー|リーダー)の気力[－ー-][0-9０-９]+' +
  '|対象のキャラを消耗状態にする' +
  '|このキャラが装備しているアイテムカード１枚をゴミ箱送りにする。?' +
  '|-)'
export const HEADING_RE = new RegExp('^([^\\n]{1,14}?)[\\s　]*(' + COST_RE_SRC + ')')

/** raw header文字列 "名前 コスト" を name/cost に分ける */
export function splitHeaderLine(raw) {
  const m = HEADING_RE.exec(raw)
  if (m && m[0].length >= raw.length - 2) return { name: m[1].trim(), cost: m[2] }
  const sp = raw.match(/^(\S+?)[\s　]+(\S+)$/)
  if (sp) return { name: sp[1], cost: sp[2] }
  return { name: raw, cost: '' }
}

/** 生の cost トークンを { cost, auto } に正規化する。'Auto'→常時の印、'-'→コスト無し(空文字) */
function normalizeCost(rawCost) {
  if (rawCost === 'Auto') return { cost: '', auto: true }
  if (rawCost === '-' || !rawCost) return { cost: '', auto: false }
  return { cost: rawCost, auto: false }
}

/**
 * 1つの abilities[] エントリ（header, text）を複数の能力に分割する（PHASE-DB.md §3）。
 * さらに PHASE-E0 §1-2: 使用代償/Autoをcost/autoに分け、先頭のキャラタイプ行をtagとして抽出し、
 * textは本文だけにする。
 *
 * 戻り値の各要素: { header, cost, auto, text, tag, _rawCost, _rawLead }
 * （`_rawCost`/`_rawLead` は文字消失検査専用。呼び出し側で削る）
 */
export function splitOneEntry(entry) {
  const first = splitHeaderLine(entry.header || '')
  const paragraphs = (entry.text || '')
    .split(/\n[ 　]*\n+/)
    .map((p) => p.trim())
    .filter((p) => p !== '')

  const result = [{ name: first.name, rawCost: first.cost, bodyParts: [] }]
  const leadingTrait = []
  let sawBody = false

  for (const p of paragraphs) {
    if (!sawBody && /^\[[^\]]{1,10}\]$/.test(p)) {
      leadingTrait.push(p)
      continue
    }
    // 統括9: 括弧の無いキャラタイプ行（ＨＭ－１２Ｓ「ロボ」・イビル＆エビル「魔族」）も拾う
    if (!sawBody && leadingTrait.length === 0 && CHAR_TYPE_SET.has(p)) {
      leadingTrait.push(p)
      continue
    }
    if (!sawBody) {
      result[0].bodyParts.push(p)
      sawBody = true
      continue
    }
    const m = HEADING_RE.exec(p)
    if (m && m.index === 0) {
      const rest = p.slice(m[0].length).trim()
      result.push({ name: m[1].trim(), rawCost: m[2], bodyParts: rest ? [rest] : [] })
    } else {
      result[result.length - 1].bodyParts.push(p)
    }
  }

  // 先頭のキャラタイプ行（使用代償／Autoの次の行が[タグ]だけ）だけを取り出す。
  // 実データでは1能力につき常に0か1個（統括9の事前調査で確認）。キャラタイプ5種以外の
  // 角括弧行（[水中バトルペナルティ]等）はタグとみなさず本文に残す（PHASE-E0 §2）。
  let tag = null
  let rawTag = ''
  const bare = (t) => (t.startsWith('[') ? t.slice(1, -1) : t)
  if (leadingTrait.length > 0 && CHAR_TYPE_SET.has(bare(leadingTrait[0]))) {
    tag = bare(leadingTrait[0])
    rawTag = leadingTrait[0]
    if (leadingTrait.length > 1) result[0].bodyParts.unshift(leadingTrait.slice(1).join('\n\n'))
  } else if (leadingTrait.length > 0) {
    result[0].bodyParts.unshift(leadingTrait.join('\n\n'))
  }
  result[0].tag = tag
  result[0].rawTag = rawTag
  for (let i = 1; i < result.length; i++) result[i].tag = null

  return result.map((a) => {
    const { cost, auto } = normalizeCost(a.rawCost)
    return {
      header: a.name,
      cost,
      auto,
      tag: a.tag,
      text: a.bodyParts.join('\n\n'),
      // 文字消失検査専用（本文からは削る）
      _rawCost: a.rawCost || '',
      _rawTagBrackets: a.rawTag || '',
    }
  })
}

/**
 * raw abilities[] を分割する。abilityCharLossExamples に (before, after) の不一致例を積む
 * （呼び出し側で0件を検査すること）。
 */
export function splitAbilities(rawAbilities, abilityCharLossExamples) {
  const out = []
  for (const entry of rawAbilities) {
    const split = splitOneEntry(entry)
    for (const a of split) {
      const { _rawCost, _rawTagBrackets, ...clean } = a
      out.push(clean)
    }
    const before = ((entry.header || '') + (entry.text || '')).replace(/\s+/g, '')
    const after = split
      .map((a) => a.header + a._rawCost + a._rawTagBrackets + a.text)
      .join('')
      .replace(/\s+/g, '')
    if (before !== after) {
      abilityCharLossExamples.push({ before: before.slice(0, 80), after: after.slice(0, 80) })
    }
  }
  return out
}

/** カードの能力配列からキャラタイプ（5種のみ）を集める（PHASE-E0 §2） */
export function collectCharTypes(abilities) {
  const set = new Set()
  for (const a of abilities) {
    if (a.tag) set.add(a.tag)
  }
  return [...set]
}
