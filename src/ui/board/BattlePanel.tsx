/*
 * バトル欄（R2u-2: エンジンの proc の battle フレームを描く。旧 core/battle.ts の状態機械は消した）
 *
 * 右列の DetailPanel の上に置く。読むのは proc の一番近い battle フレーム（nearestBattle）だけ。
 * - 選択（[7][11] 参加キャラ・[16] 種目・[21] 戻るか進むか・[26] 先に与える効果の優先）は EngineBar の選択の帯と盤面のクリック
 *   （procMeta.choice の purpose）。ここは「今どの段か・誰の番か」を出すだけ（二重に作らない）
 * - [23] エンジンが攻防の値を出せないとき（特殊な攻防・複数参加）は、ここで人が値を入れる（EngineReq.values）
 * - 中断・結果ダメージ・ダウンを出す
 * 🚨 合法かどうかは declare の答えだけ（バトルを挑むボタンも legalDeclarations の答え）。非公開のカード名は出さない。
 */

import { useEffect, useMemo, useState } from 'react'
import type { BoardState, Seat } from '../../core/board'
import { STEP_TIMINGS, activeSeat, awaitingSeat, nearestBattle, otherSeat } from '../../core/proc'
import type { EngineCtx } from '../../engine/ctx'
import { battleValues, declare } from '../../engine/drive'
import type { EngineReq } from '../../net/session'
import { publicName, type EngineUI } from '../engine/useEngineUI'

/** 20-4 の段（oldrule.txt:1062-1127）。表示専用。判定には使わない */
const STEP_LABELS: Record<number, string> = {
  1: '宣言',
  2: '相手の同時アクションの宣言の機会',
  3: 'バトルの宣言（提示）',
  4: '《バトルを挑まれたとき》',
  5: 'バトルを行う条件の確認（20-3）',
  6: '《バトルに参加するとき》《バトルを挑むとき》',
  7: '挑んだ側が参加キャラを指定（その後消耗させる）',
  8: '《バトルに参加したとき》《バトルを挑んだとき》',
  9: '挑んだ側の参加キャラの確認',
  10: '《バトルに参加するとき》《バトルを受けるとき》',
  11: '挑まれた側が参加キャラを指定（その後消耗させる）',
  12: '指定できなければリーダーが自動で参加（20-8）',
  13: '《バトルに参加したとき》《バトルを受けたとき》',
  14: '挑まれた側の参加キャラの確認',
  15: '《バトルカードを選択するとき》',
  16: '挑んだ側がバトルカードを1枚指定（種目）',
  17: '《バトルカードを選択したとき》',
  18: 'バトルカードを使用済みに・効果を適用',
  19: '挑んだ側が特殊能力を1回／お互いがイベントを複数回',
  20: '挑まれた側が特殊能力を1回／お互いがイベントを複数回',
  21: '挑んだ側が[19]に戻るか進むかを選ぶ',
  22: '挑んだ側が特殊能力を1回／お互いがイベントを複数回',
  23: '攻撃能力値・防御能力値の決定',
  24: 'バトルの結果の計算（20-10）',
  25: '《バトルの結果の計算をしたとき》',
  26: 'ダメージ処理・ダウン処理',
  27: '《バトルの結果を出したとき》',
  28: 'バトル終了時の処理（攻防修正を失わせる）',
  29: '《バトル終了後》《バトルが終了したとき》',
}

type Vals = Record<Seat, { atk: string; def: string }>

export function BattlePanel({
  board,
  localSeat,
  solo,
  ctx,
  ui,
  nameOf,
  engineRequest,
  onSelectCard,
}: {
  board: BoardState
  localSeat: Seat
  solo: boolean
  ctx: EngineCtx | null
  ui: EngineUI
  nameOf: (cardId: string) => string
  engineRequest: (req: EngineReq) => void
  onSelectCard?: (iid: string) => void
}) {
  const frame = nearestBattle(board)
  const b = frame?.battle
  const engineOn = board.mode === 'engine'
  const viewer = solo ? ui.actor : localSeat
  const who = (s: Seat) => (solo ? s : s === localSeat ? `${s}（自分）` : `${s}（相手）`)
  const name = (iid: string) => publicName(board, viewer, iid, nameOf) ?? iid

  // [23] 人が攻防の値を入れる段（drive の askValues で止まっている）
  const top = board.proc[board.proc.length - 1]
  const askValues = !!frame && top?.id === frame.id && frame.status === 'engine' && frame.engineWhat === 'battleValues'
  const preview = useMemo(() => (askValues && ctx && frame ? battleValues(ctx, board, frame, []) : null), [askValues, ctx, board, frame])
  const [vals, setVals] = useState<Vals>({ A: { atk: '', def: '' }, B: { atk: '', def: '' } })
  useEffect(() => {
    if (!preview) return
    const f = (s: Seat) => ({ atk: preview[s] ? String(preview[s]!.atk) : '', def: preview[s] ? String(preview[s]!.def) : '' })
    setVals({ A: f('A'), B: f('B') })
  }, [preview])

  if (!frame || !b) {
    const last = board.procMeta.battles[board.procMeta.battles.length - 1]
    const decl = ui.legal.find((d) => d.req.battle)
    // 押せない理由（declare の答え）: 自分のフィールドのキャラで試す
    const anyChar = Object.values(board.cards).find((c) => (c.zone === 'char' || c.zone === 'leader') && c.owner === ui.actor)
    const reason = !engineOn || !ctx || decl ? null : anyChar ? (() => {
      const r = declare(board, ctx, { by: ui.actor, source: anyChar.iid, battle: true })
      return r.ok ? '今は宣言の番でない' : r.reason
    })() : '自分のフィールドにキャラがいない'
    return (
      <div className="lf-panel shrink-0 p-1.5 text-[10px]">
        {engineOn && (
          <button type="button" disabled={!decl} onClick={() => decl && ui.start(decl)} className="lf-btn-primary w-full rounded py-1 disabled:opacity-30">
            ⚔ バトルを挑む{solo ? `（${ui.actor}）` : ''}
          </button>
        )}
        {reason && <p className="mt-0.5 truncate text-ink-muted" title={reason}>{reason}</p>}
        {!engineOn && <p className="text-ink-muted">手動の間はバトルの手順を進めない（盤面を手で直す）</p>}
        {last && (
          <p className="mt-0.5 truncate text-ink-faint">
            前のバトル: {last.challenger} が挑んだ・{last.aborted ? `中断（${last.aborted}）` : '終了'}
          </p>
        )}
      </div>
    )
  }

  const c = b.challenger
  const d = otherSeat(c)
  const waiting = frame.status === 'window' ? awaitingSeat(board) : null
  const ch = board.procMeta.choice && board.procMeta.choice.frameId === frame.id ? board.procMeta.choice : null
  const timing = STEP_TIMINGS.battle[frame.step]?.names ?? []
  const card = b.battleCard ? board.cards[b.battleCard] : undefined
  const cardInfo = card && ctx ? ctx.cards[card.cardId] : undefined
  const num = (x: string) => (x.trim() === '' ? NaN : Number(x))
  const ready = (['A', 'B'] as Seat[]).every((s) => Number.isInteger(num(vals[s].atk)) && Number.isInteger(num(vals[s].def)))

  return (
    <div className="lf-panel flex shrink-0 flex-col gap-1 p-1.5 text-[10px] [--lf-panel-border:rgb(255_122_138/0.55)]">
      <div className="flex items-baseline justify-between gap-1">
        <span className="truncate font-semibold text-danger" title={timing.length ? `《${timing.join('》《')}》` : undefined}>
          ⚔ [{frame.step}] {STEP_LABELS[frame.step] ?? ''}
        </span>
        <span className="shrink-0 text-ink-muted">挑んだ {who(c)}</span>
      </div>
      <div className="text-ink-muted">
        {ch
          ? `${who(ch.by)} が選ぶ: ${ch.prompt}（上の帯・盤面のカード）`
          : waiting
            ? `宣言の機会: ${who(waiting)} の番（AP ${activeSeat(board)}）`
            : askValues
              ? '攻防の値をエンジンが出せない → 下で入れる'
              : 'エンジンが進めている'}
      </div>

      {b.aborted && <div className="rounded border border-danger bg-danger/15 px-1 py-0.5 text-danger">中断: {b.aborted}／[29] は行わない（20-6-1）</div>}

      {/* 参加キャラ（[7][11]。複数参加もある K9） */}
      <div className="grid grid-cols-2 gap-1">
        {([c, d] as Seat[]).map((s) => (
          <div key={s} className="min-w-0 rounded border border-line px-1 py-0.5">
            <div className="text-ink-muted">
              {s === c ? '挑んだ側' : '挑まれた側'} {s}
              {s === d && b.autoLeader && <span className="text-warn">（自動参加 20-8）</span>}
            </div>
            {b.participants[s].length === 0 && <div className="text-ink-faint">（未指定）</div>}
            {b.participants[s].map((iid) => {
              const inst = board.cards[iid]
              const onField = inst && (inst.zone === 'char' || inst.zone === 'leader')
              return (
                <button key={iid} type="button" onClick={() => onSelectCard?.(iid)} className="block w-full truncate text-left text-ink hover:text-accent">
                  {name(iid)}
                  <span className="text-ink-muted">・気{inst?.kiryoku ?? '-'}</span>
                  {b.resultDowned.includes(iid) ? <span className="ml-1 text-danger">ダウン</span> : !onField ? <span className="ml-1 text-danger">場にいない</span> : null}
                </button>
              )
            })}
            {b.values?.[s] &&
              Object.entries(b.values[s]!).map(([iid, v]) => (
                <div key={iid} className="text-ink-muted">
                  {/* 3回計算のバトル（《鶴来屋温泉三本勝負》rounds）は回ごとの攻防を並べる。結果ダメージは各回（0以下は0）の合計 */}
                  {name(iid)}: {v.rounds ? `攻${v.rounds.map((r) => r.atk).join('／')}・防${v.rounds.map((r) => r.def).join('／')}（${v.rounds.length}回の合計）` : `攻${v.atk}・防${v.def}`}
                </div>
              ))}
            {b.damage &&
              b.damage
                .filter((d) => d.seat === s)
                .map((d, i) => (
                  <div key={i} className={d.value > 0 ? 'text-danger' : 'text-ink-muted'}>
                    結果ダメージ {name(d.recipient)}: {Math.max(d.value, 0)}
                  </div>
                ))}
          </div>
        ))}
      </div>

      {/* 種目（[16]） */}
      <div className="truncate text-ink-muted">
        種目: {card ? `${name(card.iid)}${cardInfo?.kind === 'b' ? `（攻:${cardInfo.battleAtk ?? '?'}／防:${cardInfo.battleDef ?? '?'}）` : ''}` : '（未指定）'}
        {b.skipActions && '・[19]〜[22] を行わない'}
      </div>

      {/* [23] 人の入力（EngineReq.values）。エンジンが出せた側の値は入れてある */}
      {askValues && (
        <div className="rounded border border-warn px-1 py-0.5">
          <div className="mb-0.5 text-warn">[23] 攻撃能力値・防御能力値（{cardInfo ? `${cardInfo.name}: 攻 ${cardInfo.battleAtk ?? '?'}・防 ${cardInfo.battleDef ?? '?'}` : '種目なし'}）</div>
          {(['A', 'B'] as Seat[]).map((s) => (
            <div key={s} className="flex items-center gap-1">
              <span className="w-12 shrink-0 text-ink-muted">{s === c ? '挑んだ' : '挑まれた'} {s}</span>
              {(['atk', 'def'] as const).map((k) => (
                <label key={k} className="flex items-center gap-0.5">
                  {k === 'atk' ? '攻' : '防'}
                  <input
                    type="number"
                    disabled={!engineOn}
                    value={vals[s][k]}
                    onChange={(e) => setVals((v) => ({ ...v, [s]: { ...v[s], [k]: e.target.value } }))}
                    className="w-12 rounded border border-line-strong bg-surface-2 px-1 text-right disabled:opacity-40"
                  />
                </label>
              ))}
              {preview?.[s] && <span className="text-ink-faint">（自動）</span>}
            </div>
          ))}
          <button
            type="button"
            disabled={!engineOn || !ready}
            onClick={() =>
              engineRequest({
                kind: 'values',
                by: ui.actor,
                values: { A: { atk: num(vals.A.atk), def: num(vals.A.def) }, B: { atk: num(vals.B.atk), def: num(vals.B.def) } },
              })
            }
            className="lf-btn-primary mt-0.5 w-full rounded py-0.5 disabled:opacity-30"
          >
            この値で結果を出す（20-10）
          </button>
        </div>
      )}
    </div>
  )
}
