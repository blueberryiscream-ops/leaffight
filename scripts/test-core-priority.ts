// P3a-1 検証スクリプト。core/priority.ts の遷移を直接叩いてassertする。
// devDependency追加なし: Node 25 のネイティブ TypeScript 型剥がしで `node scripts/test-core-priority.ts` として実行できる。
// PHASE3a-1.md §2「遷移が正しいことの手検算」の3ケース＋モード切替を再現する。

import { applyAction } from '../src/core/actions'
import { EMPTY_BOARD, type BoardState } from '../src/core/board'

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

function item(id: string, by: 'A' | 'B', label: string) {
  return { id, by, kind: 'その他' as const, sourceIid: null, label }
}

// --- ケース1: 基本 A declare → B pass → A pass → resolveTop → 窓閉じる ---
{
  let state: BoardState = EMPTY_BOARD
  let r = applyAction(state, { type: 'declareAction', item: item('i1', 'A', '調べる') })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.priority?.awaitingConsentFrom, 'B', 'ケース1: declare後はBが応答待ち')
  assertEqual(state.priority?.stack.length, 1, 'ケース1: stackに1件積まれる')

  r = applyAction(state, { type: 'passPriority', by: 'B' })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.priority?.awaitingConsentFrom, 'A', 'ケース1: B pass後はAが応答待ち')
  assertEqual(state.priority?.consentedInARow, ['B'], 'ケース1: consentedInARowに[B]')

  r = applyAction(state, { type: 'passPriority', by: 'A' })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.priority, null, 'ケース1: 両者pass後にresolveTopが発火しstack空→窓閉じる')
}

// --- ケース2: 入れ子の割り込み（LIFO） ---
{
  let state: BoardState = EMPTY_BOARD
  let r = applyAction(state, { type: 'declareAction', item: item('itemA', 'A', 'itemA') })
  state = r.state
  assertEqual(state.priority?.awaitingConsentFrom, 'B', 'ケース2: A declare後はBが応答待ち')

  r = applyAction(state, { type: 'declareAction', item: item('itemB', 'B', 'itemB') })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.priority?.stack.map((s) => s.id), ['itemA', 'itemB'], 'ケース2: itemBがpushされLIFOの末尾')
  assertEqual(state.priority?.awaitingConsentFrom, 'A', 'ケース2: B declare後はAが応答待ち')
  assertEqual(state.priority?.consentedInARow, [], 'ケース2: 宣言でconsentedInARowがリセット')

  r = applyAction(state, { type: 'passPriority', by: 'A' })
  state = r.state
  assertEqual(state.priority?.consentedInARow, ['A'], 'ケース2: A pass後は[A]')

  r = applyAction(state, { type: 'passPriority', by: 'B' })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.priority?.stack.map((s) => s.id), ['itemA'], 'ケース2: itemBが解決されitemAのみ残る（LIFO）')
  assertEqual(state.priority?.awaitingConsentFrom, 'B', 'ケース2: resolveTop後の合意ラウンドはother(activePlayer=A)=B')
  assertEqual(state.priority?.consentedInARow, [], 'ケース2: resolveTop後consentedInARowはリセット')

  r = applyAction(state, { type: 'passPriority', by: 'B' })
  state = r.state
  assertEqual(state.priority?.awaitingConsentFrom, 'A', 'ケース2: B pass後はAが応答待ち')

  r = applyAction(state, { type: 'passPriority', by: 'A' })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.priority, null, 'ケース2: itemAも解決されstack空→窓閉じる')
}

// --- ケース3: 不正操作（awaitingConsentFromでない側のdeclare/pass）は無視 ---
{
  let state: BoardState = EMPTY_BOARD
  let r = applyAction(state, { type: 'declareAction', item: item('i1', 'A', '調べる') })
  state = r.state
  assertEqual(state.priority?.awaitingConsentFrom, 'B', 'ケース3準備: Bが応答待ち')

  const before = state
  r = applyAction(state, { type: 'passPriority', by: 'A' }) // Aの番ではないのに pass
  assertEqual(r.state, before, 'ケース3: awaitingでない側のpassは無視される')
  assertEqual(r.log, '', 'ケース3: 不正操作のログは空')

  r = applyAction(state, { type: 'declareAction', item: item('i2', 'A', '横入り') }) // Aの番ではないのに declare
  assertEqual(r.state, before, 'ケース3: awaitingでない側のdeclareは無視される')
}

// --- ケース4: setMode ---
{
  let state: BoardState = EMPTY_BOARD
  let r = applyAction(state, { type: 'declareAction', item: item('i1', 'A', '調べる') })
  state = r.state
  assertEqual(state.priority !== null, true, 'ケース4準備: 窓が開いている')

  r = applyAction(state, { type: 'setMode', mode: 'free' })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.mode, 'free', 'ケース4: modeがfreeになる')
  assertEqual(state.priority, null, 'ケース4: freeにしたら窓が畳まれる')

  r = applyAction(state, { type: 'setMode', mode: 'assist' })
  state = r.state
  assertEqual(state.mode, 'assist', 'ケース4: assistに戻せる')
  assertEqual(state.priority, null, 'ケース4: assist復帰時、窓は開いていない（元がnullのため）')
}

// --- 既存reducerへの非回帰: spawnCard等はpriority/modeに触れない ---
{
  const r = applyAction(EMPTY_BOARD, {
    type: 'spawnCard',
    iid: 'c1',
    cardId: 'ch_test',
    cardName: 'テストキャラ',
    owner: 'A',
    zone: 'char',
  })
  assertEqual(r.state.priority, null, '非回帰: spawnCardはpriorityに触れない')
  assertEqual(r.state.mode, 'assist', '非回帰: spawnCardはmodeに触れない')
  assertEqual(Object.keys(r.state.cards).length, 1, '非回帰: spawnCardは従来通りカードを追加する')
}

console.log(failures === 0 ? `\n✅ 全ケース成功` : `\n❌ ${failures}件失敗`)
process.exit(failures === 0 ? 0 : 1)
