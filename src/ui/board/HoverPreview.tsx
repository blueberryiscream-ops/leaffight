import { useLayoutEffect, useRef, useState } from 'react'
import type { CardInstance } from '../../core/board'
import type { PoolCard } from '../../data/types'
import { CardFace } from './CardFace'

// ホバーで出す拡大ポップアップ（DESIGN.md §4.17）。0クリック・視線を動かさない。
// 左クリックの詳細パネルとは役割が違う＝見えやすくするだけで、操作は持たない。
//
// 🚨 画面外に見切れないこと（DESIGN.md §4.17・PHASE2.7.md §1.4）。
// 「常にカードの上」に固定すると上端のカードで画面外に出る。空いている側へ自動で反転し、
// ビューポート内にクランプする（標準的なポップアップ配置の作法）。
// 実装: 一度、見えない状態（visibility:hidden）で自然な位置・大きさに描画し、
// レイアウト後に実際のビューポート内の位置を計測してから、最終位置を確定して表示する。

export function HoverPreview({
  instance,
  card,
  imageUrl,
  faceUp,
}: {
  instance: CardInstance
  card: PoolCard | undefined
  imageUrl: string | undefined
  faceUp: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    const anchor = el?.parentElement
    if (!el || !anchor) return
    const previewRect = el.getBoundingClientRect()
    const anchorRect = anchor.getBoundingClientRect()
    const gap = 8
    const vw = window.innerWidth

    // 縦: 上に十分な余白が無ければ下に反転
    const spaceAbove = anchorRect.top
    const placeBelow = spaceAbove < previewRect.height + gap

    // 横: アンカー中心に合わせつつ、ビューポート内にクランプ
    let left = anchorRect.left + anchorRect.width / 2 - previewRect.width / 2
    left = Math.max(gap, Math.min(left, vw - previewRect.width - gap))
    const leftRelativeToAnchor = left - anchorRect.left

    const top = placeBelow ? anchorRect.height + gap : undefined
    const bottom = placeBelow ? undefined : anchorRect.height + gap

    setPos({ left: leftRelativeToAnchor, top, bottom })
  }, [])

  const style: React.CSSProperties = pos
    ? { position: 'absolute', left: pos.left, top: pos.top, bottom: pos.bottom, visibility: 'visible' }
    : { position: 'absolute', left: 0, top: '100%', visibility: 'hidden' }

  return (
    <div
      ref={ref}
      style={style}
      className="pointer-events-none z-50 w-72 overflow-hidden rounded-lg border border-emerald-600 bg-slate-900 shadow-2xl shadow-black/60"
    >
      <div className="aspect-[63/88] w-full">
        <CardFace faceUp={faceUp} imageUrl={imageUrl} card={card} name={card?.name ?? instance.cardId} />
      </div>
    </div>
  )
}
