/*
 * エンジンモードの画面の入力（PHASE-R2u §3-3・§2-1）— 宣言の入口・対象の指定・支払いの選択・選択肢を盤面のクリックで
 *
 * このクライアントだけの状態（組み立て中の宣言・選択中の答え）。共有状態には入れない。合法かどうかは declare の答えだけを使う。
 * 入口: 手札ドラッグ（startFor）／DetailPanel・右クリックの「宣言」（declsFor）／EngineBar のボタン。
 * 流れ: 対象（宣言者が指定するもの）→ 支払い（毎回自分で選ぶ。例外は聞かない）→ 宣言の要求。
 * R3: 宣言がカードの効果による禁止・対象にならない等（K4）に当たるときは、送る前に「警告: 〜（根拠）。それでも宣言する？」と確かめる（stage 'warn'）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { isPublicCard, type BoardState, type Seat } from '../../core/board'
import { activeSeat, awaitingSeat } from '../../core/proc'
import type { EngineCtx } from '../../engine/ctx'
import { declare, type DeclareReq } from '../../engine/drive'
import type { EngineReq } from '../../net/session'
import { legalDeclarations, paymentNeed, paymentReady, targetsNeeded, type LegalDecl, type PaymentNeed, type TargetSpec } from './host'

export interface Draft {
  req: DeclareReq
  label: string
  stage: 'target' | 'pay' | 'warn'
  specs: TargetSpec[]
  picked: string[]
  need: PaymentNeed | null
  /** stage 'warn': 当たっている禁止・対象にならない等（K4）の文 */
  warn?: string[]
}

export interface EngineUI {
  on: boolean
  /** 宣言を組み立てる席（一人のときは今の番の席。それ以外は自分の席） */
  actor: Seat
  legal: LegalDecl[]
  draft: Draft | null
  pick: string[]
  notice: string | null
  declsFor: (iid: string) => LegalDecl[]
  start: (d: LegalDecl) => void
  /** 手札ドラッグ: そのカードを使う宣言を始める */
  startFor: (iid: string) => void
  cancel: () => void
  /** 対象の指定を終えて支払いへ */
  confirmTargets: () => void
  /** 警告（K4）を確かめたうえで宣言を送る */
  confirmWarn: () => void
  togglePool: (id: string) => void
  submitPay: () => void
  payReady: boolean
  togglePick: (key: string) => void
  resetPick: () => void
  submitPick: () => void
  /** 盤面のカードのクリック（使ったら true） */
  click: (iid: string) => boolean
  ring: (iid: string) => { battleRing?: 'candidate' | 'selected'; battleRingLabel?: string }
  clearNotice: () => void
}

export function useEngineUI({
  board,
  ctx,
  localSeat,
  solo,
  engineRequest,
}: {
  board: BoardState
  ctx: EngineCtx | null
  localSeat: Seat
  solo: boolean
  engineRequest: (req: EngineReq) => void
}): EngineUI {
  const on = board.mode === 'engine' && !!ctx
  const ch = board.procMeta.choice
  // 一人のとき: 今宣言・選択の番の席として操作する（視点を切り替えなくても両方の席を動かせる）。手札の中身は視点の席のものしか見えない
  const actor: Seat = solo ? (ch?.by ?? awaitingSeat(board) ?? activeSeat(board)) : localSeat
  const [draft, setDraft] = useState<Draft | null>(null)
  const [pick, setPick] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)

  // 画面のボタンには警告つきの宣言も出す（押すと確認する）。自動見送りは違反のある宣言を数えない（host.shouldAutoPass）
  const legal = useMemo(() => (on && ctx ? legalDeclarations(board, ctx, actor, { withWarned: true }) : []), [on, ctx, board, actor])
  // 盤面が変わったら組み立て中の宣言は捨てる（古い盤面の前提で送らない）
  useEffect(() => setDraft(null), [board])
  useEffect(() => setPick([]), [ch?.id])

  /** 送る前に K4 の違反を確かめる（あれば確認の帯へ） */
  const send = useCallback(
    (req: DeclareReq, label: string, specs: TargetSpec[]) => {
      if (!ctx) return
      const r = declare(board, ctx, req)
      if (r.ok && r.violations.length) {
        setDraft({ req, label, stage: 'warn', specs, picked: req.targets ?? [], need: null, warn: r.violations.map((v) => v.text) })
        return
      }
      setDraft(null)
      engineRequest({ kind: 'declare', req })
    },
    [board, ctx, engineRequest],
  )

  const toPay = useCallback(
    (req: DeclareReq, label: string, specs: TargetSpec[]) => {
      if (!ctx) return
      const need = paymentNeed(board, ctx, req)
      if (!need.choose) {
        send(need.autoPool ? { ...req, payPool: need.autoPool } : req, label, specs)
        return
      }
      setDraft({ req: { ...req, payWith: [], payPool: [] }, label, stage: 'pay', specs, picked: req.targets ?? [], need })
    },
    [board, ctx, send],
  )

  const start = useCallback(
    (d: LegalDecl) => {
      if (!ctx) return
      setNotice(null)
      const specs = targetsNeeded(board, ctx, d.req)
      if (specs.length && !d.req.targets?.length) {
        setDraft({ req: d.req, label: d.label, stage: 'target', specs, picked: [], need: null })
        return
      }
      toPay(d.req, d.label, specs)
    },
    [board, ctx, toPay],
  )

  const declsFor = useCallback((iid: string) => legal.filter((d) => d.req.source === iid), [legal])

  const startFor = useCallback(
    (iid: string) => {
      if (!ctx) return
      const d = legal.find((x) => x.req.source === iid && !x.req.costGen && !x.req.battle)
      if (d) return start(d)
      // 宣言できない理由（declare の答え）を出す。手札のカードの名前は自分にだけ見える帯に出る
      const r = declare(board, ctx, { by: actor, source: iid })
      // 警告（K4）だけなら宣言を始める（送る前に確認する）
      if (r.ok && r.violations.length) return start({ req: { by: actor, source: iid }, label: ctx.cards[board.cards[iid]?.cardId ?? '']?.name ?? iid, violations: r.violations })
      setNotice(r.ok ? '今は宣言できない' : r.missingDef ? 'このカードは手動で（カードの記述が無い）' : r.reason)
    },
    [legal, ctx, board, actor, start],
  )

  const need = draft?.stage === 'target' ? draft.specs.reduce((s, x) => s + x.max, 0) : 0
  const confirmTargets = useCallback(() => {
    if (!draft || draft.stage !== 'target') return
    toPay({ ...draft.req, targets: draft.picked }, draft.label, draft.specs)
  }, [draft, toPay])

  const toggleIn = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x])

  const click = (iid: string): boolean => {
    if (!on) return false
    if (draft?.stage === 'target') {
      if (!draft.specs.some((s) => s.options.includes(iid))) return false
      const picked = toggleIn(draft.picked, iid)
      if (picked.length >= need && need > 0) toPay({ ...draft.req, targets: picked }, draft.label, draft.specs)
      else setDraft({ ...draft, picked })
      return true
    }
    if (draft?.stage === 'pay') {
      if (!draft.need?.candidates.includes(iid)) return false
      setDraft({ ...draft, req: { ...draft.req, payWith: toggleIn(draft.req.payWith ?? [], iid) } })
      return true
    }
    if (ch && ch.by === actor && ch.options.some((o) => o.key === iid)) {
      setPick((p) => (ch.repeat ? [...p, iid] : toggleIn(p, iid)))
      return true
    }
    return false
  }

  const ring = (iid: string): { battleRing?: 'candidate' | 'selected'; battleRingLabel?: string } => {
    if (!on) return {}
    if (draft?.stage === 'target' && draft.specs.some((s) => s.options.includes(iid))) {
      return draft.picked.includes(iid) ? { battleRing: 'selected', battleRingLabel: draft.specs[0].slot.slice(0, 4) } : { battleRing: 'candidate' }
    }
    if (draft?.stage === 'pay' && draft.need?.candidates.includes(iid)) {
      const c = board.cards[iid]
      return draft.req.payWith?.includes(iid) ? { battleRing: 'selected', battleRingLabel: c?.zone === 'hand' ? '捨てる' : '消耗' } : { battleRing: 'candidate' }
    }
    if (ch && ch.by === actor && ch.options.some((o) => o.key === iid)) {
      const n = pick.filter((k) => k === iid).length
      // バトルの選択は何を選んでいるかを札に出す（[7][11] 参加・[16] 種目）
      const label = ch.purpose === 'battleParticipant' ? '参加' : ch.purpose === 'battleCard' ? '種目' : ch.purpose === 'limitTrash' ? 'ゴミ箱' : '選択'
      return n ? { battleRing: 'selected', battleRingLabel: n > 1 ? `×${n}` : label } : { battleRing: 'candidate' }
    }
    return {}
  }

  return {
    on,
    actor,
    legal,
    draft,
    pick,
    notice,
    declsFor,
    start,
    startFor,
    cancel: () => setDraft(null),
    confirmTargets,
    togglePool: (id: string) => draft?.stage === 'pay' && setDraft({ ...draft, req: { ...draft.req, payPool: toggleIn(draft.req.payPool ?? [], id) } }),
    submitPay: () => {
      if (!draft || draft.stage !== 'pay') return
      send(draft.req, draft.label, draft.specs)
    },
    confirmWarn: () => {
      if (!draft || draft.stage !== 'warn') return
      setDraft(null)
      engineRequest({ kind: 'declare', req: draft.req })
    },
    payReady: !!(draft?.stage === 'pay' && ctx && paymentReady(board, ctx, draft.req)),
    togglePick: (key: string) => ch && setPick((p) => (ch.repeat ? [...p, key] : toggleIn(p, key))),
    resetPick: () => setPick([]),
    submitPick: () => ch && engineRequest({ kind: 'choose', by: ch.by, id: ch.id, pick }),
    click,
    ring,
    clearNotice: () => setNotice(null),
  }
}

/** 選択肢・段の表示名: カードなら公開か自分のカードのときだけ名前（非公開は伏せる） */
export function publicName(board: BoardState, viewer: Seat, iid: string, nameOf: (cardId: string) => string): string | null {
  const c = board.cards[iid]
  if (!c) return null
  return isPublicCard(c) || c.owner === viewer ? nameOf(c.cardId) : '（非公開のカード）'
}
