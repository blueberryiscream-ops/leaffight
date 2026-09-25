import type { BoardAction } from '../../core/actions'
import type { BoardState, Seat } from '../../core/board'
import { effectiveStat, modifiersFor } from '../../core/board'
import type { ActionTiming } from '../../core/priority'
import { ATTRS, CARD_KIND_LABEL } from '../../core/types'
import type { AbilityAnnotation, PoolCard } from '../../data/types'
import { modifierLabel } from './modifierLabel'
import { hiddenFromViewer } from './visibility'

// 起動型能力の注釈type → 優先権エンジンのactionType。複合型（通常起動+割込起動）は
// より許容的な「割込型」に寄せる（coreはactionTypeの中身で分岐しないので表示・記録用の割り切り）。
function toActionTiming(annotationType: AbilityAnnotation['type']): ActionTiming {
  return annotationType === '通常起動' ? '通常型' : '割込型'
}

// 右パネル＝詳細＋能力/カードのアクショントリガー（DESIGN.md §4.18・4.17）。
// 左クリックで選ぶ。読み取り専用（気力・修正等の状態変化は右クリックメニューの役目）。
// 「起動」ボタンはユーザー校正済みの注釈（起動型/常時＋コスト）を見せているだけで、
// 効果の解決・合法性は判定しない（DESIGN.md §5.1「あえて作らない」）。

export function DetailPanel({
  iid,
  board,
  mySeat,
  cardOf,
  imageUrlOf,
  annotationsOf,
  dispatch,
}: {
  iid: string | null
  board: BoardState
  mySeat: Seat
  cardOf: (cardId: string) => PoolCard | undefined
  imageUrlOf: (cardId: string) => string | undefined
  annotationsOf: (cardId: string) => AbilityAnnotation[] | undefined
  dispatch: (action: BoardAction) => void
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
  // 「自分のターン」で出し分けない（原典§11-2/§4.15。PHASE3a-2b.md §1）。
  // 自分の所有カードなら常に押せる。合法性・タイミングの判定は人間がやる
  const triggerable = instance.owner === mySeat && board.mode === 'assist' ? annotations.filter((a) => a.type !== '常時') : []

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

          {triggerable.length > 0 && (
            <div className="mb-2">
              <div className="mb-1 font-semibold text-ink-muted">起動</div>
              <div className="flex flex-wrap gap-1.5">
                {triggerable.map((a) => (
                  <button
                    key={a.name}
                    type="button"
                    onClick={() =>
                      dispatch({
                        type: 'declareAction',
                        action: {
                          by: mySeat,
                          kind: '能力',
                          actionType: toActionTiming(a.type),
                          sourceIid: instance.iid,
                          label: a.name,
                          detail: a.cost,
                        },
                      })
                    }
                    className="rounded border border-accent px-2 py-1 text-accent hover:bg-accent/15"
                  >
                    {a.name}（{a.cost}）
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
