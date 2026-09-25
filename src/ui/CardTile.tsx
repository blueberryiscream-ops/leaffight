import { CARD_KIND_LABEL, type CostKind, parseCost } from '../core/types'
import type { PoolCard } from '../data/types'

// テキストカード表示が基本形。画像は「あれば載せる」装飾（DESIGN.md §7.5.2）。
// 画像の有無でレイアウトが崩れないことが受け入れ条件なので、
// 画像スロットは常に同じ縦横比で確保し、無いときはテキストの札面を描く。

const COST_STYLE: Record<CostKind, string> = {
  W: 'bg-ink text-on-accent', // その他のコスト
  R: 'bg-danger text-on-accent', // 自分消耗
  G: 'bg-ok text-on-accent', // 味方消耗
  L: 'bg-warn text-on-accent', // リーダー消耗
  T: 'bg-accent text-on-accent', // タッグ消耗
}

function CostChips({ cost }: { cost: string }) {
  const kinds = parseCost(cost)
  if (kinds.length === 0) return <span className="text-ink-muted">コスト無し</span>
  return (
    <span className="flex gap-0.5">
      {kinds.map((k, i) => (
        <span
          key={i}
          className={`inline-flex h-4 w-4 items-center justify-center rounded-sm text-[10px] font-bold ${COST_STYLE[k]}`}
        >
          {k}
        </span>
      ))}
    </span>
  )
}

function CardFace({ card }: { card: PoolCard }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 border-b border-line-strong bg-gradient-to-br from-surface-2 to-surface-1 p-3 text-center">
      <span className="text-[10px] tracking-widest text-ink-muted">
        {CARD_KIND_LABEL[card.kind]}
      </span>
      <span className="text-sm font-semibold text-ink">{card.name}</span>
      <span className="text-[10px] text-ink-faint">画像なし</span>
    </div>
  )
}

export function CardTile({ card, imageUrl }: { card: PoolCard; imageUrl?: string }) {
  return (
    <article className="flex flex-col overflow-hidden rounded-lg border border-line-strong bg-surface-1/60">
      <div className="aspect-[63/88] w-full shrink-0 bg-surface-0">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={card.name}
            loading="lazy"
            className="h-full w-full object-contain"
          />
        ) : (
          <CardFace card={card} />
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-2.5 text-xs">
        <div>
          <div className="font-semibold leading-tight">{card.name}</div>
          <div className="text-[10px] text-ink-muted">{card.kana}</div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-ink">
            {CARD_KIND_LABEL[card.kind]}
          </span>
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-ink-muted">{card.setVer}</span>
          {card.attr && <span className="text-ink">属性 {card.attr}</span>}
        </div>

        <div className="flex items-center gap-1.5 text-[10px]">
          <CostChips cost={card.cost} />
        </div>

        {card.kind === 'b' && (
          <div className="text-[11px] text-ink">
            攻:{card.battleAtk} 防:{card.battleDef}
          </div>
        )}

        {card.kiryoku !== null && (
          <div className="text-[11px] text-ink">気力 {card.kiryoku}</div>
        )}

        {card.stats && (
          <div className="flex gap-2 text-[10px] text-ink-muted">
            {(['力', '早', '賢', '根', '感'] as const).map((a) => (
              <span key={a}>
                {a}
                <span className="ml-0.5 text-ink">{card.stats![a]}</span>
              </span>
            ))}
          </div>
        )}

        {card.abilities.length > 0 && (
          <ul className="mt-0.5 flex flex-col gap-1 border-t border-line pt-1.5">
            {card.abilities.map((ab, i) => (
              <li key={i} className="text-[10px] leading-snug text-ink-muted">
                {ab.header && (
                  <span className="mr-1 font-semibold text-ink">
                    {ab.header}
                    {(ab.auto || ab.cost) && <span className="ml-1 font-normal">{ab.auto ? '常時' : ab.cost}</span>}
                  </span>
                )}
                {ab.text}
              </li>
            ))}
          </ul>
        )}

        {card.printings.length > 0 && (
          <div className="mt-auto pt-1 text-[9px] text-ink-faint">
            他の刷り: {card.printings.join(', ')}
          </div>
        )}
      </div>
    </article>
  )
}
