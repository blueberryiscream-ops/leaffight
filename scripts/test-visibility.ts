// PHASE5c.md §5 検証スクリプト。core（board.ts の isPublicCard / moveCard / toggleOrientation / flip の
// ログ）を偽のカードで直接叩いてassertする。devDependency追加なし。
// 期待値は PHASE5c.md §1・§2 の本文から作る（実装の出力を写さない）。

import { applyAction } from '../src/core/actions'
import { EMPTY_BOARD, isPublicCard, type BoardState, type CardInstance } from '../src/core/board'

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

function boardWith(cards: CardInstance[]): BoardState {
  const cardMap: Record<string, CardInstance> = {}
  for (const c of cards) cardMap[c.iid] = c
  return { ...EMPTY_BOARD, cards: cardMap }
}

// =============================================================================
// isPublicCard の真理値表（PHASE5c.md §1: zone!=='deck' && zone!=='hand' && faceUp）
// =============================================================================
{
  assertEqual(isPublicCard({ zone: 'deck', faceUp: true }), false, '0a: デッキは faceUp=true でも非公開')
  assertEqual(isPublicCard({ zone: 'deck', faceUp: false }), false, '0b: デッキ・裏 は非公開')
  assertEqual(isPublicCard({ zone: 'hand', faceUp: true }), false, '0c: 手札は faceUp=true でも非公開')
  assertEqual(isPublicCard({ zone: 'hand', faceUp: false }), false, '0d: 手札・裏 は非公開')
  assertEqual(isPublicCard({ zone: 'char', faceUp: false }), false, '0e: キャラでも裏なら非公開')
  assertEqual(isPublicCard({ zone: 'char', faceUp: true }), true, '0f: キャラ・表 は公開')
  assertEqual(isPublicCard({ zone: 'trash', faceUp: true }), true, '0g: ゴミ箱・表 は公開')
  assertEqual(isPublicCard({ zone: 'leader', faceUp: true }), true, '0h: リーダー・表 は公開')
}

// =============================================================================
// moveCard のログ（PHASE5c.md §2）
// =============================================================================
{
  // デッキ→手札（ドロー）: 前後とも非公開 → 名前なし
  const s1 = boardWith([card('c1', { zone: 'deck', faceUp: false })])
  const r1 = applyAction(s1, { type: 'moveCard', iid: 'c1', toZone: 'hand', cardName: '本当の名前' })
  assertTrue(!r1.log.includes('本当の名前'), '1a: デッキ→手札は名前なし')
  assertEqual(r1.log, 'カードを1枚 デッキ から 手札 へ移動した', '1b: デッキ→手札のログ本文')

  // 手札→キャラ（プレイ）: 後が公開 → 名前あり
  const s2 = boardWith([card('c2', { zone: 'hand', faceUp: true })])
  const r2 = applyAction(s2, { type: 'moveCard', iid: 'c2', toZone: 'char', cardName: 'キャラ名' })
  assertTrue(r2.log.includes('キャラ名'), '1c: 手札→キャラは名前あり')

  // 手札→ゴミ箱: 後が公開（faceUpは維持され、trashはhand/deckでないので公開） → 名前あり
  const s3 = boardWith([card('c3', { zone: 'hand', faceUp: true })])
  const r3 = applyAction(s3, { type: 'moveCard', iid: 'c3', toZone: 'trash', cardName: 'ゴミ箱行き' })
  assertTrue(r3.log.includes('ゴミ箱行き'), '1d: 手札→ゴミ箱は名前あり')

  // 手札→デッキ: 前後とも非公開 → 名前なし
  const s4 = boardWith([card('c4', { zone: 'hand', faceUp: true })])
  const r4 = applyAction(s4, { type: 'moveCard', iid: 'c4', toZone: 'deck', cardName: '戻す' })
  assertTrue(!r4.log.includes('戻す'), '1e: 手札→デッキは名前なし')

  // デッキ→デッキ（並べ替え）: 前後とも非公開 → 名前なし
  const s5 = boardWith([card('c5', { zone: 'deck', faceUp: false, index: 0 })])
  const r5 = applyAction(s5, { type: 'moveCard', iid: 'c5', toZone: 'deck', toIndex: 3, cardName: '並べ替え' })
  assertTrue(!r5.log.includes('並べ替え'), '1f: デッキ→デッキは名前なし')
}

// =============================================================================
// toggleOrientation のログ
// =============================================================================
{
  // デッキのカード（非公開）: 名前なし
  const s1 = boardWith([card('d1', { zone: 'deck', faceUp: false })])
  const r1 = applyAction(s1, { type: 'toggleOrientation', iid: 'd1', cardName: 'デッキの中身' })
  assertTrue(!r1.log.includes('デッキの中身'), '2a: デッキのtoggleOrientationは名前なし')

  // キャラの向き変更: 名前あり
  const s2 = boardWith([card('c1', { zone: 'char', faceUp: true })])
  const r2 = applyAction(s2, { type: 'toggleOrientation', iid: 'c1', cardName: 'キャラA' })
  assertTrue(r2.log.includes('キャラA'), '2b: キャラのtoggleOrientationは名前あり')
}

// =============================================================================
// flip のログ（PHASE5c.md §2 🚨 裏→表・表→裏のどちらも名前を出してよい）
// =============================================================================
{
  // 裏のキャラ→表: 後が公開 → 名前あり
  const s1 = boardWith([card('c1', { zone: 'char', faceUp: false })])
  const r1 = applyAction(s1, { type: 'flip', iid: 'c1', cardName: '裏だったキャラ' })
  assertTrue(r1.log.includes('裏だったキャラ'), '3a: 裏→表のflipは名前あり')

  // 表のキャラ→裏: 前が公開 → 名前あり
  const s2 = boardWith([card('c2', { zone: 'char', faceUp: true })])
  const r2 = applyAction(s2, { type: 'flip', iid: 'c2', cardName: '表だったキャラ' })
  assertTrue(r2.log.includes('表だったキャラ'), '3b: 表→裏のflipは名前あり')

  // デッキの中で裏のまま何かする状況は無い（deckは常にfaceUp:falseで維持）が、念のため
  // 「前後とも非公開」の代表として手札内でのflip（faceUp:true→false）を確かめる
  const s3 = boardWith([card('h1', { zone: 'hand', faceUp: true })])
  const r3 = applyAction(s3, { type: 'flip', iid: 'h1', cardName: '手札の中身' })
  // 手札はisPublicCardが常にfalse（zone==='hand'）なので、表裏に関わらず両方非公開 → 名前なし
  assertTrue(!r3.log.includes('手札の中身'), '3c: 手札内のflipは（前後とも非公開なので）名前なし')
}

// --- 手でドラッグしてフィールドを入れ替えた場合も、旧カードはゴミ箱へ（oldrule.txt:935 / 18-2[11]）---
// （R2u-2 で旧 test-play-declare.ts（優先権の窓のテスト）を消したときに、盤面の操作のこのケースだけ移した）
{
  let state = applyAction(EMPTY_BOARD, { type: 'spawnCard', iid: 'old', cardId: 'f1', cardName: '旧', owner: 'A', zone: 'field' }).state
  state = applyAction(state, { type: 'spawnCard', iid: 'new', cardId: 'f2', cardName: '新', owner: 'B', zone: 'hand' }).state
  state = applyAction(state, { type: 'moveCard', iid: 'new', toOwner: 'B', toZone: 'field', cardName: '新' }).state
  assertEqual(state.cards['new'].zone, 'field', '4a: 新しいフィールドカードが場に出る')
  assertEqual(state.cards['old'].zone, 'trash', '4b: 旧フィールドカードはゴミ箱（手札へ入れ替わらない）')
  assertEqual(state.cards['old'].owner, 'A', '4c: 持ち主は変わらない')
}

console.log(failures === 0 ? `\n✅ 全成功` : `\n❌ ${failures} 件失敗`)
process.exit(failures === 0 ? 0 : 1)
