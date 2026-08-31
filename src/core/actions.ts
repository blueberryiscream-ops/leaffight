// 操作を1つのデータ型にまとめる。P2でネット越しに送る単位もこれになる想定
// （DESIGN.md §6「ゲストの操作は Action としてホストへ送信」）。
// ここでも乱数・時刻は持たない。呼び出し側が iid・並び順を決めて渡す。

import * as board from './board'
import type { BoardState, ModScope, Modifier, Orientation, Seat, ZoneId } from './board'
import * as priorityEngine from './priority'
import type { DeclaredAction, Mode, Priority } from './priority'

export type BoardAction =
  | { type: 'spawnCard'; iid: string; cardId: string; cardName: string; owner: Seat; zone: ZoneId }
  | { type: 'moveCard'; iid: string; toOwner?: Seat; toZone: ZoneId; toIndex?: number; cardName: string }
  | { type: 'setOrientation'; iid: string; orientation: Orientation; cardName: string }
  | { type: 'toggleOrientation'; iid: string; cardName: string }
  | { type: 'setKiryoku'; iid: string; value: number; cardName: string }
  | { type: 'adjustKiryoku'; iid: string; delta: number; max: number; cardName: string }
  | { type: 'setFaceUp'; iid: string; faceUp: boolean; cardName: string }
  | { type: 'flip'; iid: string; cardName: string }
  | { type: 'addModifier'; modifier: Modifier; cardName: string }
  | { type: 'removeModifier'; modId: string; cardName: string }
  | { type: 'clearModifiers'; iid: string; scope?: ModScope; cardName: string }
  | { type: 'attach'; itemIid: string; targetIid: string; itemName: string; targetName: string }
  | { type: 'detach'; itemIid: string; itemName: string }
  | { type: 'toTrash'; iid: string; cardName: string }
  | { type: 'removeCard'; iid: string; cardName: string }
  | { type: 'shuffleDeck'; owner: Seat; orderedIids: string[] }
  | { type: 'clearBoard' }
  | { type: 'declareAction'; action: DeclaredAction }
  | { type: 'passPriority'; by: Seat }
  | { type: 'resolveStep'; to?: ResolveDestination }
  | { type: 'setMode'; mode: Mode }

/**
 * 解決された宣言のカードを、どのゾーンへ送るか（PHASE3a-4.md §1-3）。
 * 🚨 core はカード種別を知らない。「イベントだからゴミ箱」という判断は ui 側（cardOf）が行い、
 * core が受け取るのは結果のゾーンだけ（P3c の cardKindOf と同じ流儀）。
 * 未指定（undefined）＝行き先がルールで一意に決まらない＝カードは pending に残し、人間が置く。
 */
export interface ResolveDestination {
  toOwner?: Seat
  toZone: ZoneId
  toIndex?: number
}

/**
 * 現在の窓で「今まさに解決される」DeclaredAction を取り出す（PHASE3a-3.md §2-4）。
 * resolvingSeat（priority.ts）と同じ判定だが、席ではなくaction本体を返す。
 * resolveStepが実際に適用される「前」のpriorityに対して呼ぶこと（適用後だと対象フレームが
 * 既にpop/進行済みで分からなくなる）。
 */
function resolvingAction(priority: Priority | null): DeclaredAction | null {
  if (!priority) return null
  const current = priority.frames[priority.frames.length - 1]
  if (!current) return null
  if (current.step === 'processActive') return current.active
  if (current.step === 'processNonActive') return current.nonActive
  return null
}

export function applyAction(state: BoardState, action: BoardAction): board.Result {
  switch (action.type) {
    case 'spawnCard':
      return board.spawnCard(state, action)
    case 'moveCard':
      return board.moveCard(state, action)
    case 'setOrientation':
      return board.setOrientation(state, action)
    case 'toggleOrientation':
      return board.toggleOrientation(state, action)
    case 'setKiryoku':
      return board.setKiryoku(state, action)
    case 'adjustKiryoku':
      return board.adjustKiryoku(state, action)
    case 'setFaceUp':
      return board.setFaceUp(state, action)
    case 'flip':
      return board.flip(state, action)
    case 'addModifier':
      return board.addModifier(state, action)
    case 'removeModifier':
      return board.removeModifier(state, action)
    case 'clearModifiers':
      return board.clearModifiers(state, action)
    case 'attach':
      return board.attach(state, action)
    case 'detach':
      return board.detach(state, action)
    case 'toTrash':
      return board.toTrash(state, action)
    case 'removeCard':
      return board.removeCard(state, action)
    case 'shuffleDeck':
      return board.shuffleDeck(state, action)
    case 'clearBoard':
      return board.clearBoard()
    case 'declareAction': {
      const { priority, log } = priorityEngine.declareAction(state.priority, action.action)
      // 🚨 engineに弾かれた宣言（不正な手番等）はlogが空文字で返る。このときstateを一切変えず
      // 返す（カードは動かさない）。逆順（先にカードを動かしてから受理判定）にすると、
      // 弾かれた宣言でもカードが手札から消えてしまう（PHASE3a-3.md §2-4）。
      if (!log) return { state, log: '' }

      let next: BoardState = { ...state, priority }
      // 手札から「プレイ」を宣言したカードは提示エリア(pending)へ上げる。提示した時点で
      // 使用したと見なされる（oldrule.txt:828）ので手札には残さない。
      // 🚨 判定材料はゾーン（core の知識）と宣言の種別だけ。カード種別は見ない。
      // 盤面のカードの起動型能力（kind:'能力'）や、既に場に出ている札は動かさない。
      const src = action.action.sourceIid ? state.cards[action.action.sourceIid] : undefined
      if (action.action.kind === 'プレイ' && src && src.zone === 'hand') {
        const moved = board.moveCard(next, {
          iid: src.iid,
          toOwner: src.owner,
          toZone: 'pending',
          cardName: action.action.label,
        })
        next = moved.state
      }
      return { state: next, log }
    }
    case 'passPriority': {
      const { priority, log } = priorityEngine.passPriority(state.priority, action.by)
      return { state: { ...state, priority }, log }
    }
    case 'resolveStep': {
      // 解決される対象は「適用前」のpriorityから取り出す（適用後は既にpop/進行済みで分からない）
      const resolved = resolvingAction(state.priority)
      const { priority, log } = priorityEngine.resolveStep(state.priority)
      if (!log) return { state, log: '' }

      let next: BoardState = { ...state, priority }
      let moveLog = ''
      // 行き先が指定されているものだけ自動で送る（PHASE3a-4.md §1-3）。指定が無ければ
      // カードは提示エリアに残り、人間がドラッグで置く（キャラ/タッグ/アイテム/バトル）。
      if (action.to && resolved?.sourceIid) {
        const card = next.cards[resolved.sourceIid]
        if (card && card.zone === 'pending') {
          // フィールドの入れ替え（旧カードのゴミ箱送り・oldrule.txt:935）は core/board.ts の
          // moveCard 側で行う。P3a-4 ではここで先回りしていたが、moveCard 本体を原典どおりに
          // 訂正したため不要になった（2026-08-06）。
          const moved = board.moveCard(next, {
            iid: resolved.sourceIid,
            toOwner: action.to.toOwner,
            toZone: action.to.toZone,
            toIndex: action.to.toIndex,
            cardName: resolved.label,
          })
          next = moved.state
          moveLog = moved.log
        }
      }
      return { state: next, log: moveLog ? `${log}／${moveLog}` : log }
    }
    case 'setMode': {
      const { priority, mode, log } = priorityEngine.setMode(state.priority, action.mode)
      let next: BoardState = { ...state, priority, mode }
      // 🚨 freeに切り替えると優先権UI（StackPanel＝提示エリアの描画場所）ごと消えるため、
      // pendingに残ったカードは行き場を失って盤面から見えなくなる。free化のタイミングで
      // pendingのカードを全て持ち主の手札に戻す（PHASE3a-3.md §2-4「見落とし厳禁」・
      // PHASE3a-4.md §1-5でも「この処理は残す」と明示されている）。
      if (action.mode === 'free') {
        for (const card of Object.values(state.cards)) {
          if (card.zone !== 'pending') continue
          const moved = board.moveCard(next, { iid: card.iid, toOwner: card.owner, toZone: 'hand', cardName: card.cardId })
          next = moved.state
        }
      }
      return { state: next, log }
    }
  }
}
