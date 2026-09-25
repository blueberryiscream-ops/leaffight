import { useMemo, useState } from 'react'
import {
  ATTRS,
  CARD_KIND_LABEL,
  CARD_KINDS,
  COST_KINDS,
  type Attr,
  type Card,
  type CardKind,
  type CostKind,
} from '../../core/types'
import { searchKey } from '../../core/name'
import { deckTotal, exportDeckText, probNoChar, sampleHand, validateDeck, type Deck } from '../../data/deck'
import type { PoolCard } from '../../data/types'
import { CardFace } from '../board/CardFace'
import { CardPreview } from './CardPreview'
import { DrawModal, ExportModal } from './modals'

// デッキ編集画面（見本 `_local/デッキ構築の雛形.html` の #v-edit・DESIGN.md §4.21）。
// 左＝カード置き場（検索・並び順・絞り込み・格子）、右＝デッキ（名前・リーダー・検証・保存等）。

const COST_LABEL: Record<CostKind, string> = { W: '白', R: '赤', L: '黄', T: '青', G: '緑' }
type Sort = 'kind' | 'name' | 'kiryoku'

function abilityText(c: PoolCard): string {
  return c.abilities.map((a) => a.header + a.cost + (a.auto ? '常時' : '') + a.text).join(' ')
}

export function DeckEditor({
  deck,
  isNew,
  cards,
  cardById,
  imageUrls,
  importErrors,
  autoOpenExport,
  onSave,
  onDelete,
  onBack,
}: {
  deck: Deck
  isNew: boolean
  cards: PoolCard[]
  cardById: Map<string, Card>
  imageUrls: Map<string, string>
  importErrors: string[]
  autoOpenExport: boolean
  onSave: (deck: Deck) => Promise<Deck>
  onDelete: (id: string) => Promise<void>
  onBack: () => void
}) {
  const [working, setWorking] = useState<Deck>(deck)
  const [savedSnapshot, setSavedSnapshot] = useState<Deck>(deck)
  const [saveLabel, setSaveLabel] = useState('保存')
  const [showDraw, setShowDraw] = useState(false)
  const [drawHand, setDrawHand] = useState<PoolCard[]>([])
  const [showExport, setShowExport] = useState(autoOpenExport)
  const [hovered, setHovered] = useState<PoolCard | null>(null)

  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('kind')
  const [kindFilter, setKindFilter] = useState<Set<CardKind>>(new Set())
  const [attrFilter, setAttrFilter] = useState<Set<Attr>>(new Set())
  const [costFilter, setCostFilter] = useState<Set<CostKind>>(new Set())

  const dirty = JSON.stringify(working) !== JSON.stringify(savedSnapshot)

  function guardLeave(action: () => void) {
    if (dirty && !confirm('保存していない変更があります。破棄してよろしいですか？')) return
    action()
  }

  function setCount(cardId: string, delta: number) {
    setWorking((prev) => {
      const n = (prev.counts[cardId] ?? 0) + delta
      if (n < 0 || n > 4) return prev
      const counts = { ...prev.counts, [cardId]: n }
      if (n === 0) delete counts[cardId]
      let leaderCardId = prev.leaderCardId
      if (leaderCardId === cardId && n === 0) leaderCardId = null
      return { ...prev, counts, leaderCardId }
    })
  }

  const visiblePool = useMemo(() => {
    const q = searchKey(query)
    let list = cards.filter((c) => {
      if (kindFilter.size > 0 && !kindFilter.has(c.kind)) return false
      if (attrFilter.size > 0 && ![...attrFilter].some((a) => c.attr.includes(a))) return false
      if (costFilter.size > 0 && ![...costFilter].some((k) => c.cost.includes(k))) return false
      if (q && !searchKey(c.name).includes(q) && !searchKey(c.kana).includes(q) && !searchKey(abilityText(c)).includes(q)) {
        return false
      }
      return true
    })
    list = [...list].sort(
      sort === 'name'
        ? (a, b) => a.name.localeCompare(b.name, 'ja')
        : sort === 'kiryoku'
          ? (a, b) => (b.kiryoku ?? -1) - (a.kiryoku ?? -1)
          : (a, b) => CARD_KINDS.indexOf(a.kind) - CARD_KINDS.indexOf(b.kind),
    )
    return list
  }, [cards, query, sort, kindFilter, attrFilter, costFilter])

  const inDeck = cards.filter((c) => (working.counts[c.id] ?? 0) > 0)
  const validation = validateDeck(working, cardById)
  const total = deckTotal(working)
  const leaderCandidates = inDeck.filter((c) => c.kind === 'c')
  const leaderCard = working.leaderCardId ? cardById.get(working.leaderCardId) : undefined
  const leaderImg = leaderCard ? imageUrls.get(leaderCard.id) : undefined
  const nChar = validation.charCount
  const deckSizeAfterLeader = Math.max(0, total - 1)
  const prob = deckSizeAfterLeader > 0 ? probNoChar(deckSizeAfterLeader, Math.max(0, nChar - (validation.leaderOk ? 1 : 0)), 7) : null

  function toggle<T>(set: Set<T>, v: T, setter: (s: Set<T>) => void) {
    const next = new Set(set)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    setter(next)
  }

  async function handleSave() {
    const saved = await onSave(working)
    setWorking(saved)
    setSavedSnapshot(saved)
    setSaveLabel('保存しました')
    setTimeout(() => setSaveLabel('保存'), 1200)
  }

  function handleDraw() {
    const rng = () => Math.random()
    const hand = sampleHand(working, rng)
      .map((id) => cardById.get(id))
      .filter((c): c is Card => !!c) as PoolCard[]
    setDrawHand(hand)
    setShowDraw(true)
  }

  const exportText = exportDeckText(working, cardById)

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          className="rounded border border-line-strong px-2.5 py-1 text-xs"
          onClick={() => guardLeave(onBack)}
        >
          ← デッキ一覧
        </button>
        {isNew && <span className="text-xs text-ink-muted">まだ保存されていません</span>}
      </div>

      {importErrors.length > 0 && (
        <div className="mb-3 rounded border border-warn/60 bg-surface-1 p-2.5 text-xs text-warn">
          <b>取り込みで読めなかった行があります（{importErrors.length}件）:</b>
          <ul className="mt-1 list-disc pl-4">
            {importErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* 左: カード置き場 */}
        <div className="rounded-lg p-2.5 lf-panel">
          <div className="mb-2.5 grid gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                className="min-w-[200px] flex-1 rounded-md border border-line-strong bg-surface-0 px-2.5 py-1.5 text-sm"
                placeholder="名前・かな・効果文で検索（例: 気力、ゴミ箱）"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select
                className="rounded-md border border-line-strong bg-surface-0 px-2 py-1 text-sm"
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
              >
                <option value="kind">種類順</option>
                <option value="name">名前順</option>
                <option value="kiryoku">気力順</option>
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-16 text-xs text-ink-muted">種類</span>
              {CARD_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${
                    kindFilter.has(k) ? 'border-accent bg-accent font-bold text-on-accent' : 'border-line-strong'
                  }`}
                  onClick={() => toggle(kindFilter, k, setKindFilter)}
                >
                  {CARD_KIND_LABEL[k]}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-16 text-xs text-ink-muted">属性</span>
              {ATTRS.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${
                    attrFilter.has(a) ? 'border-accent bg-accent font-bold text-on-accent' : 'border-line-strong'
                  }`}
                  onClick={() => toggle(attrFilter, a, setAttrFilter)}
                >
                  {a}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-16 text-xs text-ink-muted">コスト色</span>
              {COST_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${
                    costFilter.has(k) ? 'border-accent bg-accent font-bold text-on-accent' : 'border-line-strong'
                  }`}
                  onClick={() => toggle(costFilter, k, setCostFilter)}
                >
                  {k}（{COST_LABEL[k]}）
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2.5">
            {visiblePool.map((c) => {
              const n = working.counts[c.id] ?? 0
              const url = imageUrls.get(c.id)
              const sub =
                c.kind === 'b'
                  ? `攻:${c.battleAtk || '-'} 防:${c.battleDef || '-'}`
                  : c.kiryoku != null
                    ? `気力${c.kiryoku}・${c.attr || '無属性'}`
                    : c.cost
                      ? `コスト ${c.cost}`
                      : CARD_KIND_LABEL[c.kind]
              return (
                <div
                  key={c.id}
                  className="relative cursor-pointer select-none"
                  onClick={() => setCount(c.id, 1)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setCount(c.id, -1)
                  }}
                  onMouseEnter={() => setHovered(c)}
                  onMouseLeave={() => setHovered((h) => (h === c ? null : h))}
                >
                  <div className={`aspect-[63/88] overflow-hidden rounded-md lf-card-rim ${n >= 4 ? 'brightness-50 grayscale' : ''}`}>
                    {url ? (
                      <img src={url} alt={c.name} loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <CardFace faceUp imageUrl={undefined} card={c} name={c.name} compact />
                    )}
                  </div>
                  {n > 0 && (
                    <span
                      className={`absolute -right-1 -top-1.5 min-w-[22px] rounded-full px-1.5 py-0.5 text-center text-[11px] font-extrabold shadow ${
                        n >= 4 ? 'bg-warn text-on-accent' : 'bg-ok text-on-accent'
                      }`}
                    >
                      {n}
                    </span>
                  )}
                  <div className="mt-1 truncate text-[11px]">{c.name}</div>
                  <div className="truncate text-[10.5px] text-ink-muted">
                    {CARD_KIND_LABEL[c.kind]}・{sub}
                  </div>
                  {hovered === c && <CardPreview card={c} imageUrl={url} />}
                </div>
              )
            })}
            {visiblePool.length === 0 && <p className="text-ink-muted">該当なし</p>}
          </div>
          <p className="mt-2.5 text-[11.5px] text-ink-muted">
            左クリック＝1枚入れる／右クリック＝1枚抜く／マウスを乗せる＝拡大。右上の数字＝デッキに入っている枚数（4枚で上限色＋絵を暗く）
          </p>
        </div>

        {/* 右: デッキ */}
        <div className="grid gap-2.5">
          <div className="grid gap-2 rounded-lg p-2.5 lf-panel">
            <input
              className="w-full rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-[15px] font-extrabold hover:border-line-strong hover:bg-surface-0 focus:border-line-strong focus:bg-surface-0 focus:outline-none"
              value={working.name}
              onChange={(e) => setWorking((prev) => ({ ...prev, name: e.target.value }))}
            />
            <div className="grid grid-cols-[56px_1fr] items-center gap-2.5 rounded-lg border border-line bg-surface-0 p-1.5">
              <div
                className="aspect-[63/88] w-14 rounded lf-card-rim bg-cover bg-center"
                style={leaderImg ? { backgroundImage: `url(${leaderImg})` } : undefined}
              />
              <div>
                <div className="text-[11px] text-ink-muted">リーダー（デッキ内のキャラから選ぶ）</div>
                <select
                  className="w-full rounded-md border border-line-strong bg-surface-0 px-2 py-1 text-sm"
                  value={working.leaderCardId ?? ''}
                  onChange={(e) => setWorking((prev) => ({ ...prev, leaderCardId: e.target.value || null }))}
                >
                  <option value="">（選ぶ）</option>
                  {leaderCandidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid gap-1">
              <div className="flex justify-between font-extrabold">
                <span>
                  <b className="text-lg">{total}</b> / 60 枚
                </span>
                <span className="text-ink-muted">
                  {total === 60 ? 'ちょうど' : total < 60 ? `あと ${60 - total} 枚` : `${total - 60} 枚多い`}
                </span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full border border-line bg-surface-0">
                <div
                  className="h-full bg-gradient-to-r from-accent to-ok transition-[width]"
                  style={{ width: `${Math.min(100, (total / 60) * 100)}%` }}
                />
              </div>
            </div>
            <div className="grid gap-0.5 text-xs">
              <div className={validation.exactly60 ? 'text-ok before:content-["✓_"] before:font-bold' : 'text-warn before:content-["!_"] before:font-bold'}>
                60枚ちょうど（今 {total} 枚）
              </div>
              <div className={validation.max4ByName ? 'text-ok before:content-["✓_"] before:font-bold' : 'text-warn before:content-["!_"] before:font-bold'}>
                同じ名前のカードは4枚まで
              </div>
              <div className={validation.leaderOk ? 'text-ok before:content-["✓_"] before:font-bold' : 'text-warn before:content-["!_"] before:font-bold'}>
                {validation.leaderOk ? `リーダー: ${leaderCard?.name}` : 'リーダーを選んでください'}
              </div>
              <div className={"text-accent before:content-['i_'] before:font-bold"}>
                キャラクターカード {nChar} 枚（7枚引いてキャラクターカード0枚の確率{' '}
                {prob === null ? '-' : `${(prob * 100).toFixed(1)}%`}＝マリガンの目安）
              </div>
            </div>
            <div className="max-h-[300px] overflow-auto pr-1">
              {CARD_KINDS.map((k) => {
                const cs = inDeck.filter((c) => c.kind === k)
                if (cs.length === 0) return null
                const n = cs.reduce((a, c) => a + (working.counts[c.id] ?? 0), 0)
                return (
                  <div key={k} className="mb-1.5">
                    <h4 className="mb-0.5 flex justify-between border-b border-line pb-0.5 text-xs text-ink-muted">
                      <span>{CARD_KIND_LABEL[k]}</span>
                      <span>{n}</span>
                    </h4>
                    {cs.map((c) => (
                      <div
                        key={c.id}
                        className="grid grid-cols-[26px_1fr_auto] items-center gap-1.5 rounded p-0.5 hover:bg-white/5"
                        onMouseEnter={() => setHovered(c)}
                        onMouseLeave={() => setHovered((h) => (h === c ? null : h))}
                      >
                        <span className="text-right font-extrabold text-ok">{working.counts[c.id]}</span>
                        <span className="truncate">
                          {working.leaderCardId === c.id ? '★ ' : ''}
                          {c.name}
                        </span>
                        <span className="flex gap-0.5">
                          <button
                            type="button"
                            className="h-5 w-[22px] rounded border border-line-strong"
                            onClick={() => setCount(c.id, -1)}
                          >
                            −
                          </button>
                          <button
                            type="button"
                            className="h-5 w-[22px] rounded border border-line-strong"
                            onClick={() => setCount(c.id, 1)}
                          >
                            ＋
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="grid gap-2 rounded-lg p-2.5 lf-panel">
            <div className="font-extrabold">デッキの中身</div>
            <div className="grid gap-0.5">
              {CARD_KINDS.map((k) => {
                const n = inDeck.filter((c) => c.kind === k).reduce((a, c) => a + (working.counts[c.id] ?? 0), 0)
                return (
                  <div key={k} className="grid grid-cols-[70px_1fr_24px] items-center gap-1.5 text-[11.5px]">
                    <span>{CARD_KIND_LABEL[k]}</span>
                    <div className="h-2 overflow-hidden rounded bg-surface-0">
                      <div className="h-full bg-accent" style={{ width: `${Math.min(100, (n / 30) * 100)}%` }} />
                    </div>
                    <span>{n}</span>
                  </div>
                )
              })}
            </div>
            <div className="text-[11.5px] text-ink-muted">キャラの属性</div>
            <div className="grid gap-0.5">
              {ATTRS.map((a) => {
                const n = inDeck
                  .filter((c) => c.kind === 'c' && c.attr.includes(a))
                  .reduce((s, c) => s + (working.counts[c.id] ?? 0), 0)
                return (
                  <div key={a} className="grid grid-cols-[70px_1fr_24px] items-center gap-1.5 text-[11.5px]">
                    <span>{a}</span>
                    <div className="h-2 overflow-hidden rounded bg-surface-0">
                      <div className="h-full bg-accent" style={{ width: `${Math.min(100, (n / 20) * 100)}%` }} />
                    </div>
                    <span>{n}</span>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <button type="button" className="flex-1 rounded px-3 py-1.5 text-sm font-bold lf-btn-primary" onClick={() => void handleSave()}>
              {saveLabel}
            </button>
            <button type="button" className="flex-1 rounded border border-line-strong px-3 py-1.5 text-sm" onClick={handleDraw}>
              試しに7枚引く
            </button>
            <button type="button" className="flex-1 rounded border border-line-strong px-3 py-1.5 text-sm" onClick={() => setShowExport(true)}>
              書き出し
            </button>
          </div>
          {!isNew && (
            <button
              type="button"
              className="rounded border border-danger/60 px-3 py-1.5 text-xs text-danger"
              onClick={() => {
                if (confirm(`デッキ「${working.name}」を削除します。よろしいですか？`)) void onDelete(working.id)
              }}
            >
              削除
            </button>
          )}
          <p className="m-0 text-[11.5px] text-ink-muted">
            「試しに7枚引く」は、キャラクターカードが1枚も無ければ「マリガンできる手」と表示（公式大会ルール）
          </p>
        </div>
      </div>

      {showDraw && (
        <DrawModal
          hand={drawHand}
          hasChar={drawHand.some((c) => c.kind === 'c')}
          imageUrls={imageUrls}
          onRedraw={handleDraw}
          onClose={() => setShowDraw(false)}
        />
      )}
      {showExport && <ExportModal text={exportText} onClose={() => setShowExport(false)} />}
    </div>
  )
}
