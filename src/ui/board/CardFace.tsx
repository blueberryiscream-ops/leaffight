import { ATTRS, CARD_KIND_LABEL } from '../../core/types'
import type { PoolCard } from '../../data/types'

// 使用代償の表記（確定 2026-07-18・PHASE2.9a.md §2-1）: costとattrを連結してそのまま出す
// （例 cost="WWW",attr="力" → "WWW力"）。両方空の時だけ行を出さない。
// 将来アイコン化する可能性があるため、文字列生成をここに切り出しておく。
// ⚠️ 一部カードはcost欄に解析ノイズ（「味方」「気」等）が混入している（データ側の掃除案件）。
// 表示側では加工せずそのまま出す。
function formatCost(card: PoolCard | undefined): string {
  return (card?.cost ?? '') + (card?.attr ?? '')
}

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
  backImageUrl,
}: {
  faceUp: boolean
  imageUrl: string | undefined
  card: PoolCard | undefined
  name: string
  /** 盤面上の小さい表示ならtrue。拡大プレビューなら省略 */
  compact?: boolean
  /** カード裏面の画像（PHASE2.11.md §4。利用者提供・権利物なのでデータzip経由）。無ければ従来の「裏」表示 */
  backImageUrl?: string
}) {
  if (!faceUp) {
    if (backImageUrl) {
      return <img src={backImageUrl} alt="裏面" className="h-full w-full object-cover" />
    }
    return (
      <div
        className={`flex h-full w-full items-center justify-center bg-gradient-to-br from-surface-3 to-surface-1 text-ink-muted ${compact ? 'text-[9px]' : 'text-xs'}`}
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
  const cost = formatCost(card)

  return (
    <div
      className={`flex h-full w-full flex-col overflow-hidden bg-surface-0 ${compact ? 'gap-0.5 px-1 py-0.5' : 'gap-1.5 px-2.5 py-2'}`}
    >
      <div className={`font-semibold leading-tight text-ink ${compact ? 'text-[11px]' : 'text-sm'}`}>{name}</div>
      {cost !== '' && (
        <div className={`text-ink-muted ${compact ? 'text-[10px]' : 'text-[11px]'}`}>{cost}</div>
      )}
      {hasStats && (
        <div className={`flex flex-wrap gap-x-1.5 text-ink-muted ${compact ? 'text-[10px]' : 'text-[11px]'}`}>
          {ATTRS.map((a) => (
            <span key={a}>
              {a}
              {card!.stats![a]}
            </span>
          ))}
        </div>
      )}
      {hasBattle && (
        <div className={`text-ink ${compact ? 'text-[10px]' : 'text-[11px]'}`}>
          攻{card?.battleAtk} 防{card?.battleDef}
        </div>
      )}
      {hasAbilities ? (
        <div
          className={`flex-1 overflow-hidden text-ink ${compact ? 'text-[9px] leading-snug' : 'text-[11px] leading-snug'}`}
        >
          {card!.abilities.map((ab, i) => (
            <div key={i} className={i > 0 ? 'mt-0.5' : ''}>
              {ab.header && <span className="font-semibold text-ink">{ab.header} </span>}
              {ab.text}
            </div>
          ))}
        </div>
      ) : (
        !hasStats &&
        !hasBattle && (
          <div
            className={`flex flex-1 items-center justify-center text-center text-ink-muted ${compact ? 'text-[8px]' : 'text-xs'}`}
          >
            {card ? CARD_KIND_LABEL[card.kind] : '?'}
          </div>
        )
      )}
    </div>
  )
}
