// PHASE3d-3.md §6 検証スクリプト。src/ui/board/battleValues.ts（攻防の自動入力）と
// src/ui/board/normalize.ts（旧stateの正規化）を、偽のカードで直接叩いてassertする。
// データzip（leaffight-data.zip）は読まない。devDependency追加なし。

import * as battleEngine from '../src/core/battle'
import { EMPTY_BOARD, type BoardState, type CardInstance, type Modifier } from '../src/core/board'
import type { Card } from '../src/core/types'
import { autoBattleValues, isBasicBattleCard } from '../src/ui/board/battleValues'
import { normalizeModifiers } from '../src/ui/board/normalize'

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

function fakeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'x',
    kind: 'b',
    name: 'テストカード',
    kana: '',
    setVer: '1',
    printings: [],
    num: -1,
    kiryoku: null,
    stats: null,
    cost: '',
    attr: '',
    battleAtk: '力',
    battleDef: '早',
    abilities: [],
    illust: '',
    ...overrides,
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

function boardWith(cards: CardInstance[], modifiers: Modifier[] = [], battle: battleEngine.Battle | null = null): BoardState {
  const cardMap: Record<string, CardInstance> = {}
  for (const c of cards) cardMap[c.iid] = c
  const modMap: Record<string, Modifier> = {}
  for (const m of modifiers) modMap[m.id] = m
  return { ...EMPTY_BOARD, cards: cardMap, modifiers: modMap, battle }
}

// =============================================================================
// 1. isBasicBattleCard: 力/早・abilities空→true／力/早・abilitiesあり→false／'-'・'？'・'力+早'→false
// =============================================================================
{
  assertEqual(isBasicBattleCard(fakeCard({ battleAtk: '力', battleDef: '早', abilities: [] })), true, '1a: 力/早・abilities空 → true')
  assertEqual(
    isBasicBattleCard(fakeCard({ battleAtk: '力', battleDef: '早', abilities: [{ header: 'h', text: 't' }] })),
    false,
    '1b: 力/早・abilitiesあり → false',
  )
  assertEqual(isBasicBattleCard(fakeCard({ battleAtk: '-', battleDef: '早', abilities: [] })), false, "1c: '-' → false")
  assertEqual(isBasicBattleCard(fakeCard({ battleAtk: '？', battleDef: '早', abilities: [] })), false, "1d: '？' → false")
  assertEqual(isBasicBattleCard(fakeCard({ battleAtk: '力+早', battleDef: '早', abilities: [] })), false, "1e: '力+早' → false")
}

// =============================================================================
// 2. autoBattleValues: 1体参加でeffectiveStat（能力値修正込み）＋攻防修正が入る
// =============================================================================
{
  const cardOf = (cardId: string) => (cardId === 'bcard' ? fakeCard({ id: 'bcard', battleAtk: '力', battleDef: '早', abilities: [] }) : cardId === 'charA' ? fakeCard({ id: 'charA', kind: 'c', stats: { 力: 3, 早: 2, 賢: 0, 根: 0, 感: 0 } }) : cardId === 'charB' ? fakeCard({ id: 'charB', kind: 'c', stats: { 力: 1, 早: 4, 賢: 0, 根: 0, 感: 0 } }) : undefined)

  const board = boardWith(
    [
      card('bcard1', { owner: 'A', zone: 'battle', cardId: 'bcard' }),
      card('cA', { owner: 'A', zone: 'char', cardId: 'charA' }),
      card('cB', { owner: 'B', zone: 'char', cardId: 'charB' }),
    ],
    [
      { id: 'm1', targetIid: 'cA', sourceLabel: 'アイテム', kind: '能力値修正', stat: '力', delta: 2, scope: 'ターン終了時' },
      { id: 'm2', targetIid: 'cA', sourceLabel: '攻防修正', kind: '攻防修正', battleStat: 'atk', delta: 5, scope: 'このバトル' },
    ],
  )
  let { battle } = battleEngine.declareBattle('A')
  battle = battleEngine.setParticipants(battle, 'A', ['cA']).battle
  battle = battleEngine.setParticipants(battle, 'B', ['cB']).battle
  battle = { ...battle, battleCardIid: 'bcard1' }

  const auto = autoBattleValues(board, battle, cardOf)
  // A: 攻 = effectiveStat(力=3+2能力値修正=5) + 攻防修正atk(+5) = 10／防 = effectiveStat(早=2、能力値修正なし) = 2
  assertEqual(auto.atk.A, 10, '2a: Aの攻撃値 = effectiveStat(能力値修正込み) + 攻防修正の合計')
  assertEqual(auto.def.A, 2, '2b: Aの防御値（攻防修正なし）はeffectiveStatのみ')
  // B: 攻 = 力=1（修正なし）／防 = 早=4（修正なし）
  assertEqual(auto.atk.B, 1, '2c: Bの攻撃値（修正なし）')
  assertEqual(auto.def.B, 4, '2d: Bの防御値（修正なし）')
}

// =============================================================================
// 3. autoBattleValues: 2体参加の陣営はnull
// =============================================================================
{
  const cardOf = (cardId: string) => (cardId === 'bcard' ? fakeCard({ id: 'bcard', battleAtk: '力', battleDef: '早', abilities: [] }) : fakeCard({ id: cardId, kind: 'c', stats: { 力: 3, 早: 2, 賢: 0, 根: 0, 感: 0 } }))
  const board = boardWith([
    card('bcard1', { owner: 'A', zone: 'battle', cardId: 'bcard' }),
    card('cA1', { owner: 'A', zone: 'char' }),
    card('cA2', { owner: 'A', zone: 'char' }),
    card('cB1', { owner: 'B', zone: 'char' }),
  ])
  let { battle } = battleEngine.declareBattle('A')
  battle = battleEngine.setParticipants(battle, 'A', ['cA1', 'cA2']).battle
  battle = battleEngine.setParticipants(battle, 'B', ['cB1']).battle
  battle = { ...battle, battleCardIid: 'bcard1' }

  const auto = autoBattleValues(board, battle, cardOf)
  assertEqual(auto.atk.A, null, '3a: 2体参加の陣営はatkがnull')
  assertEqual(auto.def.A, null, '3b: 2体参加の陣営はdefもnull')
  assertTrue(auto.atk.B !== null, '3c: 1体参加の陣営（B）は影響を受けず値が出る')
}

// =============================================================================
// 4. autoBattleValues: 特殊カード（basicでない）は両陣営null
// =============================================================================
{
  const cardOf = (cardId: string) =>
    cardId === 'bcard'
      ? fakeCard({ id: 'bcard', battleAtk: '力', battleDef: '早', abilities: [{ header: 'h', text: 't' }] }) // テキストあり＝基本ではない
      : fakeCard({ id: cardId, kind: 'c', stats: { 力: 3, 早: 2, 賢: 0, 根: 0, 感: 0 } })
  const board = boardWith([
    card('bcard1', { owner: 'A', zone: 'battle', cardId: 'bcard' }),
    card('cA1', { owner: 'A', zone: 'char' }),
    card('cB1', { owner: 'B', zone: 'char' }),
  ])
  let { battle } = battleEngine.declareBattle('A')
  battle = battleEngine.setParticipants(battle, 'A', ['cA1']).battle
  battle = battleEngine.setParticipants(battle, 'B', ['cB1']).battle
  battle = { ...battle, battleCardIid: 'bcard1' }

  const auto = autoBattleValues(board, battle, cardOf)
  assertEqual(auto, { atk: { A: null, B: null }, def: { A: null, B: null } }, '4: 特殊カード（abilitiesあり）は両陣営null')
}

// =============================================================================
// 5. autoBattleValues: statsなしはnull
// =============================================================================
{
  const cardOf = (cardId: string) =>
    cardId === 'bcard' ? fakeCard({ id: 'bcard', battleAtk: '力', battleDef: '早', abilities: [] }) : fakeCard({ id: cardId, kind: 'c', stats: null })
  const board = boardWith([
    card('bcard1', { owner: 'A', zone: 'battle', cardId: 'bcard' }),
    card('cA1', { owner: 'A', zone: 'char' }),
    card('cB1', { owner: 'B', zone: 'char' }),
  ])
  let { battle } = battleEngine.declareBattle('A')
  battle = battleEngine.setParticipants(battle, 'A', ['cA1']).battle
  battle = battleEngine.setParticipants(battle, 'B', ['cB1']).battle
  battle = { ...battle, battleCardIid: 'bcard1' }

  const auto = autoBattleValues(board, battle, cardOf)
  assertEqual(auto, { atk: { A: null, B: null }, def: { A: null, B: null } }, '5: statsが無いカードはnull')
}

// =============================================================================
// 6. normalizeModifiers: 旧state（kind無し）を1件読み込むと'能力値修正'に正規化される
// =============================================================================
{
  const oldModifier = { id: 'm1', targetIid: 'c1', sourceLabel: 'old', stat: '力', delta: 2, scope: 'このバトル' } as unknown as Modifier
  const board: BoardState = { ...EMPTY_BOARD, modifiers: { m1: oldModifier } }
  const normalized = normalizeModifiers(board)
  assertEqual(normalized.modifiers['m1'].kind, '能力値修正', '6a: kindが無いModifierは能力値修正に正規化される')

  // 非回帰: kindがあるものは変更されない
  const board2: BoardState = {
    ...EMPTY_BOARD,
    modifiers: { m2: { id: 'm2', targetIid: 'c1', sourceLabel: 'new', kind: '攻防修正', battleStat: 'atk', delta: 1, scope: 'このバトル' } },
  }
  const normalized2 = normalizeModifiers(board2)
  assertEqual(normalized2, board2, '6b: kindがあるModifierは変更されない（同じ内容）')
}

console.log(failures === 0 ? `\n✅ 全ケース成功` : `\n❌ ${failures}件失敗`)
process.exit(failures === 0 ? 0 : 1)
