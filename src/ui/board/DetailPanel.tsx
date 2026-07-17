import type { BoardState, Seat } from '../../core/board'
import { effectiveStat, modifiersFor } from '../../core/board'
import { ATTRS, CARD_KIND_LABEL } from '../../core/types'
import type { PoolCard } from '../../data/types'

// 右パネル＝詳細＋能力/カードのアクショントリガー（DESIGN.md §4.18・4.17）。
// 左クリックで選ぶ。読み取り専用（状態変化は右クリックメニューの役目）。
// 「能力トリガー」は abilities[] を一覧表示するところまで（P2.6の範囲）。押しても何もしない
// （スタックに乗るのはP3。DESIGN.md §5.1）。

export function DetailPanel({
  iid,
  board,
  mySeat,
  cardOf,
  imageUrlOf,
}: {
  iid: string | null
  board: BoardState
  mySeat: Seat
  cardOf: (cardId: string) => PoolCard | undefined
  imageUrlOf: (cardId: string) => string | undefined
}) {
  const instance = iid ? board.cards[iid] : undefined

  if (!instance) {
    return (
      <div className="flex h-full flex-col overflow-y-auto p-3 text-xs text-slate-500">
        <div className="mb-2 font-semibold text-slate-300">詳細</div>
        <p>カードを左クリックすると、ここに詳細が表示されます。</p>
      </div>
    )
  }

  const card = cardOf(instance.cardId)
  const imageUrl = imageUrlOf(instance.cardId)
  const name = card?.name ?? instance.cardId
  const mods = modifiersFor(board, instance.iid)
  const hiddenFromMe = instance.owner !== mySeat && instance.zone === 'hand'

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3 text-xs">
      <div className="mb-2 font-semibold text-slate-300">詳細</div>

      {hiddenFromMe ? (
        <p className="text-slate-500">相手の手札（伏せ）</p>
      ) : (
        <>
          <div className="mb-2 flex gap-2">
            {imageUrl && (
              <img src={imageUrl} alt="" className="aspect-[63/88] w-16 shrink-0 rounded object-cover" />
            )}
            <div>
              <div className="text-sm font-semibold text-slate-100">{name}</div>
              <div className="text-[10px] text-slate-500">{card?.kana}</div>
              <div className="mt-0.5 text-[10px] text-slate-400">
                {card ? CARD_KIND_LABEL[card.kind] : ''} ・ {instance.owner === mySeat ? '自分' : '相手'} ・ {instance.zone}
              </div>
            </div>
          </div>

          {instance.kiryoku !== null && (
            <div className="mb-2 text-slate-300">気力 {instance.kiryoku}</div>
          )}

          {card?.stats && (
            <div className="mb-2 flex flex-wrap gap-2 text-slate-300">
              {ATTRS.map((a) => {
                const eff = effectiveStat(board, instance.iid, card.stats![a], a)
                const diff = eff - card.stats![a]
                return (
                  <span key={a}>
                    {a}
                    {eff}
                    {diff !== 0 && <span className="text-[10px] text-emerald-400"> ({diff >= 0 ? '+' : ''}{diff})</span>}
                  </span>
                )
              })}
            </div>
          )}

          {(card?.battleAtk || card?.battleDef) && (
            <div className="mb-2 text-slate-300">
              攻:{card?.battleAtk} 防:{card?.battleDef}
            </div>
          )}

          {mods.length > 0 && (
            <div className="mb-2">
              <div className="mb-1 font-semibold text-slate-400">修正</div>
              <ul className="flex flex-col gap-0.5 text-[10px] text-slate-400">
                {mods.map((m) => (
                  <li key={m.id}>
                    {m.sourceLabel} {m.stat ? `${m.stat}${(m.delta ?? 0) >= 0 ? '+' : ''}${m.delta}` : m.note} ({m.scope})
                  </li>
                ))}
              </ul>
            </div>
          )}

          {card && card.abilities.length > 0 && (
            <div>
              <div className="mb-1 font-semibold text-slate-400">能力（P3でトリガー実装予定）</div>
              <ul className="flex flex-col gap-1.5">
                {card.abilities.map((ab, i) => (
                  <li key={i} className="rounded border border-slate-700 bg-slate-800/60 p-1.5">
                    {ab.header && <div className="font-semibold text-slate-200">{ab.header}</div>}
                    <div className="text-[10px] leading-snug text-slate-400">{ab.text}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}
