/*
 * エンジンモードの帯（PHASE-R2u §3-2・§3-3・§2 の決定）— R2u-1 の途中版
 *
 * ターン・AP・フェイズ・発生済みのコスト／エンジン⇄手動の切り替え／鳴き無しボタン（自動見送り）／
 * 宣言の番の帯（見送る・宣言できるもの・フェイズを進める）／選択の帯／結果・警告の帯／直近の段。
 * 🚨 合法かどうかは declare（legalDeclarations）の答えだけを使う。非公開のカードの名前は出さない。
 */

import { useEffect, useMemo, useState } from 'react'
import type { BoardAction } from '../../core/actions'
import { isPublicCard, type BoardState, type Seat } from '../../core/board'
import { awaitingSeat, currentWindow, topFrame } from '../../core/proc'
import type { EngineCtx } from '../../engine/ctx'
import type { EngineReq, PublicStep } from '../../net/session'
import { legalDeclarations, shouldAutoPass } from './host'

type AutoPass = 'now' | 'wait'
const AUTO_PASS_KEY = 'lf.autoPass'
/** §2-2「待つ」の間（約1.5秒） */
const WAIT_MS = 1500

function readAutoPass(): AutoPass {
  try {
    return localStorage.getItem(AUTO_PASS_KEY) === 'wait' ? 'wait' : 'now'
  } catch {
    return 'now'
  }
}

export function EngineBar({
  board,
  localSeat,
  ctx,
  nameOf,
  engineRequest,
  dispatch,
  steps,
  notice,
  clearNotice,
}: {
  board: BoardState
  localSeat: Seat
  ctx: EngineCtx | null
  nameOf: (cardId: string) => string
  engineRequest: (req: EngineReq) => void
  dispatch: (a: BoardAction) => void
  steps: { n: number; steps: PublicStep[] }
  notice: { reason: string; missingDef?: boolean; warnings?: string[] } | null
  clearNotice: () => void
}) {
  // 自動見送りの設定はこのクライアントだけ（localStorage。共有状態に入れない PHASE-R2u §1）
  const [autoPass, setAutoPass] = useState<AutoPass>(readAutoPass)
  const toggleAutoPass = () => {
    const next: AutoPass = autoPass === 'now' ? 'wait' : 'now'
    setAutoPass(next)
    try {
      localStorage.setItem(AUTO_PASS_KEY, next)
    } catch {
      /* 保存できなくても動く */
    }
  }
  const [pick, setPick] = useState<string[]>([])
  const engineOn = board.mode === 'engine'
  const ch = board.procMeta.choice
  const win = currentWindow(board)
  const waiting = awaitingSeat(board)
  const top = topFrame(board)

  const legal = useMemo(() => (engineOn && ctx ? legalDeclarations(board, ctx, localSeat) : []), [engineOn, ctx, board, localSeat])

  // §2-2 自動見送り: 宣言できるものが1つも無ければ止まらない（即／約1.5秒）
  useEffect(() => {
    if (!engineOn || !ctx || !shouldAutoPass(board, ctx, localSeat)) return
    const t = window.setTimeout(() => engineRequest({ kind: 'pass', by: localSeat }), autoPass === 'now' ? 0 : WAIT_MS)
    return () => window.clearTimeout(t)
  }, [engineOn, ctx, board, localSeat, autoPass, engineRequest])

  useEffect(() => setPick([]), [ch?.id])

  /** 選択肢の表示名: カードなら公開か自分のカードのときだけ名前（非公開は伏せる） */
  const optionLabel = (key: string, label: string) => {
    const c = board.cards[key]
    if (!c) return label
    return isPublicCard(c) || c.owner === localSeat ? nameOf(c.cardId) : '（非公開のカード）'
  }
  const stepText = (s: PublicStep) => {
    const names = s.iids.map((iid) => {
      const c = board.cards[iid]
      return c && (isPublicCard(c) || c.owner === localSeat) ? nameOf(c.cardId) : '＊'
    })
    return [s.text, ...names].filter(Boolean).join(' ')
  }

  const btn = 'lf-btn-primary shrink-0 rounded px-2 py-0.5 text-xs disabled:opacity-30'
  const turn = board.turn

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-line bg-surface-1 px-3 py-1 text-xs text-ink">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold text-accent">
          {turn ? `ターン ${turn.n ?? '?'}・AP ${turn.active}・${turn.phase}フェイズ` : 'ターン未開始'}
        </span>
        <span className="text-ink-muted">コスト A:{board.costs.A.length} B:{board.costs.B.length}</span>
        {top && <span className="text-ink-muted">手順: {top.label ?? top.kind}[{top.step}]</span>}
        <span className="flex-1" />
        <button type="button" className={btn} onClick={() => dispatch({ type: 'setMode', mode: engineOn ? 'free' : 'engine' })}>
          {engineOn ? 'エンジン' : '手動'} ⇄
        </button>
        {/* 麻雀の「鳴き無し」ボタン（§2-2）。対戦中いつでも切り替えられる */}
        <button type="button" className={btn} onClick={toggleAutoPass} title="宣言できるものが無いとき">
          見送り: {autoPass === 'now' ? '即' : '待つ'}
        </button>
      </div>

      {engineOn && !turn && (
        <div className="flex items-center gap-2">
          <span>開始準備が済んだら:</span>
          <button type="button" className={btn} onClick={() => engineRequest({ kind: 'start', by: localSeat, first: localSeat })}>
            自分が先攻で始める
          </button>
        </div>
      )}

      {engineOn && board.result && (
        <div className="font-bold text-warn">
          結果: {board.result.winner === null ? '引き分け' : `勝者 ${board.result.winner}`}（{board.result.reason}）
        </div>
      )}

      {engineOn && ch && (
        <div className="flex flex-wrap items-center gap-1">
          {ch.by === localSeat ? (
            <>
              <span className="font-bold">{ch.prompt}</span>
              {ch.options.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  className={`${btn} ${pick.includes(o.key) ? 'ring-2 ring-warn' : ''}`}
                  onClick={() => setPick((p) => (ch.repeat ? [...p, o.key] : p.includes(o.key) ? p.filter((k) => k !== o.key) : [...p, o.key]))}
                >
                  {optionLabel(o.key, o.label)}
                </button>
              ))}
              <button type="button" className={btn} onClick={() => engineRequest({ kind: 'choose', by: localSeat, id: ch.id, pick })}>
                決定（{pick.length}）
              </button>
            </>
          ) : (
            <span className="text-ink-muted">相手が選んでいます</span>
          )}
        </div>
      )}

      {engineOn && !ch && win && (
        <div className="flex flex-wrap items-center gap-1">
          {waiting === localSeat ? (
            <>
              <span className="font-bold">宣言の機会{win.frame ? `（${win.frame.label ?? win.frame.kind}）` : '（メイン）'}</span>
              {legal.map((d, i) => (
                <button key={i} type="button" className={btn} onClick={() => engineRequest({ kind: 'declare', req: d.req })}>
                  {d.label}
                </button>
              ))}
              <button type="button" className={btn} onClick={() => engineRequest({ kind: 'pass', by: localSeat })}>
                見送る
              </button>
            </>
          ) : (
            <span className="text-ink-muted">相手の宣言の機会</span>
          )}
        </div>
      )}

      {engineOn && turn && !ch && turn.active === localSeat && (turn.phase === 'メイン' || turn.phase === '終了') && (
        <div className="flex items-center gap-2">
          <button type="button" className={btn} onClick={() => engineRequest({ kind: 'phase', by: localSeat })}>
            {turn.phase}フェイズを終える
          </button>
        </div>
      )}

      {notice && (
        <div className="flex flex-wrap items-center gap-2 text-warn">
          {notice.reason && <span>{notice.missingDef ? 'このカードは手動で（カードの記述が無い）' : notice.reason}</span>}
          {notice.warnings?.map((w, i) => (
            <span key={i}>⚠ {w}</span>
          ))}
          {(notice.missingDef || notice.warnings?.length) && (
            <button type="button" className={btn} onClick={() => dispatch({ type: 'setMode', mode: 'free' })}>
              手動で処理する
            </button>
          )}
          <button type="button" className={btn} onClick={clearNotice}>
            閉じる
          </button>
        </div>
      )}

      {engineOn && steps.steps.length > 0 && (
        <div className="truncate text-ink-muted">段: {steps.steps.map(stepText).join(' → ')}</div>
      )}
    </div>
  )
}
