// 操作を1つのデータ型にまとめる。P2でネット越しに送る単位もこれになる想定
// （DESIGN.md §6「ゲストの操作は Action としてホストへ送信」）。
// ここでも乱数・時刻は持たない。呼び出し側が iid・並び順を決めて渡す。

import * as battleEngine from './battle'
import * as battleFlow from './battleFlow'
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
  | { type: 'declareBattle'; challenger: Seat }
  | { type: 'advanceBattleStep' }
  | { type: 'setBattleParticipants'; seat: Seat; iids: string[] }
  | { type: 'autoAssignBattleLeader'; seat: Seat }
  | { type: 'forceAutoLeaderBattle'; seat: Seat }
  | { type: 'setBattleCard'; iid: string; cardName?: string }
  | { type: 'setBattleValue'; seat: Seat; stat: 'atk' | 'def'; value: number }
  | { type: 'loopBackBattle' }
  | { type: 'applyBattleDamage'; damages: battleEngine.DamageInput[] }
  | { type: 'abortBattle'; reason: string }

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

/**
 * applyAction: 全アクションの入口。既存の switch（applyActionCore）を実行した後、必ず
 * battleFlow.afterAction を通す（PHASE3d-2a §2-2「applyAction の最後で呼ぶ後処理」）。
 * battle が無ければ afterAction はほぼ何もしない（既存のテスト・通信経路への非回帰）。
 */
export function applyAction(state: BoardState, action: BoardAction): board.Result {
  const core = applyActionCore(state, action)
  const flow = battleFlow.afterAction(state, core.state, action)
  if (!flow.log) return core
  return { state: flow.state, log: core.log ? `${core.log}／${flow.log}` : flow.log }
}

function applyActionCore(state: BoardState, action: BoardAction): board.Result {
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
    case 'declareBattle': {
      // 🚨 受理条件（20-3・battle===null・priority===null）は canDeclareBattle が判定する
      // （PHASE3d-2a §6）。満たさなければ log 空で state 不変。
      const reason = battleEngine.canDeclareBattle(state, action.challenger)
      if (reason) return { state, log: '' }
      const { battle, log } = battleEngine.declareBattle(action.challenger)
      return { state: { ...state, battle }, log }
    }
    case 'advanceBattleStep': {
      if (!state.battle) return { state, log: '' }
      // assist では行動の点でだけ有効。かつ priority===null（宣言が処理中なら進めない）。
      // free では at の種類を問わず1つずつ進める（PHASE3d-2a §2-3）。
      if (state.mode === 'assist' && (!battleEngine.isActionAt(state.battle.at) || state.priority !== null)) {
        return { state, log: '' }
      }
      // at=28 を出る: 中断していれば at=29 へ行かず battle=null（20-6-1 oldrule.txt:1138-1139）
      if (state.battle.at === 28 && state.battle.aborted) {
        return { state: { ...state, battle: null }, log: 'バトル終了（中断のため[29]は行わない・20-6-1）' }
      }
      // at=29 を出る（freeのみ到達。assistでは窓なので上で弾かれ、窓が閉じたらbattleFlowが終える）
      if (state.battle.at === 29) {
        return { state: { ...state, battle: null }, log: 'バトル終了' }
      }

      let working = state
      let preLog = ''
      // at=11 を出る前提: participants[挑まれた側] が空なら、先に autoAssignLeader を試す（PHASE3d-2a §3）
      if (working.battle && working.battle.at === 11) {
        const receiver = battleEngine.other(working.battle.challenger)
        if (working.battle.participants[receiver].length === 0) {
          const auto = battleEngine.autoAssignLeader(working, working.battle, receiver)
          if (auto.log) {
            working = { ...auto.state, battle: auto.battle }
            preLog = auto.log
          }
        }
      }

      const { battle, log } = battleEngine.advanceStep(working.battle!)
      if (!log) return { state: preLog ? working : state, log: preLog }
      return { state: { ...working, battle }, log: preLog ? `${preLog}／${log}` : log }
    }
    case 'setBattleParticipants': {
      if (!state.battle) return { state, log: '' }
      // 待機（ready）のものを消耗（rested）にする（20-4[7][11] oldrule.txt:1075-1076,1084-1085）。
      // 「1タップで戻す」は既存の setOrientation で足りる（PHASE3d-2a §3）。
      let working = state
      const restLogs: string[] = []
      for (const iid of action.iids) {
        const c = working.cards[iid]
        if (c && c.orientation === 'ready') {
          const rested = board.setOrientation(working, { iid, orientation: 'rested', cardName: c.cardId })
          working = rested.state
          if (rested.log) restLogs.push(rested.log)
        }
      }
      const { battle, log } = battleEngine.setParticipants(working.battle!, action.seat, action.iids)
      return { state: { ...working, battle }, log: restLogs.length ? `${log}／${restLogs.join('／')}` : log }
    }
    case 'autoAssignBattleLeader': {
      if (!state.battle) return { state, log: '' }
      const result = battleEngine.autoAssignLeader(state, state.battle, action.seat)
      if (!result.log) return { state, log: '' }
      return { state: { ...result.state, battle: result.battle }, log: result.log }
    }
    case 'forceAutoLeaderBattle': {
      if (!state.battle) return { state, log: '' }
      const result = battleEngine.forceAutoLeader(state, state.battle, action.seat)
      if (!result.log) return { state, log: '' }
      return { state: { ...result.state, battle: result.battle }, log: result.log }
    }
    case 'setBattleCard': {
      if (!state.battle) return { state, log: '' }
      const result = battleEngine.setBattleCard(state, state.battle, action.iid, action.cardName)
      if (!result.log) return { state, log: '' }
      return { state: { ...result.state, battle: result.battle }, log: result.log }
    }
    case 'setBattleValue': {
      if (!state.battle) return { state, log: '' }
      const { battle, log } = battleEngine.setValue(state.battle, action.seat, action.stat, action.value)
      return { state: { ...state, battle }, log }
    }
    case 'loopBackBattle': {
      if (!state.battle) return { state, log: '' }
      const { battle, log } = battleEngine.loopBack(state.battle)
      if (!log) return { state, log: '' }
      return { state: { ...state, battle }, log }
    }
    case 'applyBattleDamage': {
      if (!state.battle) return { state, log: '' }
      const result = battleEngine.applyDamage(state, state.battle, action.damages)
      if (!result.log) return { state, log: '' }
      return { state: { ...result.state, battle: result.battle }, log: result.log }
    }
    case 'abortBattle': {
      if (!state.battle) return { state, log: '' }
      const { battle, log } = battleEngine.abortBattle(state.battle, action.reason)
      return { state: { ...state, battle }, log }
    }
  }
}
