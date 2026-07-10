import { CARD_KIND_LABEL, type CostKind, parseCost } from '../core/types'
import type { PoolCard } from '../data/types'

// テキストカード表示が基本形。画像は「あれば載せる」装飾（DESIGN.md §7.5.2）。
// 画像の有無でレイアウトが崩れないことが受け入れ条件なので、
// 画像スロットは常に同じ縦横比で確保し、無いときはテキストの札面を描く。

const COST_STYLE: Record<CostKind, string> = {
  W: 'bg-slate-200 text-slate-900', // その他のコスト
  R: 'bg-red-600 text-white', // 自分消耗
  G: 'bg-green-600 text-white', // 味方消耗
  L: 'bg-amber-400 text-slate-900', // リーダー消耗
  T: 'bg-sky-500 text-white', // タッグ消耗
}

function CostChips({ cost }: { cost: string }) {
  const kinds = parseCost(cost)
  if (kinds.length === 0) return <span className="text-slate-500">コスト無し</span>
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
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 border-b border-slate-700 bg-gradient-to-br from-slate-800 to-slate-900 p-3 text-center">
      <span className="text-[10px] tracking-widest text-slate-500">
        {CARD_KIND_LABEL[card.kind]}
      </span>
      <span className="text-sm font-semibold text-slate-300">{card.name}</span>
      <span className="text-[10px] text-slate-600">画像なし</span>
    </div>
  )
}

export function CardTile({ card, imageUrl }: { card: PoolCard; imageUrl?: string }) {
  return (
    <article className="flex flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-900/60">
      <div className="aspect-[63/88] w-full shrink-0 bg-slate-950">
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
          <div className="text-[10px] text-slate-500">{card.kana}</div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">
            {CARD_KIND_LABEL[card.kind]}
          </span>
          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-400">{card.setVer}</span>
          {card.attr && <span className="text-slate-300">属性 {card.attr}</span>}
        </div>

        <div className="flex items-center gap-1.5 text-[10px]">
          <CostChips cost={card.cost} />
        </div>

        {card.kind === 'b' && (
          <div className="text-[11px] text-slate-300">
            攻:{card.battleAtk} 防:{card.battleDef}
          </div>
        )}

        {card.kiryoku !== null && (
          <div className="text-[11px] text-slate-300">気力 {card.kiryoku}</div>
        )}

        {card.stats && (
          <div className="flex gap-2 text-[10px] text-slate-400">
            {(['力', '早', '賢', '根', '感'] as const).map((a) => (
              <span key={a}>
                {a}
                <span className="ml-0.5 text-slate-200">{card.stats![a]}</span>
              </span>
            ))}
          </div>
        )}

        {card.abilities.length > 0 && (
          <ul className="mt-0.5 flex flex-col gap-1 border-t border-slate-800 pt-1.5">
            {card.abilities.map((ab, i) => (
              <li key={i} className="text-[10px] leading-snug text-slate-400">
                {ab.header && (
                  <span className="mr-1 font-semibold text-slate-200">{ab.header}</span>
                )}
                {ab.text}
              </li>
            ))}
          </ul>
        )}

        {card.printings.length > 0 && (
          <div className="mt-auto pt-1 text-[9px] text-slate-600">
            他の刷り: {card.printings.join(', ')}
          </div>
        )}
      </div>
    </article>
  )
}
