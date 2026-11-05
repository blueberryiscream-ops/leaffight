// 使用権（14-4・K8）: 持ち主（owner）と別のプレイヤーがキャラを使用しているときの扱い。core はカード知識ゼロ（夕霧・妖刀の知識は engine/cards 側）。
import type { BoardState, CardInstance, Result, Seat } from './board'

/** キャラを使用しているプレイヤー（使用権が移っていなければ持ち主）。場を離れたら controller は消える（board.moveCard） */
export function userOf(c: CardInstance): Seat {
  return c.controller ?? c.owner
}

/** 使用権を seat に移す（null＝持ち主に戻す）。src＝使用権を与えているカード（妖刀。外れたら engine が戻す） */
export function setController(state: BoardState, args: { iid: string; seat: Seat | null; src?: string }): Result {
  const c = state.cards[args.iid]
  if (!c) return { state, log: '' }
  const { controller: _a, controllerSrc: _b, ...rest } = c
  void _a
  void _b
  // 9-1: リーダーの使用権が持ち主以外に移ると、持ち主のフィールドからリーダーがいなくなる＝持ち主の負け（夕霧のおでかけ FAQ:2383）
  const lostLeader = c.zone === 'leader' && args.seat !== null && args.seat !== c.owner && !state.result
  const next: CardInstance = { ...rest, ...(args.seat ? { controller: args.seat } : {}), ...(args.src ? { controllerSrc: args.src } : { controlAt: state.procMeta.seq }) }   // src の無い移動（おでかけ）は、それより前に掛かった層の使用権に勝つ（後から掛かった方 NH-42⑰）
  const res: Result['state'] = { ...state, cards: { ...state.cards, [c.iid]: next } }
  if (lostLeader) res.result = { winner: c.owner === 'A' ? 'B' : 'A', reason: 'リーダーがフィールドから失われた（9-1）' }
  return { state: res, log: `使用権: ${args.seat ?? c.owner}` }
}
