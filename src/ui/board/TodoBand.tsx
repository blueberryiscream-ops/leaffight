import type { ReactNode } from 'react'
import type { BoardAction } from '../../core/actions'
import { AT_LABELS, isActionAt, other } from '../../core/battle'
import type { BoardState, Seat } from '../../core/board'
import type { PoolCard } from '../../data/types'
import { autoBattleValues } from './battleValues'
import { canAct, clearableBattleMods, decideBlocked, nextActor, nextBlocked } from './BattlePanel'
import { priorityWindowInfo } from './priorityWindow'

// 大きな「今やること」帯（PHASE3d-3.md §5）。上部チロムの直下・盤面の上に全幅で置く。高さ固定。
// 🚨 誰の番かの判定と dispatch は StackPanel.tsx と同じもの（priorityWindow.ts）を使う。二重に書かない。
// 🚨 帯の主ボタンはバトルパネル／StackPanel と同じ action を dispatch するだけ（新しい遷移を作らない）。

type Tone = 'you' | 'wait' | 'idle'

function Band({ tone, text, children }: { tone: Tone; text: string; children?: ReactNode }) {
  const textClass = tone === 'you' ? 'text-accent' : tone === 'wait' ? 'text-ink-muted' : 'text-ink-muted'
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-line px-3">
      <span className={`truncate text-lg font-bold ${textClass}`}>{text}</span>
      {children}
    </div>
  )
}

/** 帯の「次へ」。バトルパネルの「次へ」と同じ advanceBattleStep を dispatch するだけ */
function NextButton({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="lf-btn-primary shrink-0 rounded px-3 py-1 text-sm disabled:opacity-30">
      次へ
    </button>
  )
}

export function TodoBand({
  board,
  localSeat,
  dispatch,
  cardOf,
  battleSelection,
}: {
  board: BoardState
  localSeat: Seat
  dispatch: (action: BoardAction) => void
  cardOf: (cardId: string) => PoolCard | undefined
  battleSelection: string[]
}) {
  const battle = board.battle
  const battlePrefix = battle ? `[${battle.at}] ${AT_LABELS[battle.at] ?? ''}：` : ''

  // 1. 優先権の窓が開いている（StackPanel.tsxと同じ判定・priorityWindow.ts経由）
  const info = priorityWindowInfo(board, cardOf)
  if (info) {
    if (info.awaiting !== null) {
      if (info.awaiting === localSeat) {
        return (
          <Band tone="you" text={`${battlePrefix}あなたの番：宣言するか「通す」`}>
            <button
              type="button"
              onClick={() => dispatch({ type: 'passPriority', by: localSeat })}
              className="lf-btn-primary shrink-0 rounded px-3 py-1 text-sm"
            >
              通す
            </button>
          </Band>
        )
      }
      return <Band tone="wait" text={`${battlePrefix}相手の応答待ち…`} />
    }
    if (info.resolving !== null) {
      if (info.resolving === localSeat) {
        return (
          <Band tone="you" text={`${battlePrefix}解決してください`}>
            <button
              type="button"
              onClick={() => dispatch({ type: 'resolveStep', to: info.resolveTo })}
              className="lf-btn-primary shrink-0 rounded px-3 py-1 text-sm"
            >
              解決（完了）
            </button>
          </Band>
        )
      }
      return <Band tone="wait" text={`${battlePrefix}相手が処理中…`} />
    }
  }

  // 2. バトル中で行動の点（priority===null）
  if (battle && board.priority === null && isActionAt(battle.at)) {
    const receiver = other(battle.challenger)

    if (battle.at === 7 || battle.at === 11) {
      const seat = battle.at === 7 ? battle.challenger : receiver
      if (!canAct(board, localSeat, seat)) return <Band tone="wait" text="相手が参加キャラを選んでいます" />
      return (
        <Band tone="you" text="盤面で参加キャラをクリック → 決定して次へ">
          <button
            type="button"
            disabled={decideBlocked(board, battle, seat, battleSelection)}
            onClick={() => {
              dispatch({ type: 'setBattleParticipants', seat, iids: battleSelection })
              dispatch({ type: 'advanceBattleStep' })
            }}
            className="lf-btn-primary shrink-0 rounded px-3 py-1 text-sm disabled:opacity-30"
          >
            決定して次へ
          </button>
        </Band>
      )
    }

    if (battle.at === 16) {
      if (!canAct(board, localSeat, battle.challenger)) return <Band tone="wait" text="相手が種目を選んでいます" />
      return (
        <Band tone="you" text="盤面で種目のバトルカードをクリック（選んだら「次へ」）">
          <NextButton disabled={nextBlocked(board, battle)} onClick={() => dispatch({ type: 'advanceBattleStep' })} />
        </Band>
      )
    }

    if (battle.at === 21) {
      if (!canAct(board, localSeat, battle.challenger)) return <Band tone="wait" text="相手の判断待ち…（[19]に戻るか、次へ）" />
      return <Band tone="you" text="[19]に戻るか、次へ（バトルパネルのボタンで）" />
    }

    if (battle.at === 18) {
      return (
        <Band tone="idle" text="攻防能力値を確認して次へ">
          <NextButton onClick={() => dispatch({ type: 'advanceBattleStep' })} />
        </Band>
      )
    }
    if (battle.at === 19 || battle.at === 20 || battle.at === 22) {
      return <Band tone="idle" text="攻防能力値を確認して次へ" />
    }

    if (battle.at === 23) {
      const auto = autoBattleValues(board, battle, cardOf)
      const atk = { A: battle.atk.A ?? auto.atk.A, B: battle.atk.B ?? auto.atk.B }
      const def = { A: battle.def.A ?? auto.def.A, B: battle.def.B ?? auto.def.B }
      const ready =
        typeof atk.A === 'number' && typeof atk.B === 'number' && typeof def.A === 'number' && typeof def.B === 'number'
      return (
        <Band tone={nextActor(battle) === null ? 'idle' : 'you'} text="攻防能力値を確認して次へ">
          <button
            type="button"
            disabled={!ready}
            onClick={() =>
              ready &&
              dispatch({
                type: 'decideBattleValues',
                atk: { A: atk.A as number, B: atk.B as number },
                def: { A: def.A as number, B: def.B as number },
              })
            }
            className="lf-btn-primary shrink-0 rounded px-3 py-1 text-sm disabled:opacity-30"
          >
            決定して次へ
          </button>
        </Band>
      )
    }

    if (battle.at === 26) {
      return <Band tone="idle" text="ダメージを確認して適用（バトルパネルの確認表で）" />
    }

    if (battle.at === 28) {
      const count = clearableBattleMods(board)
      const label = count > 0 ? `攻防修正 ${count} 件を消して次へ` : '次へ'
      return (
        <Band tone="idle" text={label}>
          <button
            type="button"
            onClick={() => dispatch({ type: 'advanceBattleStep' })}
            className="lf-btn-primary shrink-0 rounded px-3 py-1 text-sm"
          >
            {label}
          </button>
        </Band>
      )
    }
  }

  // 3. それ以外
  return <Band tone="idle" text="自由に操作できます" />
}
