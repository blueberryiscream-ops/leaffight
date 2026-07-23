// P3a-1r 検証スクリプト。core/priority.ts の新モデル（2枠＋step＋frames）の遷移を直接叩いてassertする。
// devDependency追加なし: Node 25 のネイティブ TypeScript 型剥がしで `node scripts/test-core-priority.ts` として実行できる。
// PHASE3a-1r.md §3「手検算（この通り動くこと）」の5ケース＋モード切替＋非回帰を再現する。
// 旧モデル（stack/LIFO）のテストは全面置換（DESIGN.md §5.1「モデルの訂正」）。

import { applyAction } from '../src/core/actions'
import { EMPTY_BOARD, type BoardState } from '../src/core/board'
import * as priorityEngine from '../src/core/priority'
import type { DeclaredAction, Priority } from '../src/core/priority'

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

function action(by: 'A' | 'B', label: string): DeclaredAction {
  return { by, sourceIid: null, kind: 'その他', actionType: '通常型', label }
}

function currentStep(priority: Priority | null) {
  return priority?.frames[priority.frames.length - 1]?.step ?? null
}

// --- ケース1: 基本（自分だけ）: A declare→awaitNonActive→B pass→active有/nonActive無→processActive→resolveStep→窓閉じる ---
{
  let state: BoardState = EMPTY_BOARD
  let r = applyAction(state, { type: 'declareAction', action: action('A', '調べる') })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(currentStep(state.priority), 'awaitNonActive', 'ケース1: declare後はawaitNonActive')
  assertEqual(state.priority?.frames.length, 1, 'ケース1: frameが1つ')
  assertEqual(state.priority?.frames[0].active?.label, '調べる', 'ケース1: activeにAの宣言')
  assertEqual(state.priority?.frames[0].nonActive, null, 'ケース1: nonActiveはまだ空')

  r = applyAction(state, { type: 'passPriority', by: 'B' })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(currentStep(state.priority), 'processActive', 'ケース1: B pass後はprocessActive（activeのみ有）')

  r = applyAction(state, { type: 'resolveStep' })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.priority, null, 'ケース1: resolveStepでnonActiveが無いので窓閉じる')
}

// --- ケース2: 1＋1: A declare→B declare→processActive→resolve→processNonActive→resolve→閉じる（アクティブ→非アクティブ順） ---
{
  let state: BoardState = EMPTY_BOARD
  let r = applyAction(state, { type: 'declareAction', action: action('A', 'アクション甲') })
  state = r.state

  r = applyAction(state, { type: 'declareAction', action: action('B', 'アクション乙') })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(currentStep(state.priority), 'processActive', 'ケース2: 両者宣言後はprocessActive')
  assertEqual(state.priority?.frames[0].active?.label, 'アクション甲', 'ケース2: activeはA')
  assertEqual(state.priority?.frames[0].nonActive?.label, 'アクション乙', 'ケース2: nonActiveはB')

  r = applyAction(state, { type: 'resolveStep' })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(currentStep(state.priority), 'processNonActive', 'ケース2: activeを解決したらprocessNonActiveへ（アクティブ→非アクティブ順）')
  assertEqual(state.priority?.frames.length, 1, 'ケース2: 窓はまだ閉じない')

  r = applyAction(state, { type: 'resolveStep' })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.priority, null, 'ケース2: nonActiveも解決して窓閉じる')
}

// --- ケース3: 入れ子: processActive中にBが割り込みdeclare→新フレームpush→1〜2で解決→pop→親のprocessActiveに戻る ---
{
  let state: BoardState = EMPTY_BOARD
  let r = applyAction(state, { type: 'declareAction', action: action('A', '外側甲') })
  state = r.state
  r = applyAction(state, { type: 'declareAction', action: action('B', '外側乙') })
  state = r.state
  assertEqual(currentStep(state.priority), 'processActive', 'ケース3準備: 外側の窓がprocessActive')
  assertEqual(state.priority?.frames.length, 1, 'ケース3準備: frameは1つ')

  // 外側processActive中にBが割り込み宣言 → 入れ子で新フレームpush
  r = applyAction(state, { type: 'declareAction', action: action('B', '割り込み') })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.priority?.frames.length, 2, 'ケース3: 割り込みで新フレームがpushされ2段になる')
  assertEqual(currentStep(state.priority), 'awaitNonActive', 'ケース3: 内側フレームはawaitNonActiveから開始')
  assertEqual(state.priority?.frames[1].active?.label, '割り込み', 'ケース3: 内側frameのactiveはBの割り込み')

  // 内側フレームを「パターン1」で解決: Aがパス→active有/nonActive無→processActive→resolveStep→pop
  r = applyAction(state, { type: 'passPriority', by: 'A' })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(currentStep(state.priority), 'processActive', 'ケース3: 内側フレームでAがパスしprocessActiveへ（活きるのはBの割り込みだけ）')
  assertEqual(state.priority?.frames.length, 2, 'ケース3: まだ2段（内側フレームはprocessActiveのまま）')

  r = applyAction(state, { type: 'resolveStep' })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.priority?.frames.length, 1, 'ケース3: 内側フレームが解決されpopされ親に戻る')
  assertEqual(currentStep(state.priority), 'processActive', 'ケース3: 親フレームはprocessActiveのまま（外側甲/乙は未解決で維持）')
  assertEqual(state.priority?.frames[0].active?.label, '外側甲', 'ケース3: 親フレームのactiveは外側甲のまま残っている')
  assertEqual(state.priority?.frames[0].nonActive?.label, '外側乙', 'ケース3: 親フレームのnonActiveも外側乙のまま残っている')

  // 親フレームの続き: active→nonActiveの順で解決して窓を閉じる
  r = applyAction(state, { type: 'resolveStep' })
  state = r.state
  assertEqual(currentStep(state.priority), 'processNonActive', 'ケース3: 親フレームのactive解決でprocessNonActiveへ')
  r = applyAction(state, { type: 'resolveStep' })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.priority, null, 'ケース3: 親フレームのnonActiveも解決し窓閉じる')
}

// --- ケース4: 誰も宣言せず: A pass→B pass→窓閉じる（§13-3-1）。窓がawaitActiveで開いている状態を直接構成して検証 ---
{
  // declareActionは常に宣言と同時にactiveを埋めて開くため、reducer経由ではawaitActive（active===null）
  // に到達しない。この状態機械はその状態でも正しく振る舞う必要があるので、状態を直接構成してテストする
  // （PHASE3a-1r.md §3 ケース4はこの意味で「純粋関数を任意の妥当な入力で検証する」テスト）。
  const opened: Priority = { frames: [{ active: null, nonActive: null, step: 'awaitActive' }], activePlayer: 'A' }

  let r = priorityEngine.passPriority(opened, 'A')
  console.log('  log:', r.log)
  assertEqual(r.priority?.frames[0].step, 'awaitNonActive', 'ケース4: AがパスしawaitNonActiveへ')
  assertEqual(r.priority?.frames[0].active, null, 'ケース4: activeは空のまま')

  const afterA = r.priority!
  r = priorityEngine.passPriority(afterA, 'B')
  console.log('  log:', r.log)
  assertEqual(r.priority, null, 'ケース4: 両者とも宣言せずパスし窓が閉じる（anti-deadlock）')
}

// --- ケース5: 不正: 手番でない側のdeclare/passは無視 ---
{
  let state: BoardState = EMPTY_BOARD
  let r = applyAction(state, { type: 'declareAction', action: action('A', '調べる') })
  state = r.state
  assertEqual(currentStep(state.priority), 'awaitNonActive', 'ケース5準備: awaitNonActive（Bの番）')

  const before = state
  r = applyAction(state, { type: 'passPriority', by: 'A' }) // Aの番ではないのに pass
  assertEqual(r.state, before, 'ケース5: 手番でない側のpassは無視される')
  assertEqual(r.log, '', 'ケース5: 不正操作のログは空')

  r = applyAction(state, { type: 'declareAction', action: action('A', '横入り') }) // Aの番ではないのに declare
  assertEqual(r.state, before, 'ケース5: 手番でない側のdeclareは無視される')

  r = applyAction(state, { type: 'resolveStep' }) // 宣言フェーズ中のresolveStepも無効
  assertEqual(r.state, before, 'ケース5: 宣言フェーズ中のresolveStepは無視される')
}

// --- setMode ---
{
  let state: BoardState = EMPTY_BOARD
  let r = applyAction(state, { type: 'declareAction', action: action('A', '調べる') })
  state = r.state
  assertEqual(state.priority !== null, true, 'setMode準備: 窓が開いている')

  r = applyAction(state, { type: 'setMode', mode: 'free' })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.mode, 'free', 'setMode: modeがfreeになる')
  assertEqual(state.priority, null, 'setMode: freeにしたら窓が畳まれる')

  r = applyAction(state, { type: 'setMode', mode: 'assist' })
  state = r.state
  assertEqual(state.mode, 'assist', 'setMode: assistに戻せる')
  assertEqual(state.priority, null, 'setMode: assist復帰時、窓は開いていない（元がnullのため）')
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
