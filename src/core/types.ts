// core/ は純TypeScript。React・DOM・通信・Dexie を一切 import しない（DESIGN.md §3）。
// 将来 Unity へ移植するときは、この層をそのまま C# に翻訳する。
// P0 では「型だけ」置く。ゲーム状態と状態遷移は P1 以降。

/** ゾーン（DESIGN.md §4.1） */
export type Zone = 'deck' | 'hand' | 'field' | 'trash'

/**
 * コストの種類（DESIGN.md §4.8）。MTGのマナとは別物で、
 * 「自分の待機状態のキャラを消耗させる」ことで発生する。
 * 上位互換: R / L / T → G → W
 */
export type CostKind = 'W' | 'R' | 'G' | 'L' | 'T'
export const COST_KINDS: readonly CostKind[] = ['W', 'R', 'G', 'L', 'T']

/** 能力値であり、コストに帯びる属性でもある（DESIGN.md §4.8） */
export type Attr = '力' | '早' | '賢' | '根' | '感'
export const ATTRS: readonly Attr[] = ['力', '早', '賢', '根', '感']

/** カード種別。wiki の kind コードをそのまま使う */
export type CardKind = 'c' | 't' | 'b' | 'i' | 'e' | 'f'
export const CARD_KINDS: readonly CardKind[] = ['c', 't', 'b', 'i', 'e', 'f']

export const CARD_KIND_LABEL: Record<CardKind, string> = {
  c: 'キャラ',
  t: 'タッグ',
  b: 'バトル',
  i: 'アイテム',
  e: 'イベント',
  f: 'フィールド',
}

/** キャラ／タッグの能力値 */
export type Stats = Record<Attr, number>

/** カードの特殊能力。効果の解釈は人間が行う（DESIGN.md §5）ので、テキストのまま保持する */
export interface Ability {
  header: string
  text: string
}

/**
 * カード1種の定義。1枚の「刷り」ではなく、畳み込み後の1種を表す。
 * 生成は scripts/build-data-bundle.mjs（ローカル実行）。
 */
export interface Card {
  /** `${kind}_${正規化カード名}`。安定した一意キー */
  id: string
  kind: CardKind
  /** 表示名。正規化前の元の文字列（DESIGN.md §10 の地雷） */
  name: string
  kana: string
  /** 採用した刷りの版。同キーの中で最も新しい＝エラッタ反映済み */
  setVer: string
  /** この版以外に存在する刷り */
  printings: string[]
  /** wiki のカード番号。無い場合 -1 */
  num: number
  kiryoku: number | null
  stats: Stats | null
  /** 'WW' 等。文字ごとに CostKind */
  cost: string
  /** 属性。複合は元表記のまま（'早根' 等）。無属性は空文字 */
  attr: string
  /** バトルカードのみ。'力' '-' '？' 等 */
  battleAtk: string
  battleDef: string
  abilities: Ability[]
  illust: string
}

/** コスト文字列 'WGG' を ['W','G','G'] に分解する */
export function parseCost(cost: string): CostKind[] {
  const out: CostKind[] = []
  for (const ch of cost) {
    if ((COST_KINDS as readonly string[]).includes(ch)) out.push(ch as CostKind)
  }
  return out
}

/** 属性文字列 '早根' を ['早','根'] に分解する */
export function parseAttr(attr: string): Attr[] {
  const out: Attr[] = []
  for (const ch of attr) {
    if ((ATTRS as readonly string[]).includes(ch)) out.push(ch as Attr)
  }
  return out
}
