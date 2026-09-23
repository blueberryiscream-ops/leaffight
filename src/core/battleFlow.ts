// バトルを優先権の窓につなぐ自動進行（core専用）。PHASE3d-2a.md §2・§5。
// applyAction の最後で毎回呼ぶ後処理。窓の開閉・at の自動前進・中断の自動検出だけを行う
// （効果の解決・合法性判定はしない＝DESIGN §5「あえて作らない」）。乱数・時刻は持たない。
//
// 不変条件（PHASE3d-2a §2-2）: mode==='assist' で battle があり、at が窓の点なら、
// priority !== null（窓が開いている）。この関数はその不変条件を保つように state を補正する。

import * as battleEngine from './battle'
import * as priorityEngine from './priority'
import type { BoardAction } from './actions'
import type { BoardState, Result } from './board'

/** 現在の battle.at の窓を開く（activePlayer=挑んだ側・at=2だけ nonActiveOnly）。PHASE3d-2a §2-1 */
function openBattleWindow(state: BoardState, battle: battleEngine.Battle): BoardState {
  const opened = priorityEngine.openWindow(state.priority, battle.challenger, { nonActiveOnly: battle.at === 2 })
  if (!opened.log) return state
  return { ...state, priority: opened.priority }
}

/**
 * afterAction: applyAction の最後で呼ぶ後処理（PHASE3d-2a §2-2 / §5）。
 * 🚨 free への切り替えは setMode が priority を null にする。これを「窓が閉じた」と誤認して
 *   進めないよう、窓の開閉/自動前進は after.mode==='assist' のときだけ行う（§2-2の3）。
 * 🚨 中断の自動検出（§5）はモードを問わず行う（20-6の即時中断はfreeでも起こりうる）。
 */
export function afterAction(before: BoardState, after: BoardState, _action: BoardAction): Result {
  let state = after
  let log = ''

  if (state.mode === 'assist' && state.battle) {
    const battle = state.battle
    const windowJustClosed = before.priority !== null && state.priority === null && battleEngine.isWindowAt(battle.at)

    if (windowJustClosed) {
      // before.priority は必ず frames.length===1（末端フレームがpopされてnullになった＝ルート窓が閉じた）
      const rootFrame = before.priority!.frames[0]
      const hadDeclaration = !!(rootFrame && (rootFrame.active || rootFrame.nonActive))

      if (battleEngine.REPEATING_WINDOW_ATS.includes(battle.at) && hadDeclaration) {
        // [19][20][22]: 宣言があった＝複数回使用できる機会（20-4[19][20][22]）。同じ点を開き直す
        state = openBattleWindow(state, battle)
        log = `バトル: [${battle.at}] の窓を開き直す（複数回使用の機会）`
      } else if (battle.at === 29) {
        // at=29の窓が閉じた → バトル終了
        state = { ...state, battle: null }
        log = 'バトル終了'
      } else {
        const next = battleEngine.nextAt(battle.at)
        if (next !== null) {
          const advanced: battleEngine.Battle = { ...battle, at: next, step: battleEngine.stepForAt(next) }
          state = { ...state, battle: advanced }
          log = `バトル: [${battle.at}] → [${next}]`
          if (battleEngine.isWindowAt(next)) {
            state = openBattleWindow(state, advanced)
            log += `／[${next}] の窓を開く`
          }
        }
      }
    } else if (state.priority === null && battleEngine.isWindowAt(battle.at)) {
      // assistなのに窓の点で窓が無い（例: freeからassistに戻した直後・declareBattle直後・
      // applyDamageでat=27に進んだ直後・loopBackでat=19に戻った直後）→ その点の窓を開く
      state = openBattleWindow(state, battle)
      log = `バトル: [${battle.at}] の窓を開く`
    }
  }

  // 中断の自動検出（PHASE3d-2a §5）。モードを問わず行う。after.battle を渡す
  // （同じアクションで resultDowned が更新された場合も正しく除外されるように）。
  if (state.battle && !state.battle.aborted) {
    const reason = battleEngine.detectAbort(before, state, state.battle)
    if (reason) {
      const aborted = battleEngine.abortBattle(state.battle, reason)
      state = { ...state, battle: aborted.battle }
      log = log ? `${log}／${aborted.log}` : aborted.log
    }
  }

  return { state, log }
}
