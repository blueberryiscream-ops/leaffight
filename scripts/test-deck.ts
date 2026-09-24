// PHASE5a.md §5 検証スクリプト。src/data/deck.ts（純関数）を、偽のカードで直接叩いてassertする。
// データzip（leaffight-data.zip）は読まない。devDependency追加なし。

import type { Card } from '../src/core/types'
import {
  deckTotal,
  exportDeckText,
  parseDeckText,
  probNoChar,
  sampleHand,
  validateDeck,
  type Deck,
} from '../src/data/deck'

let failures = 0

function assertEqual(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures++
    console.error(`❌ ${msg}\n   expected: ${e}\n   actual:   ${a}`)
  } else {
    console.log(`✅ ${msg}`)
  }
}

function assertTrue(cond: boolean, msg: string) {
  if (!cond) {
    failures++
    console.error(`❌ ${msg}`)
  } else {
    console.log(`✅ ${msg}`)
  }
}

function assertClose(actual: number, expected: number, msg: string, eps = 1e-9) {
  if (Math.abs(actual - expected) > eps) {
    failures++
    console.error(`❌ ${msg}\n   expected: ${expected}\n   actual:   ${actual}`)
  } else {
    console.log(`✅ ${msg}`)
  }
}

function fakeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: overrides.id ?? 'x',
    kind: overrides.kind ?? 'c',
    name: overrides.name ?? 'テストカード',
    kana: overrides.kana ?? '',
    setVer: '1',
    printings: [],
    num: -1,
    kiryoku: null,
    stats: null,
    cost: '',
    attr: '',
    battleAtk: '',
    battleDef: '',
    abilities: [],
    illust: '',
    ...overrides,
  }
}

// ---- 偽のカードプール ----
// キャラ 3種（うち2種は同名別id）・タッグ 1種・バトル 1種・アイテム 1種
const c1 = fakeCard({ id: 'c_a', kind: 'c', name: 'リーダー花子' })
const c2a = fakeCard({ id: 'c_b1', kind: 'c', name: '同名太郎' })
const c2b = fakeCard({ id: 'c_b2', kind: 'c', name: '同名太郎' }) // 別id・同名（別の刷り違い版という想定）
const t1 = fakeCard({ id: 't_a', kind: 't', name: 'タッグ次郎' })
const b1 = fakeCard({ id: 'b_a', kind: 'b', name: 'バトル三郎' })
const i1 = fakeCard({ id: 'i_a', kind: 'i', name: 'アイテム四郎' })
// 予備の水増しカード（同名4枚までの制約を破らないよう、名前を分ける）
const fillers = Array.from({ length: 12 }, (_, i) => fakeCard({ id: `i_f${i}`, kind: 'i', name: `予備${i}` }))
const cards = [c1, c2a, c2b, t1, b1, i1, ...fillers]
const cardById = new Map(cards.map((c) => [c.id, c]))

// =============================================================================
// validateDeck
// =============================================================================
{
  // 4+4+4+4=16。残り44枚を予備12種×4枚未満で埋める（11×4=44）
  const fillerCounts: Record<string, number> = Object.fromEntries(fillers.slice(0, 11).map((c) => [c.id, 4]))
  const counts60: Record<string, number> = { [c1.id]: 4, [c2a.id]: 4, [t1.id]: 4, [b1.id]: 4, ...fillerCounts }
  assertEqual(deckTotal({ counts: counts60 }), 60, '1a: deckTotal 60枚ちょうど')

  const ok: Deck = { id: 'd1', name: 'd', leaderCardId: c1.id, counts: counts60, updatedAt: 0 }
  const v = validateDeck(ok, cardById)
  assertTrue(v.exactly60 && v.ok, '1b: 60枚ちょうどはOK')

  const notEnough: Deck = { ...ok, counts: { ...counts60, [fillers[10].id]: 3 } } // 59枚
  assertTrue(!validateDeck(notEnough, cardById).exactly60, '1c: 59枚はNG')

  const tooMany: Deck = { ...ok, counts: { ...counts60, [fillers[11].id]: 1 } } // 61枚
  assertTrue(!validateDeck(tooMany, cardById).exactly60, '1d: 61枚はNG')

  // 同じ名前（別id）合算で5枚 = NG（同名太郎 c2a+c2bで5枚にする分、フィラーを1枚減らして60枚を保つ）
  const fiveSameName: Deck = {
    ...ok,
    counts: { ...counts60, [c2a.id]: 3, [c2b.id]: 2, [fillers[10].id]: 3 },
  }
  assertTrue(!validateDeck(fiveSameName, cardById).max4ByName, '1e: 同名（別id）合算5枚はNG')

  // リーダー未選択
  assertTrue(!validateDeck({ ...ok, leaderCardId: null }, cardById).leaderOk, '1f: リーダー未選択はleaderOk=false')
  // リーダーがデッキに無い
  const noLeaderInDeck: Deck = { ...ok, leaderCardId: c1.id, counts: { ...counts60, [c1.id]: 0, [fillers[11].id]: 4 } }
  assertTrue(!validateDeck(noLeaderInDeck, cardById).leaderOk, '1g: デッキに無いカードをリーダーにするとleaderOk=false')
  // タッグをリーダーにした
  assertTrue(!validateDeck({ ...ok, leaderCardId: t1.id }, cardById).leaderOk, '1h: タッグをリーダーにするとleaderOk=false')

  // charCount はタッグを数えない（c1×4 + c2a×4 = 8。タッグ4枚は含まない）
  assertEqual(v.charCount, 8, '1i: charCountはタッグを数えない')
}

// =============================================================================
// probNoChar
// =============================================================================
{
  assertEqual(probNoChar(59, 0, 7), 1, '2a: キャラ0枚なら7枚引いてキャラ0枚の確率は1')
  assertEqual(probNoChar(59, 59, 7), 0, '2b: デッキ全部キャラなら確率は0')
  // 手計算: N=10,K=3,n=2 → (7/10)*(6/9) = 42/90 = 0.4666...
  assertClose(probNoChar(10, 3, 2), 7 / 15, '2c: 既知の値（N=10,K=3,n=2 → 7/15）')
}

// =============================================================================
// sampleHand
// =============================================================================
{
  const counts: Record<string, number> = { [c1.id]: 1, [c2a.id]: 4, [t1.id]: 4, [b1.id]: 4, [i1.id]: 47 } // 60枚
  const deck: Deck = { id: 'd', name: 'd', leaderCardId: c1.id, counts, updatedAt: 0 }
  const hand = sampleHand(deck, () => 0) // rngが常に0でも例外なく動く
  assertEqual(hand.length, 7, '3a: 7枚')
  assertTrue(!hand.includes(c1.id), '3b: リーダーを1枚しか入れていなければ手札にリーダーは出ない')
  // 固定rngで結果が決まる（同じrng列を渡せば同じ結果）
  const rngSeq = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 0.5]
  let i1_ = 0
  const rng1 = () => rngSeq[i1_++ % rngSeq.length]
  let i2_ = 0
  const rng2 = () => rngSeq[i2_++ % rngSeq.length]
  assertEqual(sampleHand(deck, rng1), sampleHand(deck, rng2), '3c: 固定rngなら同じ結果')
}

// =============================================================================
// exportDeckText <-> parseDeckText 往復
// =============================================================================
{
  const counts: Record<string, number> = { [c1.id]: 4, [c2a.id]: 4, [t1.id]: 4, [b1.id]: 3, [i1.id]: 45 } // 60枚
  const deck: Deck = { id: 'd', name: 'テストデッキ', leaderCardId: c1.id, counts, updatedAt: 0 }
  const text = exportDeckText(deck, cardById)
  const parsed = parseDeckText(text, cards)
  assertEqual(parsed.errors, [], '4a: 往復にerrorsは出ない')
  assertEqual(parsed.deck.counts, counts, '4b: 往復でcountsが一致')
  assertEqual(parsed.deck.leaderCardId, c1.id, '4c: 往復でleaderCardIdが一致')
}

// =============================================================================
// parseDeckText: 見つからない名前・同名別種類・全角半角/中黒の吸収
// =============================================================================
{
  const text = [
    'リーダー: リーダー花子',
    '# 私のデッキ',
    '',
    '# キャラ',
    '4 リーダー花子',
    '3 同名太郎', // タッグ次郎の見出し無し・キャラ見出しの直後なのでキャラ版に決まる
    '',
    '# タッグ',
    '2 タッグ次郎',
    '1 存在しないカード',
    'これは読めない行',
  ].join('\n')
  const parsed = parseDeckText(text, cards)
  assertEqual(parsed.errors.length, 2, '5a: 見つからない名前と読めない行の2件がerrorsに入る')
  assertTrue(parsed.errors[0].startsWith('10行目:'), '5b: 見つからない行の行番号が正しい')
  assertTrue(parsed.errors[1].startsWith('11行目:'), '5c: 読めない行の行番号が正しい')
  assertEqual(parsed.deck.counts[c1.id], 4, '5d: 他の行は読める（リーダー花子）')
  assertEqual(parsed.deck.counts[c2a.id], 3, '5e: 同名別種類は直前の見出しで解決（同名太郎→キャラ版）')
  assertEqual(parsed.deck.counts[t1.id], 2, '5f: タッグ次郎')

  // 全角半角・中黒の違いを吸収（searchKey経由）: カード名は中黒あり「エー・ビー」、
  // 取り込みテキストは中黒抜き「エービー」で表記ゆれさせる
  const c3 = fakeCard({ id: 'c_z', kind: 'c', name: 'エー・ビー' })
  const cards2 = [...cards, c3]
  const text2 = 'リーダー: （未選択）\n# d\n# キャラ\n2 エービー'
  const parsed2 = parseDeckText(text2, cards2)
  assertEqual(parsed2.errors, [], '5g: 全角半角・中黒の違いを吸収してエラー無し')
  assertEqual(parsed2.deck.counts[c3.id], 2, '5h: 中黒抜き表記でも同じカードに解決される')
}

console.log(failures === 0 ? `\n✅ 全ケース成功` : `\n❌ ${failures}件失敗`)
process.exit(failures === 0 ? 0 : 1)
