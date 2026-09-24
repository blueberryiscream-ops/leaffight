import { useLayoutEffect, useRef, useState } from 'react'
import type { PoolCard } from '../../data/types'
import { CardFace } from '../board/CardFace'

// デッキ画面のホバー拡大（DESIGN.md §4.21「マウスを乗せる＝拡大」）。
// board/HoverPreview.tsx と同じ「画面内クランプ」の考え方だが、あちらは盤面の CardInstance
// （iid/zone等）に結びついた作りで、デッキの格子（PoolCard そのもの・盤面インスタンスではない）
// には流用しづらい。カードは常に表向きなので faceUp 固定でよく、ロジックだけ複製した
// 軽量版をここに置く（判断: PHASE5a.md §4「無理なら見本の.preview相当を作る」に該当。HANDOFF参照）。

export function CardPreview({ card, imageUrl }: { card: PoolCard; imageUrl: string | undefined }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    const anchor = el?.parentElement
    if (!el || !anchor) return
    const previewRect = el.getBoundingClientRect()
    const anchorRect = anchor.getBoundingClientRect()
    const gap = 8
    const vw = window.innerWidth
    const vh = window.innerHeight

    const spaceAbove = anchorRect.top
    const placeBelow = spaceAbove < previewRect.height + gap
    let top = placeBelow ? anchorRect.bottom + gap : anchorRect.top - previewRect.height - gap
    top = Math.max(gap, Math.min(top, vh - previewRect.height - gap))
    const topRelativeToAnchor = top - anchorRect.top

    let left = anchorRect.left + anchorRect.width / 2 - previewRect.width / 2
    left = Math.max(gap, Math.min(left, vw - previewRect.width - gap))
    const leftRelativeToAnchor = left - anchorRect.left

    setPos({ left: leftRelativeToAnchor, top: topRelativeToAnchor })
  }, [])

  const style: React.CSSProperties = pos
    ? { position: 'absolute', left: pos.left, top: pos.top, visibility: 'visible' }
    : { position: 'absolute', left: 0, top: '100%', visibility: 'hidden' }

  return (
    <div
      ref={ref}
      style={style}
      className="pointer-events-none z-50 w-64 overflow-hidden rounded-lg lf-card-rim bg-surface-1"
    >
      <div className="aspect-[63/88] w-full">
        <CardFace faceUp imageUrl={imageUrl} card={card} name={card.name} />
      </div>
    </div>
  )
}
