// P3c 検証スクリプト。core/timing.ts のフック表（§2）と data/interrupt.ts の主語スコープ照合（§3）を
// 直接叩いてassertする。devDependency追加なし: Node 25のネイティブTS型剥がしで直接実行できる。
// PHASE3c.md §5「単体: §2のフック表（主要6パターン）と§3の主語スコープ（6種）をassert」に対応。

import { EMPTY_BOARD, type BoardState, type CardInstance } from '../src/core/board'
import type { Priority } from '../src/core/priority'
import { deriveTimingEvents } from '../src/core/timing'
import { findInterruptCandidates } from '../src/data/interrupt'
import type { InterruptsMap } from '../src/data/types'

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

function boardWith(cards: CardInstance[], priority: Priority | null = null): BoardState {
  const map: Record<string, CardInstance> = {}
  for (const c of cards) map[c.iid] = c
  return { ...EMPTY_BOARD, cards: map, priority }
}

const cardKindOf = (id: string) => ({ e1: 'e' as const, f1: 'f' as const, c1: 'c' as const })[id]

// =============================================================================
// §2 フック表（主要6パターン）
// =============================================================================

// 1. declareAction(kind='能力') → 《特殊能力を使用するとき》
{
  const before = boardWith([])
  const after = boardWith(
    [],
    {
      frames: [{ active: { by: 'A', sourceIid: 'c1', kind: '能力', actionType: '通常型', label: '技' }, nonActive: null, step: 'awaitNonActive' }],
      activePlayer: 'A',
    },
  )
  const events = deriveTimingEvents(before, after, cardKindOf)
  assertEqual(events, [{ timing: '特殊能力を使用するとき', actor: 'A', targetIid: 'c1' }], 'フック1: declareAction(能力)→特殊能力を使用するとき')
}

// 2. resolveStep（能力が解決・窓が閉じる） → 《特殊能力を使用したとき》
{
  const before = boardWith(
    [],
    {
      frames: [{ active: { by: 'A', sourceIid: 'c1', kind: '能力', actionType: '通常型', label: '技' }, nonActive: null, step: 'processActive' }],
      activePlayer: 'A',
    },
  )
  const after = boardWith([], null)
  const events = deriveTimingEvents(before, after, cardKindOf)
  assertEqual(events, [{ timing: '特殊能力を使用したとき', actor: 'A', targetIid: 'c1' }], 'フック2: resolveStep(能力)→特殊能力を使用したとき')
}

// 3. declareAction(kind='プレイ'・イベント) → 《イベントカードを使用するとき》
{
  const before = boardWith([])
  const after = boardWith(
    [],
    {
      frames: [{ active: { by: 'B', sourceIid: 'e1', kind: 'プレイ', actionType: '通常型', label: 'ガセネタ' }, nonActive: null, step: 'awaitNonActive' }],
      activePlayer: 'B',
    },
  )
  const events = deriveTimingEvents(before, after, cardKindOf)
  assertEqual(events, [{ timing: 'イベントカードを使用するとき', actor: 'B', targetIid: 'e1' }], 'フック3: declareAction(プレイ・イベント)→イベントカードを使用するとき')
}

// 3b. resolveStep（イベントが解決） → 《イベントカードを使用したとき》
{
  const before = boardWith(
    [],
    {
      frames: [{ active: { by: 'B', sourceIid: 'e1', kind: 'プレイ', actionType: '通常型', label: 'ガセネタ' }, nonActive: null, step: 'processActive' }],
      activePlayer: 'B',
    },
  )
  const after = boardWith([], null)
  const events = deriveTimingEvents(before, after, cardKindOf)
  assertEqual(events, [{ timing: 'イベントカードを使用したとき', actor: 'B', targetIid: 'e1' }], 'フック3b: resolveStep(プレイ・イベント)→イベントカードを使用したとき')
}

// 4. adjustKiryoku/setKiryoku（減少・1→0でダウンも） → ダメージ3件＋ダウン1件
{
  const before = boardWith([card('x1', { owner: 'B', kiryoku: 1 })])
  const after = boardWith([card('x1', { owner: 'B', kiryoku: 0 })])
  const events = deriveTimingEvents(before, after, cardKindOf)
  assertEqual(
    events,
    [
      { timing: 'ダメージが発生したとき', actor: 'B', targetIid: 'x1' },
      { timing: 'ダメージを受けるとき', actor: 'B', targetIid: 'x1' },
      { timing: 'ダメージを受けたとき', actor: 'B', targetIid: 'x1' },
      { timing: 'ダウンするとき', actor: 'B', targetIid: 'x1' },
    ],
    'フック4: 気力1→0でダメージ3件＋ダウン1件',
  )
}

// 4b. 気力減少（ダウンに満たない） → ダメージ3件のみ
{
  const before = boardWith([card('x2', { owner: 'A', kiryoku: 5 })])
  const after = boardWith([card('x2', { owner: 'A', kiryoku: 3 })])
  const events = deriveTimingEvents(before, after, cardKindOf)
  assertEqual(events.some((e) => e.timing === 'ダウンするとき'), false, 'フック4b: ダウンに満たない気力減少ではダウンイベントは出ない')
  assertEqual(events.length, 3, 'フック4b: ダメージ系3件のみ')
}

// 5. adjustKiryoku/setKiryoku（増加） → 《気力を回復させる効果が発生したとき》
{
  const before = boardWith([card('x3', { owner: 'A', kiryoku: 2 })])
  const after = boardWith([card('x3', { owner: 'A', kiryoku: 5 })])
  const events = deriveTimingEvents(before, after, cardKindOf)
  assertEqual(events, [{ timing: '気力を回復させる効果が発生したとき', actor: 'A', targetIid: 'x3' }], 'フック5: 気力増加→気力を回復させる効果が発生したとき')
}

// 6. toTrash/moveCard（hand→trash） → 《手札をゴミ箱送りにするとき》《したとき》
{
  const before = boardWith([card('h1', { owner: 'B', zone: 'hand' })])
  const after = boardWith([card('h1', { owner: 'B', zone: 'trash' })])
  const events = deriveTimingEvents(before, after, cardKindOf)
  assertEqual(
    events,
    [
      { timing: '手札をゴミ箱送りにするとき', actor: 'B', targetIid: 'h1' },
      { timing: '手札をゴミ箱送りにしたとき', actor: 'B', targetIid: 'h1' },
    ],
    'フック6: hand→trashでゴミ箱送り2件',
  )
}

// 非回帰: 無関係な変化（zone以外の移動等）ではイベントが出ない
{
  const before = boardWith([card('m1', { owner: 'A', zone: 'char', index: 0 })])
  const after = boardWith([card('m1', { owner: 'A', zone: 'char', index: 1 })])
  const events = deriveTimingEvents(before, after, cardKindOf)
  assertEqual(events, [], '非回帰: 気力/手札ゴミ箱/宣言解決に関係ない変化ではイベント無し')
}

// =============================================================================
// §3 主語スコープ（6種）
// =============================================================================

function interruptsWith(cardId: string, subject: string, timing: string): InterruptsMap {
  return { [cardId]: [{ ability: '能力X', cost: 'R', subject, timings: [timing] }] }
}

// 1. 相手が / 相手の: actor!==P のときだけPに候補が出る
{
  const board = boardWith([card('s1', { owner: 'A', cardId: 'seb' }), card('s2', { owner: 'B', cardId: 'seb' })])
  const interrupts = interruptsWith('seb', '相手が', 'イベントカードを使用したとき')
  const event = { timing: 'イベントカードを使用したとき', actor: 'A' as const, targetIid: null }
  assertEqual(findInterruptCandidates(event, 'B', board, interrupts).length, 1, '主語1: 相手が→actor(A)≠B自身の候補にはBに出る')
  assertEqual(findInterruptCandidates(event, 'A', board, interrupts).length, 0, '主語1: 相手が→actor(A)自身には出ない')
}

// 2. 自分が: actor===P のときだけ候補が出る
{
  const board = boardWith([card('s1', { owner: 'A', cardId: 'seb' }), card('s2', { owner: 'B', cardId: 'seb' })])
  const interrupts = interruptsWith('seb', '自分が', 'コストを発生するとき')
  const event = { timing: 'コストを発生するとき', actor: 'A' as const, targetIid: null }
  assertEqual(findInterruptCandidates(event, 'A', board, interrupts).length, 1, '主語2: 自分が→actor本人には出る')
  assertEqual(findInterruptCandidates(event, 'B', board, interrupts).length, 0, '主語2: 自分が→他人には出ない')
}

// 3. 味方キャラが / 自分のキャラが: 対象キャラの owner===P のときだけ
{
  const board = boardWith([
    card('target', { owner: 'B', cardId: 'kamigishi' }),
    card('seb', { owner: 'B', cardId: 'sebastian' }),
  ])
  const interrupts = interruptsWith('sebastian', '味方キャラが', 'ダメージを受けるとき')
  const event = { timing: 'ダメージを受けるとき', actor: 'B' as const, targetIid: 'target' }
  assertEqual(findInterruptCandidates(event, 'B', board, interrupts).length, 1, '主語3: 味方キャラが→対象の持ち主側に出る')
  assertEqual(findInterruptCandidates(event, 'A', board, interrupts).length, 0, '主語3: 味方キャラが→対象を持たない側には出ない（Aはsebastianを持たない）')
}

// 4. このキャラが: 対象iid===自分自身のiidのときだけ
{
  const board = boardWith([card('self1', { owner: 'A', cardId: 'akari' }), card('other1', { owner: 'A', cardId: 'akari' })])
  const interrupts = interruptsWith('akari', 'このキャラが', 'ダウンするとき')
  const eventOnSelf = { timing: 'ダウンするとき', actor: 'A' as const, targetIid: 'self1' }
  const eventOnOther = { timing: 'ダウンするとき', actor: 'A' as const, targetIid: 'other1' }
  const candSelf = findInterruptCandidates(eventOnSelf, 'A', board, interrupts)
  assertEqual(candSelf.length === 1 && candSelf[0].cardIid === 'self1', true, '主語4: このキャラが→対象が自分自身の候補だけ出る')
}

// 5. このアイテムを装備したキャラが: attachedTo===targetIid のときだけ
{
  const board = boardWith([
    card('char1', { owner: 'A', cardId: 'kamigishi' }),
    card('item1', { owner: 'A', cardId: 'yoroi', zone: 'hand', attachedTo: 'char1' }),
    card('item2', { owner: 'A', cardId: 'yoroi', zone: 'hand', attachedTo: null }),
  ])
  const interrupts = interruptsWith('yoroi', 'このアイテムを装備したキャラが', 'ダメージを受けたとき')
  const event = { timing: 'ダメージを受けたとき', actor: 'A' as const, targetIid: 'char1' }
  const candidates = findInterruptCandidates(event, 'A', board, interrupts)
  assertEqual(
    candidates.length === 1 && candidates[0].cardIid === 'item1',
    true,
    '主語5: このアイテムを装備したキャラが→装備済み(item1)だけ候補、未装備(item2)は出ない',
  )
}

// 6. なし・その他: 主語制約なし（タイミング一致のみ）
{
  const board = boardWith([card('drink', { owner: 'B', cardId: 'stamina' })])
  const interrupts = interruptsWith('stamina', '', 'ダメージを受けるとき')
  const event = { timing: 'ダメージを受けるとき', actor: 'A' as const, targetIid: 'someone-else' }
  assertEqual(findInterruptCandidates(event, 'B', board, interrupts).length, 1, '主語6: 主語なし→タイミング一致のみで成立')
}

// タイミング不一致なら候補にならない（非回帰）
{
  const board = boardWith([card('seb', { owner: 'A', cardId: 'sebastian' })])
  const interrupts = interruptsWith('sebastian', '味方キャラが', 'ダメージを受けるとき')
  const event = { timing: '特殊能力を使用したとき', actor: 'A' as const, targetIid: 'seb' }
  assertEqual(findInterruptCandidates(event, 'A', board, interrupts).length, 0, '非回帰: タイミング不一致では候補にならない')
}

// 相手の手札は候補に含まれない（伏せ情報を漏らさない・非回帰）
{
  const board = boardWith([card('oppo', { owner: 'B', cardId: 'stamina', zone: 'hand' })])
  const interrupts = interruptsWith('stamina', '', 'ダメージを受けるとき')
  const event = { timing: 'ダメージを受けるとき', actor: 'A' as const, targetIid: null }
  assertEqual(findInterruptCandidates(event, 'A', board, interrupts).length, 0, '非回帰: 相手所有のカードは候補に含まれない')
}

// デッキ/ゴミ箱のカードは候補から除外される（非回帰）
{
  const board = boardWith([card('deckcard', { owner: 'A', cardId: 'stamina', zone: 'deck' })])
  const interrupts = interruptsWith('stamina', '', 'ダメージを受けるとき')
  const event = { timing: 'ダメージを受けるとき', actor: 'A' as const, targetIid: null }
  assertEqual(findInterruptCandidates(event, 'A', board, interrupts).length, 0, '非回帰: デッキのカードは候補から除外される')
}

console.log(failures === 0 ? `\n✅ 全ケース成功` : `\n❌ ${failures}件失敗`)
process.exit(failures === 0 ? 0 : 1)
