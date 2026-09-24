// 攻防の自動入力（真の基本バトルカードだけ）。PHASE3d-3.md §2。
// 🚨 純関数・React を import しない（テストから直接呼ぶ）。ルールエンジンではない:
// 自動で入れてよい値は「真の基本バトルカードかつ各陣営の参加キャラがちょうど1体」のときだけ。
// それ以外は null を返す（＝人が入れる）。core にはカードの中身を持ち込まない
// （isBasicBattleCard/autoBattleValuesはui層。§0「core に data を import しない」を守るため）。

import type { Battle } from '../../core/battle'
import { effectiveStat, modifiersFor, type BoardState, type Seat } from '../../core/board'
import { ATTRS, type Attr } from '../../core/types'
import type { PoolCard } from '../../data/types'

/**
 * isBasicBattleCard: 真の基本バトルカードの判別（DESIGN.md §5.2・原典19-5 oldrule.txt:1042-1046）。
 * battleAtk/battleDef がともに 力/早/賢/根/感 の1文字 かつ abilities.length===0。
 * 標準プールで20種（統括がpool.jsonで実測・8月の照合表と件数一致）。
 */
export function isBasicBattleCard(card: Pick<PoolCard, 'battleAtk' | 'battleDef' | 'abilities'>): boolean {
  const isAttr = (s: string): s is Attr => (ATTRS as readonly string[]).includes(s)
  return isAttr(card.battleAtk) && isAttr(card.battleDef) && card.abilities.length === 0
}

/** その参加キャラに付いた攻防修正（kind==='攻防修正' かつ battleStat一致）の合計。scopeは問わない（バトル中は有効なため） */
export function battleStatModifierSum(board: BoardState, iid: string, stat: 'atk' | 'def'): number {
  return modifiersFor(board, iid)
    .filter((m) => m.kind === '攻防修正' && m.battleStat === stat)
    .reduce((sum, m) => sum + (m.delta ?? 0), 0)
}

export interface AutoBattleValues {
  atk: { A: number | null; B: number | null }
  def: { A: number | null; B: number | null }
}

const NONE: AutoBattleValues = { atk: { A: null, B: null }, def: { A: null, B: null } }

/**
 * autoBattleValues: 種目が基本バトルカード かつ その陣営の参加キャラがちょうど1体 かつ stats がある
 * ときだけ値を出す。それ以外は null（＝人が入れる）。攻撃能力値＝effectiveStat（能力値修正込み）＋攻防修正の合計。
 */
export function autoBattleValues(
  board: BoardState,
  battle: Battle,
  cardOf: (cardId: string) => PoolCard | undefined,
): AutoBattleValues {
  if (!battle.battleCardIid) return NONE
  const battleCardInst = board.cards[battle.battleCardIid]
  const battleCard = battleCardInst && cardOf(battleCardInst.cardId)
  if (!battleCard || !isBasicBattleCard(battleCard)) return NONE

  const atkAttr = battleCard.battleAtk as Attr
  const defAttr = battleCard.battleDef as Attr

  const valueFor = (seat: Seat, attr: Attr, stat: 'atk' | 'def'): number | null => {
    const participants = battle.participants[seat]
    if (participants.length !== 1) return null
    const iid = participants[0]
    const inst = board.cards[iid]
    const card = inst && cardOf(inst.cardId)
    if (!inst || !card?.stats) return null
    const base = effectiveStat(board, iid, card.stats[attr], attr)
    return base + battleStatModifierSum(board, iid, stat)
  }

  return {
    atk: { A: valueFor('A', atkAttr, 'atk'), B: valueFor('B', atkAttr, 'atk') },
    def: { A: valueFor('A', defAttr, 'def'), B: valueFor('B', defAttr, 'def') },
  }
}
