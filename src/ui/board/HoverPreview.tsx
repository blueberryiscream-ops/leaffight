import type { CardInstance } from '../../core/board'
import { CARD_KIND_LABEL } from '../../core/types'
import type { PoolCard } from '../../data/types'

// ホバーで出す拡大ポップアップ（DESIGN.md §4.17）。0クリック・視線を動かさない。
// 左クリックの詳細パネルとは役割が違う＝見えやすくするだけで、操作は持たない。

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
  return (
    <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-40 -translate-x-1/2 overflow-hidden rounded-lg border border-emerald-600 bg-slate-900 shadow-2xl shadow-black/60">
      {!faceUp ? (
        <div className="flex aspect-[63/88] w-full items-center justify-center bg-gradient-to-br from-slate-700 to-slate-900 text-xs text-slate-500">
          裏
        </div>
      ) : (
        <>
          <div className="aspect-[63/88] w-full bg-slate-950">
            {imageUrl ? (
              <img src={imageUrl} alt="" className="h-full w-full object-contain" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-center text-xs text-slate-500">
                {card ? CARD_KIND_LABEL[card.kind] : '?'}
              </div>
            )}
          </div>
          <div className="p-1.5">
            <div className="text-xs font-semibold leading-tight text-slate-100">{card?.name ?? instance.cardId}</div>
            {card?.stats && (
              <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-slate-400">
                {(['力', '早', '賢', '根', '感'] as const).map((a) => (
                  <span key={a}>
                    {a}
                    {card.stats![a]}
                  </span>
                ))}
              </div>
            )}
            {(card?.battleAtk || card?.battleDef) && (
              <div className="mt-1 text-[10px] text-slate-300">
                攻:{card?.battleAtk} 防:{card?.battleDef}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
