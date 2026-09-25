/*
 * FAQ テストの1ケースの形 — DESIGN.md §5.4「FAQ テストの形式」
 *
 * ケースの中身（FAQ の逐語・カードの読み合わせ）は非公開側 _local/rules/faq/ に置く。ここは型だけ。
 * 期待値は FAQ の答えに書いてあることだけから作る。エンジンの出力を写さない。
 */

import type { Attr, HoleId, Op } from './dsl'

/** テストにできるかの判定（実験1 の区分） */
export type FaqGrade =
  | 'T'          // 盤面・操作・結果が書ける
  | 'T?'         // 概念が要る（concepts に書く）
  | 'N'          // テストにできない（whyNot に書く）
  | 'outOfPool'  // 主役のカードがプール外（pool.json に無い）

/** エンジンの中核の仕組み（DESIGN §5.4）。どれにも当たらない概念は文字列で書く */
export type Mechanism = 'K1' | 'K2' | 'K3' | 'K4' | 'K5' | 'K6' | 'K7' | 'K8' | 'K9' | 'K10' | 'K11' | 'K12' | 'K13'

export type Side = 'you' | 'opponent'

/** 盤面に置くカード1枚。ref はケースの中での呼び名（steps・expect から指す） */
export interface CardSpec {
  ref: string
  card: string            // pool.json の id
  kiryoku?: number        // 省略時はカードの気力（リーダーは原典どおり元×2）
  ready?: boolean         // 省略時は待機
  equips?: CardSpec[]     // 装備しているアイテム
}

export interface SideSpec {
  leader: CardSpec
  field?: CardSpec[]      // キャラ・タッグ
  fieldCard?: CardSpec
  battleCards?: (CardSpec & { used?: boolean })[]
  hand?: CardSpec[]
  trash?: CardSpec[]
  deckTop?: CardSpec[]    // 上から順。残りは問わない
  downs?: number
  costs?: { icon: 'W' | 'R' | 'G' | 'L' | 'T'; attr: Attr }[] // 発生済みのコスト
}

export interface BoardSpec {
  you: SideSpec
  opponent: SideSpec
  active: Side
  phase?: 'エントリー' | 'メイン' | '終了' | '手札調整'
  /** バトル中から始めるとき: 20-4 の手順番号と参加キャラ */
  battle?: { at: number; challenger: Side; battleCard?: string; participants?: Partial<Record<Side, string[]>> }
}

/** 操作の列。force は状況を作るだけの出来事（DSL の Op をそのまま使う） */
export type Step =
  | { declare: { by: Side; source: string; ability?: string; targets?: string[] } }
  | { pass: Side }
  | { choose: { by: Side; pick: string[] | string } }
  | { answer: { by: Side; accept: boolean } }
  | { challenge: { by: Side; participant: string; battleCard?: string } }
  | { force: Op }

/** FAQ の答えに書いてある結果だけ */
export type Expect =
  | { kiryoku: [ref: string, value: number] }
  | { zone: [ref: string, zone: 'field' | 'hand' | 'trash' | 'deck' | 'gone'] }
  | { ready: [ref: string, ready: boolean] }
  | { stat: [ref: string, attr: Attr, value: number] }
  | { downs: [side: Side, value: number] }
  | { result: 'youWin' | 'opponentWins' | 'draw' | 'continues' }
  /** steps の index 番目の操作がルール違反（今は警告）になる */
  | { illegal: { step: number; reason?: string } }
  /** steps の index 番目の操作が合法 */
  | { legal: { step: number } }
  /** 処理された順（ログに出る処理の名前の並び） */
  | { order: string[] }
  | { battleAborted: boolean }
  /** 型で書けない期待（実行器は「保留」と数える。増えたら型を足す） */
  | { note: string }

export interface FaqCase {
  id: string                   // 'faq-1800'
  faq: string                  // 'oldfaq.txt:1800-1801'
  date?: string                // FAQ の日付（新しい裁定が古い裁定を上書きするので要る）
  quote: { q: string; a: string } // 逐語
  /** 問答に出てくるすべてのカード。本文を読み合わせた要点を書く（H-1 の教訓・必須） */
  cards: { id: string; name: string; inPool: boolean; gist: string }[]
  /** 登場カードの本文から復元した状況 */
  reading: string
  grade: FaqGrade
  concepts?: (Mechanism | string)[]
  holes?: HoleId[]
  whyNot?: string              // grade が N・outOfPool のとき
  /** 他の FAQ と食い違う・上書きされる場合 */
  related?: string[]
  setup?: BoardSpec
  steps?: Step[]
  expect?: Expect[]
}
