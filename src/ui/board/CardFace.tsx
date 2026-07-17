import { ATTRS, CARD_KIND_LABEL } from '../../core/types'
import type { PoolCard } from '../../data/types'

/**
 * カード面の中身（表向き時）。PHASE2.8.md §2: 画像がある→全面画像、無い→全面テキスト
 * （能力文が主役）。上下分割しない。気力・修正等の「盤面上の状態」はここでは描かない
 * （印刷されていない情報なので、呼び出し側がオーバーレイとして重ねる）。
 */
export function CardFace({
  faceUp,
  imageUrl,
  card,
  name,
  compact,
}: {
  faceUp: boolean
  imageUrl: string | undefined
  card: PoolCard | undefined
  name: string
  /** 盤面上の小さい表示ならtrue。拡大プレビューなら省略 */
  compact?: boolean
}) {
  if (!faceUp) {
    return (
      <div
        className={`flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-700 to-slate-900 text-slate-500 ${compact ? 'text-[9px]' : 'text-xs'}`}
      >
        裏
      </div>
    )
  }

  if (imageUrl) {
    return <img src={imageUrl} alt={name} className="h-full w-full object-cover" />
  }

  const hasStats = !!card?.stats
  const hasBattle = !!(card?.battleAtk || card?.battleDef)
  const hasAbilities = !!card && card.abilities.length > 0

  return (
    <div
      className={`flex h-full w-full flex-col overflow-hidden bg-slate-950 ${compact ? 'gap-0.5 px-1 py-0.5' : 'gap-1.5 px-2.5 py-2'}`}
    >
      <div className={`font-semibold leading-tight text-slate-100 ${compact ? 'text-[9px]' : 'text-sm'}`}>{name}</div>
      {hasStats && (
        <div className={`flex flex-wrap gap-x-1.5 text-slate-400 ${compact ? 'text-[7px]' : 'text-[11px]'}`}>
          {ATTRS.map((a) => (
            <span key={a}>
              {a}
              {card!.stats![a]}
            </span>
          ))}
        </div>
      )}
      {hasBattle && (
        <div className={`text-slate-300 ${compact ? 'text-[7px]' : 'text-[11px]'}`}>
          攻{card?.battleAtk} 防{card?.battleDef}
        </div>
      )}
      {hasAbilities ? (
        <div
          className={`flex-1 overflow-hidden text-slate-300 ${compact ? 'text-[7px] leading-snug' : 'text-[11px] leading-snug'}`}
        >
          {card!.abilities.map((ab, i) => (
            <div key={i} className={i > 0 ? 'mt-0.5' : ''}>
              {ab.header && <span className="font-semibold text-slate-200">{ab.header} </span>}
              {ab.text}
            </div>
          ))}
        </div>
      ) : (
        !hasStats &&
        !hasBattle && (
          <div
            className={`flex flex-1 items-center justify-center text-center text-slate-500 ${compact ? 'text-[8px]' : 'text-xs'}`}
          >
            {card ? CARD_KIND_LABEL[card.kind] : '?'}
          </div>
        )
      )}
    </div>
  )
}
