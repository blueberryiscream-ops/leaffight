/*
 * エンジンが受け取るもの（引数）と、効果を評価する環境 — DESIGN.md §5.4・PHASE-R2a §2-4
 *
 * カードの記述（CardDef）とカードの印刷情報（pool.json の一部）は data 層が読んで渡す（engine は data を import しない）。
 */

import type { BoardState, CardInstance, Seat } from '../core/board'
import type { CardDef } from './dsl'
import { HOLES } from './holes'

/** pool.json の1枚のうちエンジンが使う欄（印刷された値） */
export interface CardInfo {
  id: string
  name: string
  kind: 'c' | 't' | 'b' | 'i' | 'e' | 'f'
  kiryoku: number | null
  stats: Record<string, number> | null
  /** 呼び出し／使用のコストアイコン（'WW' など） */
  cost: string
  /** 属性（'早根' など） */
  attr: string
  /** 能力の使用代償の元表記（E0 で分けたもの。'R＋気力－１' など） */
  abilities: { header: string; cost: string }[]
}

export interface EngineCtx {
  cards: Record<string, CardInfo>
  defs: Record<string, CardDef>
  holes?: typeof HOLES
  /** シャッフルの並び（乱数は呼び出し側が持つ）。無ければ今の並びのまま（ログに警告） */
  shuffle?: (iids: string[]) => string[]
}

/** 効果を評価する環境（能力1回ぶん） */
export interface Env {
  /** この能力を持つカード（イベントはそのカード） */
  self: string | null
  /** 使用権を持つプレイヤー（14-4） */
  you: Seat
  /** 選択の結果（slot → iid の列。選択肢の名前のときは文字列） */
  slots: Record<string, string[]>
  /** 《〜とき》のタイミングを作った手順（ダメージ・ダウン・特殊能力・イベント）のフレーム id */
  trigger: string | null
  /** この効果の宣言の id（宣言した行動のとき） */
  declId: string | null
  /** 宣言した時点の状態（「宣言した時点で消耗状態ならば」FAQ:2298・3097） */
  declared: Record<string, 'ready' | 'rested'>
  it?: string
}

export function other(seat: Seat): Seat {
  return seat === 'A' ? 'B' : 'A'
}

export function infoOf(ctx: EngineCtx, state: BoardState, iid: string): CardInfo | undefined {
  const c = state.cards[iid]
  return c ? ctx.cards[c.cardId] : undefined
}

/** キャラ（フィールドのキャラクター・タッグ。アイテムとして付いているものは除く） */
export function isCharOnField(c: CardInstance | undefined): c is CardInstance {
  return !!c && (c.zone === 'char' || c.zone === 'leader') && c.attachedTo === null
}

/** 使用権を持つプレイヤー。R2a は持ち主（使用権の移動 K8 は後）。付いているアイテムは付いているキャラの使用者 */
export function controllerOf(state: BoardState, iid: string): Seat | null {
  const c = state.cards[iid]
  if (!c) return null
  if (c.attachedTo) return controllerOf(state, c.attachedTo)
  return c.owner
}

/** 気力の上限（リーダーは元×2・maxKiryokuFor と同じ） */
export function maxKiryoku(ctx: EngineCtx, state: BoardState, iid: string): number | null {
  const c = state.cards[iid]
  const info = c ? ctx.cards[c.cardId] : undefined
  if (!c || !info || info.kiryoku === null) return null
  return c.zone === 'leader' ? info.kiryoku * 2 : info.kiryoku
}

export function nameOf(ctx: EngineCtx, state: BoardState, iid: string): string {
  const c = state.cards[iid]
  return (c && ctx.cards[c.cardId]?.name) ?? c?.cardId ?? iid
}
