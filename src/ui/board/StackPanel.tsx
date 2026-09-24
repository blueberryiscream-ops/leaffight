import { useEffect, useRef, useState } from 'react'
import type { BoardAction } from '../../core/actions'
import type { BoardState, CardInstance, Seat } from '../../core/board'
import { awaitingSeat, resolvingSeat, type ActionWindow, type DeclaredAction, type Priority } from '../../core/priority'
import { CARD_BACK_IMAGE_ID } from '../../data/bundle'
import type { InterruptCandidate } from '../../data/interrupt'
import type { InterruptsMap, PoolCard } from '../../data/types'
import { CardPiece } from './CardPiece'
import { resolveDestinationOf } from './priorityWindow'
import { useInterruptNotices, type InterruptNotice } from './useInterruptNotices'
import { otherSeat } from './useBoard'

// 解決された「プレイ」宣言のカードの行き先の判定（resolveDestinationOf）は
// src/ui/board/priorityWindow.ts に切り出した（PHASE3d-3.md §5「二重に書かない」・TodoBand.tsxと共有）。

/** 提示エリアのカード1枚分の大きさ(px)。カード比63:88（DESIGN.md §4.18.1）。
 *  盤面のマスと違い回転しないうえ、パネル幅が狭い（レイアウトBで140px）ので小さめの固定値にする。 */
const PENDING_CARD_SIZE = { w: 42, h: 59 }

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

function ActionSlot({
  label,
  action,
  onSelectCard,
}: {
  label: string
  action: DeclaredAction | null
  /** 宣言中カード(pending)は盤面に描画されないので、名前クリックで詳細パネルに呼び出す
   * （PHASE3a-3.md §3-2(a)。相手はこれで中身を見て打ち消すか判断する） */
  onSelectCard?: (iid: string) => void
}) {
  return (
    <div className="min-h-0 flex-1 rounded border border-line-strong bg-surface-1/60 p-1.5">
      <div className="mb-0.5 font-semibold text-ink-muted">{label}</div>
      {action ? (
        <>
          <div className="text-ink-muted">
            {action.kind} ・ {action.actionType}
          </div>
          {action.sourceIid && onSelectCard ? (
            <button
              type="button"
              onClick={() => onSelectCard(action.sourceIid!)}
              className="truncate text-left font-semibold text-accent underline decoration-dotted hover:text-accent"
            >
              {action.label}
            </button>
          ) : (
            <div className="truncate font-semibold text-ink">{action.label}</div>
          )}
          {action.detail && <div className="truncate text-ink-muted">{action.detail}</div>}
        </>
      ) : (
        <p className="text-ink-faint">（宣言なし）</p>
      )}
    </div>
  )
}

/**
 * 提示エリア（PHASE3a-4.md §1-4）。宣言して pending にいるカードを「実際のカード」として描画し、
 * ここからドラッグで盤面のスロットへ置けるようにする（dnd-kit の draggable は CardPiece が持つ）。
 * 🚨 窓が閉じた後（priority===null）でもキャラ/アイテムはここに残る。置き忘れに気づけるよう、
 * 1枚でもあれば常に表示する（PHASE3a-4.md §1-5 で不変条件を明示的に変更した）。
 */
function PendingArea({
  cards,
  board,
  cardOf,
  imageUrlOf,
  dispatch,
  onSelectCard,
  onCardContextMenu,
  selectedIid,
}: {
  cards: CardInstance[]
  board: BoardState
  cardOf: (cardId: string) => PoolCard | undefined
  imageUrlOf?: (cardId: string) => string | undefined
  dispatch: (action: BoardAction) => void
  onSelectCard?: (iid: string) => void
  onCardContextMenu?: (iid: string, x: number, y: number) => void
  selectedIid?: string | null
}) {
  if (cards.length === 0) return null
  return (
    <div data-pending-area className="shrink-0 rounded border border-accent bg-accent/20 p-1">
      <div className="mb-0.5 font-semibold text-accent">提示エリア（ドラッグで置く）</div>
      <div className="flex flex-wrap gap-1">
        {cards.map((inst) => (
          <CardPiece
            key={inst.iid}
            instance={inst}
            card={cardOf(inst.cardId)}
            imageUrl={imageUrlOf?.(inst.cardId)}
            backImageUrl={imageUrlOf?.(CARD_BACK_IMAGE_ID)}
            board={board}
            dispatch={dispatch}
            onClick={() => onSelectCard?.(inst.iid)}
            onContextMenu={(x, y) => onCardContextMenu?.(inst.iid, x, y)}
            selected={selectedIid === inst.iid}
            size={PENDING_CARD_SIZE}
          />
        ))}
      </div>
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
        <div key={n.id} className="rounded border border-warn bg-warn/40 p-1.5">
          <div className="flex items-start justify-between gap-1">
            <span className="text-warn">
              《{n.timing}》— 割り込める札があります
            </span>
            <button type="button" onClick={() => onDismiss(n.id)} className="shrink-0 text-ink-muted hover:text-ink">
              ✕
            </button>
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {n.candidates.map((c, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onDeclare(n, c)}
                className="rounded border border-accent px-1.5 py-0.5 text-accent hover:bg-accent/15"
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
  onSelectCard,
  imageUrlOf,
  onCardContextMenu,
  selectedIid,
}: {
  board: BoardState
  /** 「自分が応答待ちか」の表示判定にのみ使う。共有状態(priority)には混ぜない（PHASE3a-2a.md §1） */
  localSeat: Seat
  dispatch: (action: BoardAction) => void
  cardOf: (cardId: string) => PoolCard | undefined
  interrupts: InterruptsMap
  /** 宣言中カード(pending)の詳細を見るための導線（PHASE3a-3.md §3-2(a)） */
  onSelectCard?: (iid: string) => void
  /** 提示エリアのカード描画用（PHASE3a-4.md §1-4） */
  imageUrlOf?: (cardId: string) => string | undefined
  onCardContextMenu?: (iid: string, x: number, y: number) => void
  selectedIid?: string | null
}) {
  const { notices, dismiss } = useInterruptNotices(board, localSeat, cardOf, interrupts)

  // 提示エリアの中身。座席で絞らない（相手が提示したカードも「提示」＝公開情報）。
  const pendingCards = Object.values(board.cards)
    .filter((c) => c.zone === 'pending')
    .sort((a, b) => (a.owner === b.owner ? a.index - b.index : a.owner < b.owner ? -1 : 1))

  const pendingArea = (
    <PendingArea
      cards={pendingCards}
      board={board}
      cardOf={cardOf}
      imageUrlOf={imageUrlOf}
      dispatch={dispatch}
      onSelectCard={onSelectCard}
      onCardContextMenu={onCardContextMenu}
      selectedIid={selectedIid}
    />
  )

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

  // バトルが始まったとき（board.battleがnull→非nullになった瞬間）に自動パスをオフにする
  // （PHASE3d-2b §4。旧実装は「現在の窓にkind==='バトル'の宣言があれば」だったが、P3d-2aで
  // バトル宣言は優先権の窓に載らなくなった（HANDOFF-P3d-2a.md）ためもう成立しない。
  // 元の意図＝相手のバトル宣言という大きな出来事は自動で流さず一度止める、を保つための置き換え）。
  const battleActiveRef = useRef(board.battle !== null)
  useEffect(() => {
    const wasActive = battleActiveRef.current
    const isActive = board.battle !== null
    battleActiveRef.current = isActive
    if (!wasActive && isActive) {
      setAutoPass(false)
    }
  }, [board.battle])

  useEffect(() => {
    const p = board.priority
    if (!p) return
    if (!autoPass || board.mode !== 'assist') return

    const seat = awaitingSeat(p)
    if (seat !== localSeat) return
    if (autoPassHandledRef.current === p) return
    autoPassHandledRef.current = p
    dispatch({ type: 'passPriority', by: localSeat })
  }, [autoPass, board.mode, board.priority, localSeat, dispatch])

  if (board.mode === 'free') {
    return (
      <div className="lf-panel flex h-full min-h-0 flex-col items-center justify-center gap-1 border-dashed p-2 text-center text-[10px] text-ink-faint">
        フリーモード中
        <br />
        （優先権オフ）
      </div>
    )
  }

  const priority = board.priority

  if (!priority) {
    return (
      <div className="lf-panel flex h-full min-h-0 flex-col gap-1.5 p-2 text-[10px]">
        <div className="flex shrink-0 items-center justify-between gap-1">
          <span className="font-semibold text-ink">優先権</span>
          <label className="flex shrink-0 items-center gap-1 text-ink-muted">
            <input type="checkbox" checked={autoPass} onChange={(e) => setAutoPass(e.target.checked)} />
            自動パス
          </label>
        </div>
        <InterruptBanner notices={notices} cardOf={cardOf} onDeclare={declareInterrupt} onDismiss={dismiss} />
        {/* 窓が閉じていても提示エリアにカードが残ることがある（PHASE3a-4.md §1-5） */}
        {pendingArea}
        <div className="flex flex-1 items-center justify-center text-ink-faint">
          {pendingCards.length > 0 ? '（提示エリアに未配置のカードがあります）' : '（割り込みなし）'}
        </div>
      </div>
    )
  }

  const current = priority.frames[priority.frames.length - 1]
  const depth = priority.frames.length
  const mine = slotFor(current, localSeat)
  const theirs = slotFor(current, otherSeat(localSeat))
  const awaiting = awaitingSeat(priority)
  const resolving = resolvingSeat(priority)
  // 今まさに解決される宣言（resolvingSeatと同じ判定。resolvingActionは核心ロジックの複製を
  // 避けるためcore/actions.tsのprivateヘルパーと同じ式をここでも直接書く。読み取り専用の表示判定
  // なのでcore/priority.tsに公開APIを増やすまでもない）。
  const resolvingActionObj =
    current.step === 'processActive' ? current.active : current.step === 'processNonActive' ? current.nonActive : null
  // 解決を押したときの行き先。ルールで一意に決まるものだけ（PHASE3a-4.md §1-3）
  const resolveTo = resolveDestinationOf(resolvingActionObj, board, cardOf)

  return (
    <div className="lf-panel flex h-full min-h-0 flex-col gap-1.5 p-2 text-[10px]">
      <div className="flex shrink-0 items-center justify-between gap-1">
        <span className="font-semibold text-ink">優先権</span>
        <label className="flex shrink-0 items-center gap-1 text-ink-muted">
          <input type="checkbox" checked={autoPass} onChange={(e) => setAutoPass(e.target.checked)} />
          自動パス
        </label>
      </div>

      {depth > 1 && (
        <div className="shrink-0 rounded border border-warn bg-warn/30 px-1.5 py-0.5 text-center text-warn">
          割り込み処理中（{depth}段）
        </div>
      )}

      <InterruptBanner notices={notices} cardOf={cardOf} onDeclare={declareInterrupt} onDismiss={dismiss} />

      {pendingArea}

      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <ActionSlot label="自分の宣言" action={mine} onSelectCard={onSelectCard} />
        <ActionSlot label="相手の宣言" action={theirs} onSelectCard={onSelectCard} />
      </div>

      <div className="shrink-0">
        {awaiting !== null &&
          (awaiting === localSeat ? (
            <button
              type="button"
              onClick={() => dispatch({ type: 'passPriority', by: localSeat })}
              className="lf-btn-primary w-full rounded py-1"
            >
              通す（パス）
            </button>
          ) : (
            <div className="text-center text-ink-muted">相手の応答待ち…</div>
          ))}
        {resolving !== null &&
          (resolving === localSeat ? (
            // 🚨「取り消し（手札に戻す）」はPHASE3a-4で削除した。提示した時点で使用したと見なされ
            // （oldrule.txt:828）、処理を行う前に巻き戻すことはできない（oldrule.txt:528）。
            // 打ち消された場合は人間がそのカードをゴミ箱へドラッグする（盤面の雑務）。
            <button
              type="button"
              onClick={() => dispatch({ type: 'resolveStep', to: resolveTo })}
              className="lf-btn-primary w-full rounded py-1"
            >
              解決（完了）
            </button>
          ) : (
            <div className="text-center text-ink-muted">相手が処理中…</div>
          ))}
      </div>
    </div>
  )
}
