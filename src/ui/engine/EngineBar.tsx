/*
 * エンジンモードの帯（PHASE-R2u §3-2・§3-3・§2 の決定）
 *
 * ターン・AP・フェイズ・発生済みのコスト（クリックで支払いに使う）／エンジン⇄手動の切り替え／鳴き無しボタン（自動見送り）／
 * 宣言の番の帯（宣言できるもの・見送る・フェイズ終了の宣言／認める・認めない 10-2-2）／対象・支払いの帯／選択の帯／
 * 結果・警告の帯／直近の段。
 * 🚨 合法かどうかは declare（legalDeclarations）の答えだけを使う。非公開のカードの名前は出さない。
 */

import { useEffect, useRef, useState } from 'react'
import type { BoardAction } from '../../core/actions'
import type { BoardState, Seat } from '../../core/board'
import { activeSeat, awaitingSeat, currentWindow, phaseEndPending, topFrame } from '../../core/proc'
import type { EngineCtx } from '../../engine/ctx'
import type { EngineReq, PublicStep } from '../../net/session'
import { isOwnMainDeclareWindow, setupDone, shouldAutoPass } from './host'
import { publicName, type EngineUI } from './useEngineUI'

type AutoPass = 'now' | 'wait'
const AUTO_PASS_KEY = 'lf.autoPass'
/** §2-2「待つ」の間（約1.5秒） */
const WAIT_MS = 1500
/** §2-4 1段を見せる長さ（約0.6秒） */
const FLASH_MS = 600

function readAutoPass(): AutoPass {
  try {
    return localStorage.getItem(AUTO_PASS_KEY) === 'wait' ? 'wait' : 'now'
  } catch {
    return 'now'
  }
}

/** 段の1行（iid は公開か自分のカードのときだけ名前、他は「＊」） */
export function stepLine(board: BoardState, viewer: Seat, nameOf: (cardId: string) => string, s: PublicStep): string {
  const names = s.iids.map((iid) => {
    const n = publicName(board, viewer, iid, nameOf)
    return n === '（非公開のカード）' || n === null ? '＊' : n
  })
  return [s.text, ...names].filter(Boolean).join(' ')
}

export function EngineBar({
  board,
  localSeat,
  solo,
  ctx,
  ui,
  nameOf,
  engineRequest,
  dispatch,
  steps,
  notice,
  clearNotice,
}: {
  board: BoardState
  localSeat: Seat
  /** 一人のとき（両方の席を自動見送り・両方の席を操作する） */
  solo: boolean
  ctx: EngineCtx | null
  ui: EngineUI
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
  const engineOn = board.mode === 'engine'
  const ch = board.procMeta.choice
  const win = currentWindow(board)
  const waiting = awaitingSeat(board)
  const top = topFrame(board)
  const ap = activeSeat(board)
  const actor = ui.actor
  const pePending = phaseEndPending(board)
  const inPhaseWindow = !!win && win.frame === null && !!board.turn
  // R3⑤（利用者 2026-09-26）: 自分（AP）のメインフェイズは自動で終わらない（host.shouldAutoPass が判定。ここはボタンを光らせる条件に使う）
  const apOwnMainWindow = !!waiting && isOwnMainDeclareWindow(board, waiting)

  // §2-2 自動見送り: 宣言できるものが1つも無ければ止まらない（即／約1.5秒）。NAP のフェイズ終了への答えも同じ（認める）。
  // エンジンが進めた直後（steps.n が変わったとき）に1回だけ（Undo で戻した盤面では自動で見送らない）【決めたこと・承認済み】。
  // 一人のときは両方の席を自動見送りする（統括11 のレビュー）
  // R3⑤: 自分のメインフェイズだけは例外＝宣言できるものが無くても自動で終わらせず、フェイズ終了ボタンを光らせて誘導する
  const autoDoneN = useRef(-1)
  useEffect(() => {
    if (!engineOn || !ctx || autoDoneN.current === steps.n || !waiting) return
    if (!solo && waiting !== localSeat) return
    if (apOwnMainWindow) return
    if (!shouldAutoPass(board, ctx, waiting)) return
    const n = steps.n
    const t = window.setTimeout(() => {
      autoDoneN.current = n
      engineRequest({ kind: 'pass', by: waiting, auto: true })
    }, autoPass === 'now' ? 0 : WAIT_MS)
    return () => window.clearTimeout(t)
  }, [engineOn, ctx, board, localSeat, solo, waiting, autoPass, engineRequest, steps.n, apOwnMainWindow])

  // §2-4 段ごとに一瞬見せる: 関係するカードを約0.6秒ずつ順に光らせる（両方の画面で同じ steps が届く）
  const [flashText, setFlashText] = useState<string | null>(null)
  useEffect(() => {
    const list = steps.steps.filter((x) => x.iids.length > 0)
    if (list.length === 0) return
    let i = 0
    let lit: Element[] = []
    const off = () => lit.forEach((el) => el.classList.remove('lf-flash'))
    const tick = () => {
      off()
      if (i >= list.length) {
        setFlashText(null)
        return
      }
      const st = list[i++]
      lit = st.iids.flatMap((iid) => Array.from(document.querySelectorAll(`[data-iid="${CSS.escape(iid)}"]`)))
      lit.forEach((el) => el.classList.add('lf-flash'))
      setFlashText(stepLine(board, localSeat, nameOf, st))
      timer = window.setTimeout(tick, FLASH_MS)
    }
    let timer = window.setTimeout(tick, 0)
    return () => {
      window.clearTimeout(timer)
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps.n])

  // 一人のときは操作している席の視点で名前を出す（同じ人が両方の席を持つ）
  const cardLabel = (iid: string) => publicName(board, solo ? ui.actor : localSeat, iid, nameOf) ?? iid
  const btn = 'lf-btn-primary shrink-0 rounded px-2 py-0.5 text-xs disabled:opacity-30'
  const turn = board.turn
  const who = (s: Seat) => (solo ? s : s === localSeat ? '自分' : '相手')
  const draft = ui.draft
  const paying = draft?.stage === 'pay' ? draft : null

  /** 発生済みのコスト（7-3）。支払いを選んでいる間は自分のコストをクリックで使う／使わない */
  const costTokens = (seat: Seat) =>
    board.costs[seat].map((t) => {
      const on = !!paying?.req.payPool?.includes(t.id)
      const usable = !!paying && paying.req.by === seat
      return (
        <button
          key={t.id}
          type="button"
          disabled={!usable}
          onClick={() => ui.togglePool(t.id)}
          title={usable ? 'この発生済みのコストで払う' : '発生済みのコスト'}
          className={`rounded border px-1 text-[10px] ${on ? 'border-accent bg-accent text-on-accent' : usable ? 'border-dashed border-accent text-ink' : 'border-line text-ink-muted'}`}
        >
          {t.frameId ? t.icon : 'W'}
          {t.attrs.join('')}
        </button>
      )
    })

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-line bg-surface-1 px-3 py-1 text-xs text-ink">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold text-accent">
          {turn ? `ターン ${turn.n ?? '?'}・AP ${turn.active}${solo ? '' : `（${who(turn.active)}）`}・${turn.phase}フェイズ` : 'ターン未開始'}
        </span>
        <span className="flex items-center gap-1 text-ink-muted">
          コスト A:{board.costs.A.length ? costTokens('A') : '0'} B:{board.costs.B.length ? costTokens('B') : '0'}
        </span>
        {top && <span className="text-ink-muted">手順: {top.label ?? top.kind}[{top.step}]</span>}
        <span className="flex-1" />
        <button
          type="button"
          className={btn}
          title="エンジン＝ルールどおりに進める／手動＝盤面を手で直す（エンジンを動かさない）"
          onClick={() => (engineOn ? dispatch({ type: 'setMode', mode: 'free' }) : engineRequest({ kind: 'engineOn', by: localSeat }))}
        >
          {engineOn ? 'エンジン' : '手動'} ⇄
        </button>
        {engineOn && (board.proc.length > 0 || ch) && (
          <button
            type="button"
            className={btn}
            onClick={() => {
              if (window.confirm('進行中の手順を捨てて、メインの窓からやり直しますか？（Undo で戻せます）')) engineRequest({ kind: 'abandon', by: localSeat })
            }}
          >
            手順を捨てる
          </button>
        )}
        {/* 麻雀の「鳴き無し」ボタン（§2-2）。対戦中いつでも切り替えられる */}
        <button type="button" className={btn} onClick={toggleAutoPass} title="宣言できるものが無いとき、すぐ見送るか約1.5秒待ってから見送るか">
          見送り: {autoPass === 'now' ? '即' : '待つ'}
        </button>
      </div>

      {engineOn && !turn && (
        <div className="flex items-center gap-2">
          {setupDone(board) ? (
            <>
              <span>開始準備が済んだら、先攻を選んで始める:</span>
              {(['A', 'B'] as Seat[]).map((s) => (
                <button key={s} type="button" className={btn} onClick={() => engineRequest({ kind: 'start', by: localSeat, first: s })}>
                  先攻 {s}{solo ? '' : `（${who(s)}）`}
                </button>
              ))}
            </>
          ) : (
            <span className="text-ink-muted">開始準備の途中（マリガン→先攻を決める→リーダーを表にする）</span>
          )}
        </div>
      )}

      {engineOn && board.result && (
        <div className="font-bold text-warn">
          結果: {board.result.winner === null ? '引き分け' : `勝者 ${board.result.winner}`}（{board.result.reason}）
        </div>
      )}

      {/* 選択（procMeta.choice）: 選択肢がカードなら盤面のカードをクリック（帯のボタンは補助） */}
      {engineOn && ch && (
        <div className="flex flex-wrap items-center gap-1">
          {ch.by === actor ? (
            <>
              <span className="font-bold">{solo ? `${ch.by}: ` : ''}{ch.prompt}</span>
              {ch.options.map((o) => {
                const isCard = !!board.cards[o.key]
                const n = ui.pick.filter((k) => k === o.key).length
                return (
                  <button key={o.key} type="button" className={`${btn} ${n ? 'ring-2 ring-warn' : ''}`} onClick={() => ui.togglePick(o.key)}>
                    {isCard ? cardLabel(o.key) : o.label}
                    {n > 1 ? ` ×${n}` : ''}
                  </button>
                )
              })}
              {ch.repeat && ui.pick.length > 0 && (
                <button type="button" className={btn} onClick={ui.resetPick}>
                  やり直し
                </button>
              )}
              <button type="button" className={btn} disabled={ui.pick.length < ch.min || ui.pick.length > ch.max} onClick={ui.submitPick}>
                決定（{ui.pick.length}／{ch.min === ch.max ? ch.min : `${ch.min}〜${ch.max}`}）
              </button>
            </>
          ) : (
            <span className="text-ink-muted">相手が選んでいます</span>
          )}
        </div>
      )}

      {/* 宣言の番（11-2）。フェイズの窓の AP の見送り＝フェイズ終了の宣言（10-2-2）・NAP は認める／認めない */}
      {engineOn && !ch && win && !draft && (
        <div className="flex flex-wrap items-center gap-1">
          {waiting === actor ? (
            <>
              <span className="font-bold">
                {solo ? `${actor}: ` : ''}
                {pePending ? `相手が${turn?.phase}フェイズの終了を宣言（10-2-2）` : `宣言の機会${win.frame ? `（${win.frame.label ?? win.frame.kind}）` : `（${turn?.phase ?? 'メイン'}）`}`}
              </span>
              {ui.legal.map((d, i) => (
                <button key={i} type="button" className={btn} onClick={() => ui.start(d)} title={d.violations?.map((v) => `警告: ${v.text}`).join('\n')}>
                  {d.violations?.length ? '⚠ ' : ''}
                  {d.label}
                </button>
              ))}
              {pePending ? (
                <>
                  <button type="button" className={btn} onClick={() => engineRequest({ kind: 'phase', by: actor, answer: 'accept' })}>
                    認める
                  </button>
                  <button type="button" className={btn} onClick={() => engineRequest({ kind: 'phase', by: actor, answer: 'deny' })}>
                    認めない
                  </button>
                </>
              ) : inPhaseWindow && actor === ap && win.window.state === 'awaitActive' ? (
                <button
                  type="button"
                  className={`${btn}${apOwnMainWindow && ui.legal.filter((d) => !d.req.costGen).length === 0 ? ' lf-glow' : ''}`}
                  onClick={() => engineRequest({ kind: 'pass', by: actor })}
                >
                  {turn?.phase}フェイズ終了を宣言
                </button>
              ) : (
                <button type="button" className={btn} onClick={() => engineRequest({ kind: 'pass', by: actor })}>
                  見送る
                </button>
              )}
            </>
          ) : (
            <span className="text-ink-muted">{pePending ? 'フェイズ終了の答えを待っています' : '相手の宣言の機会'}</span>
          )}
        </div>
      )}

      {/* 20-4[23]: エンジンが攻防の値を出せないとき（特殊な攻防・複数参加）は人が入れる（右のバトル欄。EngineReq.values） */}
      {engineOn && top?.kind === 'battle' && top.status === 'engine' && top.engineWhat === 'battleValues' && (
        <div className="font-bold text-warn">バトル [23]: 攻撃能力値・防御能力値を右のバトル欄で入れてください（どちらのプレイヤーが入れてもよい）</div>
      )}

      {/* 対象の指定（宣言[3]）: 盤面のカードをクリック */}
      {engineOn && draft?.stage === 'target' && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="font-bold">
            {draft.label}: {draft.specs.map((s) => `${s.slot}（${s.min === s.max ? s.min : `${s.min}〜${s.max}`}）`).join('・')}を盤面で選ぶ
          </span>
          {draft.specs
            .flatMap((s) => s.options)
            .filter((o) => !board.cards[o])
            .map((o) => (
              <button key={o} type="button" className={`${btn} ${draft.picked.includes(o) ? 'ring-2 ring-warn' : ''}`} onClick={() => void ui.click(o)}>
                {o}
              </button>
            ))}
          <button type="button" className={btn} disabled={draft.picked.length < draft.specs.reduce((s, x) => s + x.min, 0)} onClick={ui.confirmTargets}>
            決定（{draft.picked.length}）
          </button>
          <button type="button" className={btn} onClick={ui.cancel}>
            やめる
          </button>
        </div>
      )}

      {/* §2-1 支払いを選ぶ: 盤面の待機状態の自分のキャラ（消耗）・手札のキャラ／タッグ（捨てる）・上のコスト表示の発生済みのコストをクリック */}
      {engineOn && paying && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="font-bold">
            支払いを選ぶ: {paying.label}（コスト {paying.need?.costText}）— 盤面のキャラ・手札・上の発生済みのコストをクリック
          </span>
          {paying.need?.candidates.map((iid) => {
            const c = board.cards[iid]
            const on = !!paying.req.payWith?.includes(iid)
            return (
              <button key={iid} type="button" className={`${btn} ${on ? 'ring-2 ring-warn' : ''}`} onClick={() => ui.click(iid)}>
                {cardLabel(iid)}（{c?.zone === 'hand' ? '捨てる' : '消耗'}）
              </button>
            )
          })}
          <button type="button" className={btn} disabled={!ui.payReady} title={ui.payReady ? undefined : 'まだ足りない'} onClick={ui.submitPay}>
            宣言
          </button>
          <button type="button" className={btn} onClick={ui.cancel}>
            やめる
          </button>
        </div>
      )}

      {/* K4（R3）: カードの効果による禁止・対象にならない等。止めずに警告して確かめる（DESIGN §5.4「段階」） */}
      {engineOn && draft?.stage === 'warn' && (
        <div className="flex flex-wrap items-center gap-1 text-warn">
          <span className="font-bold">
            警告: {draft.warn?.join('／')}。それでも「{draft.label}」を宣言する？
          </span>
          <button type="button" className={btn} onClick={ui.confirmWarn}>
            それでも宣言する
          </button>
          <button type="button" className={btn} onClick={ui.cancel}>
            やめる
          </button>
        </div>
      )}

      {ui.notice && (
        <div className="flex items-center gap-2 text-warn">
          <span>{ui.notice}</span>
          <button type="button" className={btn} onClick={ui.clearNotice}>
            閉じる
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
        <div className="truncate text-ink-muted">
          段: {flashText ? <span className="font-bold text-warn">{flashText}</span> : steps.steps.map((s) => stepLine(board, localSeat, nameOf, s)).join(' → ')}
        </div>
      )}
    </div>
  )
}
