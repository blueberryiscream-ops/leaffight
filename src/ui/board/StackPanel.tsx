import { useEffect, useRef, useState } from 'react'
import type { BoardAction } from '../../core/actions'
import type { BoardState, Seat } from '../../core/board'
import type { PriorityState } from '../../core/priority'

// スタック処理中置き場（DESIGN.md §5.1 / §4.19）。レイアウトA/Bの両方から同じものを呼ぶ
// （StackedCardSlotと同じ「独立コンポーネントをA/B両方から呼ぶ」方針。PHASE3a-2a.md §2-1）。
// このコンポーネントは `priority` を読んでアクションを投げるだけ。合法性判定・効果解決はしない
// （coreがすでにそれをやらない設計なので、UIも踏み込まない）。

export function StackPanel({
  board,
  localSeat,
  dispatch,
}: {
  board: BoardState
  /** 「自分が応答待ちか」の表示判定にのみ使う。共有状態(priority)には混ぜない（PHASE3a-2a.md §1） */
  localSeat: Seat
  dispatch: (action: BoardAction) => void
}) {
  // 自動パスは個人の操作設定（相手を信頼して自動で通す）であり、共有状態ではない。
  // クライアントローカルのuseStateで持つ（DESIGN.md §4.19「相手を信頼して自動で通す個人トグル」）。
  const [autoPass, setAutoPass] = useState(false)

  // 自動オフ判定と自動パス本体は1つのeffectにまとめる。分けると、バトル宣言が積まれた
  // 「その瞬間」の自動パス発火を止められない（setAutoPass(false)は次のレンダーまで反映されず、
  // 同じコミット内の別effectはこのレンダーの古いautoPass値を見るため）。1つのeffect内で
  // 「新しく積まれた最上段がバトル宣言なら、今回はパスせずオフにして抜ける」を先に判定する
  // （暴発防止の第一版。完全なフェイズ連動オフはP4。PHASE3a-2a.md §2-3）。
  const lastTopIdRef = useRef<string | null>(null)
  const autoPassHandledRef = useRef<PriorityState | null>(null)
  useEffect(() => {
    const p = board.priority
    const top = p?.stack[p.stack.length - 1]
    const topId = top?.id ?? null
    const isNewTop = topId !== lastTopIdRef.current
    if (isNewTop) lastTopIdRef.current = topId

    if (!autoPass || board.mode !== 'assist' || !p) return

    if (isNewTop && top?.kind === 'バトル') {
      setAutoPass(false)
      return
    }
    if (p.awaitingConsentFrom !== localSeat) return
    // 「1ゲートにつき1回」を priority オブジェクトの参照同一性で保証する
    // （coreは純粋関数なので、状態が進むたびに新しいオブジェクトが返る。同じ参照の間は連打しない）。
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
  // 末尾＝最上段。表示は最上段を先頭（目立つ位置）にする（PHASE3a-2a.md §2-1）
  const stackTopFirst = priority ? [...priority.stack].reverse() : []
  // priority は null だけでなく（旧盤面では）undefined もありうるので truthy 判定にする
  const isMyTurn = !!priority && priority.awaitingConsentFrom === localSeat
  const isTheirTurn = !!priority && priority.awaitingConsentFrom !== localSeat

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 rounded border border-slate-700 bg-slate-950/40 p-2 text-[10px]">
      <div className="flex shrink-0 items-center justify-between gap-1">
        <span className="font-semibold text-slate-300">スタック処理中置き場</span>
        <label className="flex shrink-0 items-center gap-1 text-slate-400">
          <input type="checkbox" checked={autoPass} onChange={(e) => setAutoPass(e.target.checked)} />
          自動パス
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {stackTopFirst.length === 0 ? (
          <p className="text-slate-600">（割り込みなし）</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {stackTopFirst.map((item, i) => (
              <li
                key={item.id}
                className={`rounded border px-1.5 py-1 ${
                  i === 0 ? 'border-sky-600 bg-sky-950/40 text-slate-200' : 'border-slate-700 bg-slate-900/60 text-slate-400'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span>{item.by === localSeat ? '自分' : '相手'} ・ {item.kind}</span>
                  {i === 0 && <span className="text-[9px] text-sky-400">最上段</span>}
                </div>
                <div className="truncate font-semibold">{item.label}</div>
                {item.detail && <div className="truncate text-slate-500">{item.detail}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {priority !== null && (
        <div className="shrink-0">
          {isMyTurn && (
            <button
              type="button"
              onClick={() => dispatch({ type: 'passPriority', by: localSeat })}
              className="w-full rounded border border-emerald-700 py-1 text-emerald-400 hover:bg-emerald-950"
            >
              通す（パス）
            </button>
          )}
          {isTheirTurn && <div className="text-center text-slate-500">相手の応答待ち…</div>}
        </div>
      )}
    </div>
  )
}
