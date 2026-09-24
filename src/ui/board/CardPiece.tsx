import { useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import type { BoardAction } from '../../core/actions'
import type { CardInstance, Seat } from '../../core/board'
import { effectiveStat, modifiersFor } from '../../core/board'
import type { BoardState } from '../../core/board'
import { ATTRS } from '../../core/types'
import type { PoolCard } from '../../data/types'
import { CardFace } from './CardFace'
import { HoverPreview } from './HoverPreview'

/**
 * 消耗時の回転角（-90°）を1か所にまとめる（PHASE3d-3.md §4）。orientation==='rested' の他、
 * zone==='battle' かつ used===true（使用済みバトルカード）も同じ-90°にする。両方立っていても
 * 回転は-90°1回だけ（elseにしない＝どちらか一方でも-90、両方でも-90）。
 * StackedCardSlot.tsx（スタックのtarget回転）とCardPiece自身（tap）の両方から呼ぶ。
 */
export function tapRotation(instance: CardInstance): number {
  return instance.orientation === 'rested' || (instance.zone === 'battle' && instance.used === true) ? -90 : 0
}

// 盤面上の1枚。操作の割り当ては DESIGN.md §4.17:
//   ホバー   → すぐ近くに拡大ポップアップ（0クリック）
//   左クリック → 詳細パネルで選択（Board.tsx側の右パネルに表示）
//   左ダブルクリック → ゾーンで意味が違う（PHASE5c.md §3）:
//     char・battle・leader → 待機⇔消耗（従来どおり）
//     deck（自分の持ち主のときだけ）→ 一番上の1枚を手札へ（1枚ドロー）
//     それ以外（hand・trash・field・pending）→ 何もしない
//   右クリック → 状態変化メニュー（Board.tsx側で浮かせる CardContextMenu）
//
// サイズは呼び出し側（Board.tsx）がpxで渡す（DESIGN.md §4.18.1）。
// CSSのaspect-ratio/max-widthのパーセンテージ計算には頼らない
// （P2.6で「幅未確定の要素にaspect-ratio+%を使うと循環参照で最初の1枚だけ
// 小さく描画される」というバグを踏んだため。IMPLEMENTATION-NOTES.md参照）。
// カード自体は常に「縦向きの自然な大きさ」(w×h)で描画し、消耗時は
// transform:rotate(90deg)で見た目だけ回転させる（マス＝正方形はP2.7で
// 呼び出し側が確保する。ここでは回転後にはみ出さないよう心配しない）。

export function CardPiece({
  instance,
  card,
  imageUrl,
  backImageUrl,
  board,
  dispatch,
  onClick,
  onContextMenu,
  size,
  dragDisabled,
  hidden,
  mySeat,
  selected,
  flipped,
  groupRotate,
  attachBadgeOverride,
  battleBadge,
  battleRing,
  battleRingLabel,
}: {
  instance: CardInstance
  card: PoolCard | undefined
  imageUrl: string | undefined
  /** カード裏面の画像（PHASE2.11.md §4）。呼び出し側が imageUrlOf(CARD_BACK_IMAGE_ID) で渡す */
  backImageUrl?: string
  board: BoardState
  dispatch: (action: BoardAction) => void
  /** 左クリック→詳細選択 */
  onClick: () => void
  /** 右クリック→状態変化メニューを開く（座標はBoard.tsx側で浮かせるため渡す） */
  onContextMenu: (clientX: number, clientY: number) => void
  /** カードの自然な（縦向き・未回転の）サイズ(px)。呼び出し側が計算して渡す */
  size: { w: number; h: number }
  dragDisabled?: boolean
  /**
   * 相手の手札を伏せるためのフラグ（PHASE2.5.md §2.3）。カード自体の faceUp（ゲーム内の表裏）
   * とは別に、「このクライアントの画面には見せない」という描画専用の上書き。
   * 操作は塞がない（掴んで動かすことはできる。見えないだけ）。
   */
  hidden?: boolean
  /**
   * ダブルクリックの「デッキは持ち主が自分のときだけ1枚ドロー」判定に使う（PHASE5c.md §3）。
   * デッキを描画しない呼び出し元（StackedCardSlotのchar/battle/leader/field）は渡さなくてよい
   * （zoneがdeckにならないため、この判定自体が発火しない）。
   */
  mySeat?: Seat
  /** 詳細パネルで選択中のカードを軽く強調する */
  selected?: boolean
  /**
   * 相手が置いたカードを180°反転して見せる（PHASE2.9b.md §2-1）。owner!==mySeatをBoard側が渡す。
   * 手札/デッキ/ゴミ箱（向きに意味がない束）には渡さない。
   */
  flipped?: boolean
  /**
   * アイテムを重ねたスタック内で使う（PHASE2.9c.md §2-4）。指定時は instance.orientation/flipped を
   * 見ず、この角度・原点で回転する（対象＋付随アイテムが同じ軸で1つの剛体として回るようにするため）。
   * origin は各カード自身の左上を基準にしたCSS transform-origin値（例 "23px 40px"）。
   * ここを起点にすることで、スタック全体を包む要素自体は回転させずに済み、
   * HoverPreview（回転しない兄弟要素）が親の回転を巻き込まれる問題を避けられる。
   */
  groupRotate?: { deg: number; origin: string }
  /**
   * 🔗バッジの件数を上書きする（PHASE2.9c.md §1-5）。スタック内の対象カードは重ね表示自体で
   * 付随数が見えるためバッジは冗長＝0を渡して隠す。付与数が多く重ねが窮屈な時だけ
   * `StackedCardSlot`側から実数を渡して「+N」相当として出す。未指定時は自分で数える（従来通り）。
   */
  attachBadgeOverride?: number
  /**
   * バトル中の参加キャラ／バトル種目カードの目印（PHASE3d-2b §1）。盤面上でひと目分かるよう
   * ⚔バッジを出す。判定（誰が参加中か等）はBoard.tsx側（board.battleを見て）が行う。
   */
  battleBadge?: boolean
  /**
   * 盤面クリックでの参加キャラ・種目選択（PHASE3d-3 §1）。候補＝点線リング、選択中＝実線リング＋バッジ。
   * StackedCardSlotのtargetにだけ渡す（付随アイテムには出さない＝battleBadgeと同じ流儀）。
   */
  battleRing?: 'candidate' | 'selected'
  battleRingLabel?: string
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: instance.iid,
    disabled: dragDisabled,
  })
  const [hovered, setHovered] = useState(false)

  // 向き（PHASE2.9b.md §2-1）: 相手のカードは180°反転、消耗は上部が自分から見て左に来るよう-90°。
  // グループ回転中（PHASE2.9c.md §2-4）は外から角度・原点を指定されるので自分では計算しない。
  const base = flipped ? 180 : 0
  const tap = tapRotation(instance)
  const rotate = groupRotate ? groupRotate.deg : base + tap
  const style = {
    width: size.w,
    height: size.h,
    transform: transform
      ? `${CSS.Translate.toString(transform)} rotate(${rotate}deg)`
      : `rotate(${rotate}deg)`,
    transformOrigin: groupRotate?.origin,
    opacity: isDragging ? 0.35 : 1,
  }

  const mods = modifiersFor(board, instance.iid)
  const attachedCount =
    attachBadgeOverride ?? Object.values(board.cards).filter((c) => c.attachedTo === instance.iid).length
  const faceUp = hidden ? false : instance.faceUp
  const name = card?.name ?? instance.cardId

  return (
    <div
      className="relative shrink-0"
      style={{ width: size.w, height: size.h }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        ref={setNodeRef}
        type="button"
        style={style}
        data-iid={instance.iid}
        data-orientation={instance.orientation}
        {...attributes}
        {...listeners}
        onClick={onClick}
        onDoubleClick={(e) => {
          e.stopPropagation()
          if (instance.zone === 'char' || instance.zone === 'battle' || instance.zone === 'leader') {
            dispatch({ type: 'toggleOrientation', iid: instance.iid, cardName: name })
          } else if (instance.zone === 'deck') {
            // 相手のデッキは何もしない。自分のデッキなら一番上の1枚をドロー（PHASE5c.md §3）
            if (instance.owner === mySeat) {
              dispatch({ type: 'moveCard', iid: instance.iid, toZone: 'hand', cardName: name })
            }
          }
          // hand・trash・field・pending は何もしない
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          onContextMenu(e.clientX, e.clientY)
        }}
        className={`lf-card-rim relative flex shrink-0 touch-none select-none flex-col overflow-hidden rounded-md border border-transparent bg-surface-1 text-left transition-colors hover:border-accent ${
          // 🚨 battleRing===selected（参加/種目に決定済み）を detail パネルの selected（黄色）より優先する。
          // §1のクリックは selected(setSelectedIid) も同時に行うため、優先度が逆だと参加リングが常に
          // 隠れてしまう（実機で発覚。PHASE3d-3 §7の煙試験で確認）。
          battleRing === 'selected'
            ? 'outline-2 outline-offset-2 outline-accent'
            : selected
              ? 'outline-2 outline-offset-2 outline-warn'
              : battleRing === 'candidate'
                ? 'outline-2 outline-dashed outline-offset-2 outline-accent/70'
                : ''
        }`}
      >
        <CardFace faceUp={faceUp} imageUrl={imageUrl} card={card} name={name} compact backImageUrl={backImageUrl} />

        {/* オーバーレイ: 印刷されていない「今の状態」。画像/テキストどちらの上にも重ねる（PHASE2.8.md §2） */}
        {faceUp && (instance.kiryoku !== null || mods.length > 0) && (
          <div className="pointer-events-none absolute inset-x-0.5 bottom-0.5 flex flex-col items-start gap-0.5">
            {instance.kiryoku !== null && (
              <span className="rounded bg-surface-0/85 px-1 text-[8px] font-bold text-ok">
                気{instance.kiryoku}
              </span>
            )}
            {mods.length > 0 && (
              <div className="flex flex-wrap gap-0.5">
                {ATTRS.filter((a) => mods.some((m) => m.stat === a)).map((a) => {
                  const base = card?.stats?.[a] ?? 0
                  const eff = effectiveStat(board, instance.iid, base, a)
                  const diff = eff - base
                  return (
                    <span
                      key={a}
                      className={`rounded px-0.5 text-[7px] ${diff >= 0 ? 'bg-ok/90 text-on-accent' : 'bg-danger/90 text-on-accent'}`}
                    >
                      {a}
                      {diff >= 0 ? '+' : ''}
                      {diff}
                    </span>
                  )
                })}
              </div>
            )}
          </div>
        )}

        <AttachBadge count={attachedCount} />
        {battleBadge && (
          <span className="absolute left-0.5 top-0.5 rounded-full bg-danger px-1 text-[8px] font-bold text-white">
            ⚔
          </span>
        )}
        {battleRing === 'selected' && battleRingLabel && (
          <span className="absolute bottom-0.5 right-0.5 rounded bg-accent px-1 text-[7px] font-bold text-on-accent">
            {battleRingLabel}
          </span>
        )}
      </button>

      {hovered && !isDragging && (
        <HoverPreview instance={instance} card={card} imageUrl={imageUrl} faceUp={faceUp} backImageUrl={backImageUrl} />
      )}
    </div>
  )
}

function AttachBadge({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <span className="absolute right-0.5 top-0.5 rounded-full bg-accent px-1 text-[8px] font-bold text-on-accent">
      🔗{count}
    </span>
  )
}
