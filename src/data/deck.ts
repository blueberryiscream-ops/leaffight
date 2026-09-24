// デッキ（純関数のみ・React/Dexie を import しない。DESIGN.md §4.21・PHASE5a.md §2）。
//
// カードは card.id で持つ（名前ではない）。「同じ名前は4枚まで」の判定・書き出し・取り込みの
// 表示名はすべて card.name を経由する。
//
// 🚨 マリガンの判定・確率計算は kind==='c'（キャラ）だけを数える。タッグ（kind==='t'）は
// 含めない（DESIGN.md §4.21 見本からの訂正1。FAQ oldfaq.txt:3468-3469, oldrule.txt:586）。

import { CARD_KINDS, CARD_KIND_LABEL, type Card, type CardKind } from '../core/types'
import { searchKey } from '../core/name'

export interface Deck {
  id: string
  name: string
  leaderCardId: string | null
  /** card.id -> 枚数 */
  counts: Record<string, number>
  updatedAt: number
}

export function deckTotal(deck: Pick<Deck, 'counts'>): number {
  let total = 0
  for (const n of Object.values(deck.counts)) total += n
  return total
}

export interface DeckValidation {
  total: number
  exactly60: boolean
  max4ByName: boolean
  leaderOk: boolean
  ok: boolean
  /** kind==='c' の枚数のみ（タッグを含まない） */
  charCount: number
}

export function validateDeck(
  deck: Pick<Deck, 'counts' | 'leaderCardId'>,
  cardById: Map<string, Card>,
): DeckValidation {
  const total = deckTotal(deck)
  const exactly60 = total === 60

  const byName = new Map<string, number>()
  let charCount = 0
  for (const [id, n] of Object.entries(deck.counts)) {
    if (n <= 0) continue
    const card = cardById.get(id)
    const name = card?.name ?? id
    byName.set(name, (byName.get(name) ?? 0) + n)
    if (card?.kind === 'c') charCount += n
  }
  const max4ByName = [...byName.values()].every((n) => n <= 4)

  const leaderCard = deck.leaderCardId ? cardById.get(deck.leaderCardId) : undefined
  const leaderOk = !!(
    deck.leaderCardId &&
    (deck.counts[deck.leaderCardId] ?? 0) > 0 &&
    leaderCard?.kind === 'c'
  )

  return { total, exactly60, max4ByName, leaderOk, ok: exactly60 && max4ByName && leaderOk, charCount }
}

/**
 * 超幾何分布: N枚中K枚が「当たり」のとき、n枚引いて当たりが0枚の確率。
 * 呼び出し側で N=デッキサイズ-1（リーダーを抜く）、K=charCount-（リーダーがキャラなら1）にして呼ぶ
 * （見本 hyper0 と同じ規約。DESIGN.md §4.21）。
 */
export function probNoChar(deckSize: number, charCount: number, draw = 7): number {
  let p = 1
  for (let i = 0; i < draw; i++) {
    p *= (deckSize - charCount - i) / (deckSize - i)
  }
  return Math.max(0, p)
}

/** リーダーを1枚抜いた残りをシャッフルして先頭7枚の cardId 配列を返す */
export function sampleHand(deck: Pick<Deck, 'counts' | 'leaderCardId'>, rng: () => number): string[] {
  const pile: string[] = []
  for (const [id, n] of Object.entries(deck.counts)) {
    const count = id === deck.leaderCardId ? n - 1 : n
    for (let i = 0; i < count; i++) pile.push(id)
  }
  for (let i = pile.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = pile[i]
    pile[i] = pile[j]
    pile[j] = tmp
  }
  return pile.slice(0, 7)
}

export function exportDeckText(
  deck: Pick<Deck, 'name' | 'leaderCardId' | 'counts'>,
  cardById: Map<string, Card>,
): string {
  const leaderName = deck.leaderCardId ? cardById.get(deck.leaderCardId)?.name : undefined
  const lines: string[] = [`リーダー: ${leaderName ?? '（未選択）'}`, `# ${deck.name}`]
  for (const kind of CARD_KINDS) {
    const entries = Object.entries(deck.counts)
      .filter(([id, n]) => n > 0 && cardById.get(id)?.kind === kind)
      .map(([id, n]) => [cardById.get(id)!, n] as const)
    if (entries.length === 0) continue
    lines.push('', `# ${CARD_KIND_LABEL[kind]}`)
    for (const [card, n] of entries) lines.push(`${n} ${card.name}`)
  }
  return lines.join('\n')
}

export interface ParsedDeck {
  deck: Omit<Deck, 'id' | 'updatedAt'>
  errors: string[]
}

const KIND_LABEL_TO_KIND: Partial<Record<string, CardKind>> = Object.fromEntries(
  CARD_KINDS.map((k) => [CARD_KIND_LABEL[k], k]),
)

/** exportDeckText と対になる取り込み。読めない行は errors に行番号付きで入れ、読み飛ばす */
export function parseDeckText(text: string, cards: Card[]): ParsedDeck {
  const byKey = new Map<string, Card[]>()
  for (const c of cards) {
    const key = searchKey(c.name)
    const arr = byKey.get(key)
    if (arr) arr.push(c)
    else byKey.set(key, [c])
  }

  const counts: Record<string, number> = {}
  const errors: string[] = []
  let name = ''
  let nameSet = false
  let leaderCardId: string | null = null
  let currentKind: CardKind | null = null

  const lines = text.split(/\r?\n/)
  lines.forEach((raw, idx) => {
    const lineNum = idx + 1
    const line = raw.trim()
    if (line === '') return

    if (line.startsWith('リーダー:') || line.startsWith('リーダー：')) {
      const sep = line.indexOf(':') >= 0 ? ':' : '：'
      const leaderName = line.slice(line.indexOf(sep) + 1).trim()
      if (leaderName && leaderName !== '（未選択）') {
        const candidates = (byKey.get(searchKey(leaderName)) ?? []).filter((c) => c.kind === 'c')
        if (candidates.length >= 1) {
          leaderCardId = candidates[0].id
        } else {
          errors.push(`${lineNum}行目: リーダー「${leaderName}」（キャラクターカード）が見つかりません`)
        }
      }
      return
    }

    if (line.startsWith('#')) {
      const heading = line.slice(1).trim()
      const kind = KIND_LABEL_TO_KIND[heading]
      if (kind) {
        currentKind = kind
      } else if (!nameSet) {
        name = heading
        nameSet = true
      }
      return
    }

    const m = line.match(/^(\d+)\s+(.+)$/)
    if (!m) {
      errors.push(`${lineNum}行目: 読み取れません「${line}」`)
      return
    }
    const n = Number(m[1])
    const cardName = m[2].trim()
    const candidates = byKey.get(searchKey(cardName)) ?? []
    let card: Card | undefined
    if (candidates.length === 0) {
      errors.push(`${lineNum}行目: カード「${cardName}」が見つかりません`)
      return
    } else if (candidates.length === 1) {
      card = candidates[0]
    } else {
      card = currentKind ? candidates.find((c) => c.kind === currentKind) : undefined
      if (!card) {
        errors.push(`${lineNum}行目: カード「${cardName}」の種類が複数あり決まりません`)
        return
      }
    }
    counts[card.id] = (counts[card.id] ?? 0) + n
  })

  return { deck: { name, leaderCardId, counts }, errors }
}
