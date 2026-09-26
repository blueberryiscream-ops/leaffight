import type { BoardState, Seat } from '../../core/board'
import { effectiveStat, modifiersFor } from '../../core/board'
import { ATTRS, CARD_KIND_LABEL } from '../../core/types'
import type { AbilityAnnotation, PoolCard } from '../../data/types'
import { modifierLabel } from './modifierLabel'
import { hiddenFromViewer } from './visibility'

// 右パネル＝詳細＋能力/カードのアクショントリガー（DESIGN.md §4.18・4.17）。
// 左クリックで選ぶ。読み取り専用（気力・修正等の状態変化は右クリックメニューの役目）。
// 宣言はエンジンの「宣言（エンジン）」ボタンだけ（R2u-2 で旧アシストの「起動」ボタンを消した）。

export function DetailPanel({
  iid,
  board,
  mySeat,
  cardOf,
  imageUrlOf,
  annotationsOf,
  engineActions = [],
}: {
  iid: string | null
  board: BoardState
  mySeat: Seat
  cardOf: (cardId: string) => PoolCard | undefined
  imageUrlOf: (cardId: string) => string | undefined
  annotationsOf: (cardId: string) => AbilityAnnotation[] | undefined
  /** エンジンモード（R2u §3-3）: このカードで今宣言できるもの（declare の答え）。押すと宣言を組み立て始める */
  engineActions?: { label: string; onClick: () => void }[]
}) {
  const instance = iid ? board.cards[iid] : undefined

  if (!instance) {
    return (
      <div className="flex h-full flex-col overflow-y-auto p-3 text-xs text-ink-muted">
        <div className="mb-2 font-semibold text-ink">詳細</div>
        <p>カードを左クリックすると、ここに詳細が表示されます。</p>
      </div>
    )
  }

  const card = cardOf(instance.cardId)
  const imageUrl = imageUrlOf(instance.cardId)
  const name = card?.name ?? instance.cardId
  const mods = modifiersFor(board, instance.iid)
  // 🚨 手札だけでなく、裏向き（faceUp===false）の相手のカード全般を伏せる（DESIGN.md §4.21・
  // PHASE5b.md §2-3。デッキで始めたときの裏向きリーダー等）。自分の裏向きカードは自分には見えてよい
  // （実物でも自分は知っている）。デッキは🚨自分のでも隠す（PHASE5c.md §1・4）。
  const hiddenFromMe = hiddenFromViewer(instance, mySeat)
  // キャラ/タッグの attr は「本人の属性」（DESIGN.md §4.8）。i/e/f/b の attr はコスト側の
  // 属性要求なので、ここでは別扱いにしない（従来通りコスト行にまとめる。PHASE3a-2b.md §3-4）
  const isCharLike = card?.kind === 'c' || card?.kind === 't'

  const annotations = annotationsOf(instance.cardId) ?? []
  const annotationByName = new Map(annotations.map((a) => [a.name, a]))

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3 text-xs">
      <div className="mb-2 font-semibold text-ink">詳細</div>

      {hiddenFromMe ? (
        <p className="text-ink-muted">
          {instance.zone === 'deck'
            ? 'デッキのカード（非公開）'
            : instance.zone === 'hand'
              ? '相手の手札（伏せ）'
              : '相手の裏向きのカード'}
        </p>
      ) : (
        <>
          <div className="mb-2 flex gap-2">
            {imageUrl && (
              <img src={imageUrl} alt="" className="aspect-[63/88] w-16 shrink-0 rounded object-cover" />
            )}
            <div>
              <div className="text-sm font-semibold text-ink">{name}</div>
              <div className="text-[10px] text-ink-muted">{card?.kana}</div>
              {card && card.charTypes.length > 0 && (
                <div className="text-[10px] text-ink-muted">
                  {card.charTypes.map((t) => `[${t}]`).join('')}
                </div>
              )}
              <div className="mt-0.5 text-[10px] text-ink-muted">
                {card ? CARD_KIND_LABEL[card.kind] : ''} ・ {instance.owner === mySeat ? '自分' : '相手'} ・ {instance.zone}
              </div>
              {/* 属性(attr)とコスト(cost)は別物・混ぜない（DESIGN.md §4.8。PHASE3a-2b.md §3-4） */}
              {isCharLike && card?.attr && (
                <div className="mt-0.5 text-[10px] text-ink-muted">属性: {card.attr}</div>
              )}
              {card?.cost && <div className="mt-0.5 text-[10px] text-ink-muted">召喚コスト: {card.cost}</div>}
            </div>
          </div>

          {instance.kiryoku !== null && (
            <div className="mb-2 text-ink">気力 {instance.kiryoku}</div>
          )}

          {card?.stats && (
            <div className="mb-2 flex flex-wrap gap-2 text-ink">
              {ATTRS.map((a) => {
                const eff = effectiveStat(board, instance.iid, card.stats![a], a)
                const diff = eff - card.stats![a]
                return (
                  <span key={a}>
                    {a}
                    {eff}
                    {diff !== 0 && <span className="text-[10px] text-ok"> ({diff >= 0 ? '+' : ''}{diff})</span>}
                  </span>
                )
              })}
            </div>
          )}

          {(card?.battleAtk || card?.battleDef) && (
            <div className="mb-2 text-ink">
              攻:{card?.battleAtk} 防:{card?.battleDef}
            </div>
          )}

          {mods.length > 0 && (
            <div className="mb-2">
              <div className="mb-1 font-semibold text-ink-muted">修正</div>
              <ul className="flex flex-col gap-0.5 text-[10px] text-ink-muted">
                {mods.map((m) => (
                  <li key={m.id}>
                    {m.sourceLabel} {modifierLabel(m)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {engineActions.length > 0 && (
            <div className="mb-2">
              <div className="mb-1 font-semibold text-ink-muted">宣言（エンジン）</div>
              <div className="flex flex-wrap gap-1.5">
                {engineActions.map((a, i) => (
                  <button key={i} type="button" onClick={a.onClick} className="rounded border border-accent px-2 py-1 text-accent hover:bg-accent/15">
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {card && card.abilities.length > 0 && (
            <div>
              <div className="mb-1 font-semibold text-ink-muted">能力</div>
              <ul className="flex flex-col gap-1.5">
                {card.abilities.map((ab, i) => {
                  const anno = ab.header ? annotationByName.get(ab.header) : undefined
                  return (
                  <li key={i} className="rounded border border-line-strong bg-surface-2/60 p-1.5">
                    {ab.header && (
                      <div className="flex items-center gap-1.5 font-semibold text-ink">
                        {ab.header}
                        {(ab.auto || ab.cost) && (
                          <span className="text-[10px] font-normal text-ink-muted">{ab.auto ? '常時' : ab.cost}</span>
                        )}
                        {anno && <span className="rounded bg-surface-3 px-1 py-0.5 text-[9px] font-normal text-ink-muted">{anno.type}</span>}
                      </div>
                    )}
                    <div className="text-[10px] leading-snug text-ink-muted">{ab.text}</div>
                  </li>
                  )
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}
