import { useEffect, useRef, useState } from 'react'
import type { BoardAction } from '../../core/actions'
import type { BoardState, Seat } from '../../core/board'
import { awaitingSeat, resolvingSeat, type ActionWindow, type DeclaredAction, type Priority } from '../../core/priority'
import type { InterruptCandidate } from '../../data/interrupt'
import type { InterruptsMap, PoolCard } from '../../data/types'
import { useInterruptNotices, type InterruptNotice } from './useInterruptNotices'
import { otherSeat } from './useBoard'

// 優先権パネル（DESIGN.md §5.1「2026-07-19 モデルの訂正」/ PHASE3a-1r.md §4）。
// 旧「縦長のスタック置き場」は撤回。基本2枠（自分の宣言／相手の宣言）＋現在のstepで
// 「通す」「解決」ボタンを出し分ける表示に作り直した。レイアウトA/Bの両方から同じものを呼ぶ
// （StackedCardSlotと同じ方針）。このコンポーネントは `priority` を読んでアクションを投げるだけ。
// 合法性判定・効果解決はしない（coreがすでにそれをやらない設計なので、UIも踏み込まない）。

function slotFor(current: ActionWindow, seat: Seat): DeclaredAction | null {
  if (current.active?.by === seat) return current.active
  if (current.nonActive?.by === seat) return current.nonActive
  return null
}

function ActionSlot({ label, action }: { label: string; action: DeclaredAction | null }) {
  return (
    <div className="min-h-0 flex-1 rounded border border-slate-700 bg-slate-900/60 p-1.5">
      <div className="mb-0.5 font-semibold text-slate-400">{label}</div>
      {action ? (
        <>
          <div className="text-slate-500">
            {action.kind} ・ {action.actionType}
          </div>
          <div className="truncate font-semibold text-slate-200">{action.label}</div>
          {action.detail && <div className="truncate text-slate-500">{action.detail}</div>}
        </>
      ) : (
        <p className="text-slate-600">（宣言なし）</p>
      )}
    </div>
  )
}

/**
 * 割り込み候補の通知（PHASE3c.md §4）。候補が1件以上ある側にだけ出る。
 * カード名クリック → 既存の declareAction（割込型）を発行し、通常の優先権フローに乗せる。
 * 合法性・追加条件は判定しない（候補を出すだけ。人間判断のフォールバック）。
 */
function InterruptBanner({
  notices,
  cardOf,
  onDeclare,
  onDismiss,
}: {
  notices: InterruptNotice[]
  cardOf: (cardId: string) => PoolCard | undefined
  onDeclare: (notice: InterruptNotice, candidate: InterruptCandidate) => void
  onDismiss: (id: string) => void
}) {
  if (notices.length === 0) return null
  return (
    <div className="flex shrink-0 flex-col gap-1">
      {notices.map((n) => (
        <div key={n.id} className="rounded border border-amber-600 bg-amber-950/40 p-1.5">
          <div className="flex items-start justify-between gap-1">
            <span className="text-amber-300">
              《{n.timing}》— 割り込める札があります
            </span>
            <button type="button" onClick={() => onDismiss(n.id)} className="shrink-0 text-slate-500 hover:text-slate-200">
              ✕
            </button>
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {n.candidates.map((c, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onDeclare(n, c)}
                className="rounded border border-sky-700 px-1.5 py-0.5 text-sky-400 hover:bg-sky-950"
              >
                {c.annotation.ability}（{cardOf(c.cardId)?.name ?? c.cardId}/{c.annotation.cost}）
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function StackPanel({
  board,
  localSeat,
  dispatch,
  cardOf,
  interrupts,
}: {
  board: BoardState
  /** 「自分が応答待ちか」の表示判定にのみ使う。共有状態(priority)には混ぜない（PHASE3a-2a.md §1） */
  localSeat: Seat
  dispatch: (action: BoardAction) => void
  cardOf: (cardId: string) => PoolCard | undefined
  interrupts: InterruptsMap
}) {
  const { notices, dismiss } = useInterruptNotices(board, localSeat, cardOf, interrupts)

  const declareInterrupt = (notice: InterruptNotice, candidate: InterruptCandidate) => {
    const kind = cardOf(candidate.cardId)?.kind === 'e' ? 'プレイ' : '能力'
    dispatch({
      type: 'declareAction',
      action: {
        by: localSeat,
        sourceIid: candidate.cardIid,
        kind,
        actionType: '割込型',
        label: candidate.annotation.ability,
        detail: candidate.annotation.cost,
      },
    })
    dismiss(notice.id)
  }

  // 自動パスは個人の操作設定（相手を信頼して自動で通す）であり、共有状態ではない。
  // クライアントローカルのuseStateで持つ（DESIGN.md §4.19「相手を信頼して自動で通す個人トグル」）。
  const [autoPass, setAutoPass] = useState(false)

  // 「1ゲートにつき1回」を priority オブジェクトの参照同一性で保証する
  // （coreは純粋関数なので、状態が進むたびに新しいオブジェクトが返る。同じ参照の間は連打しない）。
  const autoPassHandledRef = useRef<Priority | null>(null)

  useEffect(() => {
    const p = board.priority
    if (!p) return
    const current = p.frames[p.frames.length - 1]
    // 現在の窓にバトル宣言があれば、暴発防止のため自動パスを自動オフにする（PHASE3a-2a §2-3の踏襲。
    // 新モデルではLIFOの「最上段」でなく「現在の窓」に置き換わる）。resolveStepは自動化しない
    const hasBattle = !!current && (current.active?.kind === 'バトル' || current.nonActive?.kind === 'バトル')

    if (!autoPass || board.mode !== 'assist') return

    if (hasBattle) {
      setAutoPass(false)
      return
    }

    const seat = awaitingSeat(p)
    if (seat !== localSeat) return
    if (autoPassHandledRef.current === p) return
    autoPassHandledRef.current = p
    dispatch({ type: 'passPriority', by: localSeat })
  }, [autoPass, board.mode, board.priority, localSeat, dispatch])

  if (board.mode === 'free') {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-1 rounded border border-dashed border-slate-700 bg-slate-950/30 p-2 text-center text-[10px] text-slate-600">
        フリーモード中
        <br />
        （優先権オフ）
      </div>
    )
  }

  const priority = board.priority

  if (!priority) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-1.5 rounded border border-slate-700 bg-slate-950/40 p-2 text-[10px]">
        <div className="flex shrink-0 items-center justify-between gap-1">
          <span className="font-semibold text-slate-300">優先権</span>
          <label className="flex shrink-0 items-center gap-1 text-slate-400">
            <input type="checkbox" checked={autoPass} onChange={(e) => setAutoPass(e.target.checked)} />
            自動パス
          </label>
        </div>
        <InterruptBanner notices={notices} cardOf={cardOf} onDeclare={declareInterrupt} onDismiss={dismiss} />
        <div className="flex flex-1 items-center justify-center text-slate-600">（割り込みなし）</div>
      </div>
    )
  }

  const current = priority.frames[priority.frames.length - 1]
  const depth = priority.frames.length
  const mine = slotFor(current, localSeat)
  const theirs = slotFor(current, otherSeat(localSeat))
  const awaiting = awaitingSeat(priority)
  const resolving = resolvingSeat(priority)

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 rounded border border-slate-700 bg-slate-950/40 p-2 text-[10px]">
      <div className="flex shrink-0 items-center justify-between gap-1">
        <span className="font-semibold text-slate-300">優先権</span>
        <label className="flex shrink-0 items-center gap-1 text-slate-400">
          <input type="checkbox" checked={autoPass} onChange={(e) => setAutoPass(e.target.checked)} />
          自動パス
        </label>
      </div>

      {depth > 1 && (
        <div className="shrink-0 rounded border border-amber-700 bg-amber-950/30 px-1.5 py-0.5 text-center text-amber-400">
          割り込み処理中（{depth}段）
        </div>
      )}

      <InterruptBanner notices={notices} cardOf={cardOf} onDeclare={declareInterrupt} onDismiss={dismiss} />

      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <ActionSlot label="自分の宣言" action={mine} />
        <ActionSlot label="相手の宣言" action={theirs} />
      </div>

      <div className="shrink-0">
        {awaiting !== null &&
          (awaiting === localSeat ? (
            <button
              type="button"
              onClick={() => dispatch({ type: 'passPriority', by: localSeat })}
              className="w-full rounded border border-emerald-700 py-1 text-emerald-400 hover:bg-emerald-950"
            >
              通す（パス）
            </button>
          ) : (
            <div className="text-center text-slate-500">相手の応答待ち…</div>
          ))}
        {resolving !== null &&
          (resolving === localSeat ? (
            <button
              type="button"
              onClick={() => dispatch({ type: 'resolveStep' })}
              className="w-full rounded border border-sky-700 py-1 text-sky-400 hover:bg-sky-950"
            >
              解決（完了）
            </button>
          ) : (
            <div className="text-center text-slate-500">相手が処理中…</div>
          ))}
      </div>
    </div>
  )
}
