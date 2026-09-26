// PHASE5b.md §3 検証スクリプト。core（board.ts の startWithDeck / mulligan / revealLeader /
// fillBoardDefaults）を偽のカードで直接叩いてassertする。devDependency追加なし。
// 期待値は PHASE5b.md §1 と原典の逐語（oldrule.txt:343-360）から作る（実装の出力を写さない）。

import { applyAction } from '../src/core/actions'
import {
  EMPTY_BOARD,
  fillBoardDefaults,
  type BoardState,
  type CardInstance,
  type Modifier,
  type Seat,
} from '../src/core/board'

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

function card(iid: string, overrides: Partial<CardInstance> = {}): CardInstance {
  return {
    iid,
    cardId: overrides.cardId ?? iid,
    owner: 'A',
    zone: 'char',
    index: 0,
    orientation: 'ready',
    faceUp: true,
    kiryoku: null,
    attachedTo: null,
    ...overrides,
  }
}

function boardWith(cards: CardInstance[], modifiers: Modifier[] = []): BoardState {
  const cardMap: Record<string, CardInstance> = {}
  for (const c of cards) cardMap[c.iid] = c
  const modMap: Record<string, Modifier> = {}
  for (const m of modifiers) modMap[m.id] = m
  return { ...EMPTY_BOARD, cards: cardMap, modifiers: modMap }
}

function mkDeck(n: number, prefix = 'd'): { iid: string; cardId: string }[] {
  return Array.from({ length: n }, (_, i) => ({ iid: `${prefix}${i}`, cardId: `card_${prefix}${i}` }))
}

// =============================================================================
// startWithDeck
// =============================================================================
{
  const deck59 = mkDeck(59)
  const state = boardWith([])
  const r = applyAction(state, {
    type: 'startWithDeck',
    owner: 'A',
    deckName: 'テストデッキ',
    leader: { iid: 'leader1', cardId: 'card_leader', kiryoku: 10 },
    deck: deck59,
    draw: 7,
  })
  const s = r.state

  assertEqual(s.cards['leader1'].zone, 'leader', '1a: リーダーが leader ゾーン')
  assertEqual(s.cards['leader1'].faceUp, false, '1b: リーダーは裏向き（faceUp=false）')
  assertEqual(s.cards['leader1'].orientation, 'ready', '1c: リーダーは縦置き＝待機（orientation=ready）')
  assertEqual(s.cards['leader1'].kiryoku, 10, '1d: リーダーの気力は渡した値')

  const deckCards = Object.values(s.cards).filter((c) => c.owner === 'A' && c.zone === 'deck')
  const handCards = Object.values(s.cards).filter((c) => c.owner === 'A' && c.zone === 'hand')
  assertEqual(deckCards.length, 52, '1e: デッキ52枚（59-7）')
  assertEqual(handCards.length, 7, '1f: 手札7枚')

  const handIidsSorted = handCards.sort((a, b) => a.index - b.index).map((c) => c.iid)
  assertEqual(handIidsSorted, deck59.slice(0, 7).map((d) => d.iid), '1g: 手札の7枚が渡した並びの先頭7枚')
  assertTrue(handCards.every((c) => c.faceUp === true), '1h: 手札は表向き')
  assertTrue(!r.log.includes('card_leader') && !r.log.includes('リーダー1'), '1i: ログにリーダーの名前（cardId）が含まれない')
}

// 既存カードの片付け・相手カード不変・modifier/attachedToの後始末
{
  const before = boardWith(
    [
      card('a_char', { owner: 'A', zone: 'char', index: 0 }),
      card('a_trash', { owner: 'A', zone: 'trash', index: 0 }),
      card('a_field', { owner: 'A', zone: 'field', index: 0 }),
      card('b_char', { owner: 'B', zone: 'char', index: 0 }),
      card('b_item', { owner: 'B', zone: 'char', index: 1, attachedTo: 'a_char' }), // 相手のアイテムがAのカードに付いている
    ],
    [{ id: 'mod1', targetIid: 'a_char', sourceLabel: '何か', kind: '能力値修正', scope: 'その他' }],
  )
  const r = applyAction(before, {
    type: 'startWithDeck',
    owner: 'A',
    deckName: 'd',
    leader: { iid: 'leader2', cardId: 'card_leader2', kiryoku: 4 },
    deck: mkDeck(3, 'x'),
    draw: 3,
  })
  const s = r.state

  assertTrue(!('a_char' in s.cards), '2a: 自分の char カードが消える')
  assertTrue(!('a_trash' in s.cards), '2b: 自分の trash カードが消える')
  assertTrue(!('a_field' in s.cards), '2c: 自分の field カードが消える')
  assertEqual(s.cards['b_char'], before.cards['b_char'], '2d: 相手のカードは1枚も変わらない')
  assertTrue(!('mod1' in s.modifiers), '2e: 消したカードへの modifier が消える')
  assertEqual(s.cards['b_item']?.attachedTo, null, '2f: 相手のアイテムの attachedTo が消したカードを指していたら null')
}

// 手順（proc）が動いている最中は何もしない（R2u-2: 旧 battle / priority の条件を proc に置き換えた）
{
  const withProc: BoardState = { ...boardWith([]), proc: [{ id: 'f1' } as never] }
  const r1 = applyAction(withProc, {
    type: 'startWithDeck',
    owner: 'A',
    deckName: 'd',
    leader: { iid: 'l', cardId: 'c', kiryoku: 1 },
    deck: mkDeck(1),
    draw: 1,
  })
  assertEqual(r1.state, withProc, '3a: proc が空でなければ状態が変わらない')
}

// =============================================================================
// mulligan
// =============================================================================
function setupStateFor(owner: Seat): BoardState {
  const state = boardWith([])
  const r = applyAction(state, {
    type: 'startWithDeck',
    owner,
    deckName: 'マリガン用',
    leader: { iid: 'ml_leader', cardId: 'card_leader', kiryoku: 6 },
    deck: mkDeck(10, 'm'),
    draw: 7,
  })
  return r.state
}

{
  const afterSetup = setupStateFor('A')
  const hand = Object.values(afterSetup.cards).filter((c) => c.owner === 'A' && c.zone === 'hand')
  const deck = Object.values(afterSetup.cards).filter((c) => c.owner === 'A' && c.zone === 'deck')
  const combined = [...hand, ...deck].map((c) => c.iid)
  // 新しい並び: 逆順にしてみる（元と違う並びであることが確認しやすい）
  const orderedIids = [...combined].reverse()

  const r = applyAction(afterSetup, {
    type: 'mulligan',
    owner: 'A',
    orderedIids,
    revealedNames: ['ダミー1', 'ダミー2'],
    draw: 7,
  })
  const s = r.state
  const newHand = Object.values(s.cards)
    .filter((c) => c.owner === 'A' && c.zone === 'hand')
    .sort((a, b) => a.index - b.index)
  const newDeck = Object.values(s.cards).filter((c) => c.owner === 'A' && c.zone === 'deck')

  assertEqual(newHand.length, 7, '4a: 手札7枚がデッキに戻り改めて7枚引く')
  assertEqual(newDeck.length, 3, '4b: 残りの3枚がデッキ')
  assertEqual(newHand.map((c) => c.iid), orderedIids.slice(0, 7), '4c: 渡した並びの先頭7枚が手札')
  assertEqual(s.setup.A?.mulliganUsed, true, '4d: mulliganUsed=true')
  assertTrue(r.log.includes('ダミー1') && r.log.includes('ダミー2'), '4e: ログに公開した手札名')

  // 2回目は何もしない
  const r2 = applyAction(s, { type: 'mulligan', owner: 'A', orderedIids, revealedNames: [], draw: 7 })
  assertEqual(r2.state, s, '4f: 2回目のマリガンは何もしない（mulliganUsed）')

  // leaderRevealed 後は何もしない
  const revealed = applyAction(afterSetup, { type: 'revealLeader', owner: 'A', cardName: 'x' }).state
  const r3 = applyAction(revealed, { type: 'mulligan', owner: 'A', orderedIids, revealedNames: [], draw: 7 })
  assertEqual(r3.state, revealed, '4g: leaderRevealed 後のマリガンは何もしない')

  // 集合が合わない orderedIids は何もしない
  const badOrdered = [...combined.slice(1), 'no_such_iid']
  const r4 = applyAction(afterSetup, { type: 'mulligan', owner: 'A', orderedIids: badOrdered, revealedNames: [], draw: 7 })
  assertEqual(r4.state, afterSetup, '4h: 集合が合わない orderedIids は何もしない')

  // setup が null（デッキで始めていない）なら何もしない
  const noSetup = boardWith([card('h1', { owner: 'A', zone: 'hand' }), card('d1', { owner: 'A', zone: 'deck' })])
  const r5 = applyAction(noSetup, { type: 'mulligan', owner: 'A', orderedIids: ['h1', 'd1'], revealedNames: [], draw: 1 })
  assertEqual(r5.state, noSetup, '4i: setup が null なら何もしない')
}

// =============================================================================
// revealLeader
// =============================================================================
{
  const afterSetup = setupStateFor('B')
  const r = applyAction(afterSetup, { type: 'revealLeader', owner: 'B', cardName: 'カード名' })
  const s = r.state
  assertEqual(s.cards['ml_leader'].faceUp, true, '5a: faceUp=true')
  assertTrue(r.log.includes('カード名'), '5b: ログにカード名')
  assertEqual(s.setup.B?.leaderRevealed, true, '5c: leaderRevealed=true')

  const r2 = applyAction(s, { type: 'revealLeader', owner: 'B', cardName: 'カード名' })
  assertEqual(r2.state, s, '5d: 2回目は何もしない')
}

// =============================================================================
// fillBoardDefaults（古い保存盤面の補完。useBoard.ts と同じ関数をここで直接テストする）
// =============================================================================
{
  const oldSaved = { cards: {}, modifiers: {}, priority: null, mode: 'assist' } as Partial<BoardState>
  const filled = fillBoardDefaults(oldSaved)
  assertEqual(filled.setup, { A: null, B: null }, '6a: setup なしの旧盤面を補完すると {A:null,B:null}')
}

console.log(failures === 0 ? `\n✅ 全成功` : `\n❌ ${failures} 件失敗`)
process.exit(failures === 0 ? 0 : 1)
