// P3a-3 検証スクリプト。手札プレイの自動宣言（ドロップ＝宣言、着地は解決時）を reducer レベルで
// 直接叩いてassertする。devDependency追加なし: Node 25のネイティブTS型剥がしで直接実行できる。
// PHASE3a-3.md §4「テスト」の6ケースに対応。

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

function spawnHandCard(state: BoardState, iid: string, owner: 'A' | 'B', cardName = 'ガセネタ'): BoardState {
  return applyAction(state, { type: 'spawnCard', iid, cardId: 'e_test', cardName, owner, zone: 'hand' }).state
}

function playDeclareAction(by: 'A' | 'B', sourceIid: string, toZone: 'trash' = 'trash'): DeclaredAction {
  return { by, sourceIid, kind: 'プレイ', actionType: '通常型', label: 'ガセネタ', detail: 'ゴミ箱へ', place: { toZone } }
}

// --- ケース1: 手札のeカードをplace={toZone:'trash'}で宣言 → zoneがpendingになる／priorityが開く ---
{
  let state = spawnHandCard(EMPTY_BOARD, 'h1', 'A')
  const r = applyAction(state, { type: 'declareAction', action: playDeclareAction('A', 'h1') })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.cards['h1'].zone, 'pending', 'ケース1: 宣言でzoneがpendingになる')
  assertEqual(state.priority !== null, true, 'ケース1: priorityが開く')
  assertEqual(state.priority?.frames[0].active?.place?.toZone, 'trash', 'ケース1: placeがそのまま素通しされている')
}

// --- ケース2: 上をresolveStep（cancelなし）→ zoneがtrashになり、窓が閉じる ---
{
  let state = spawnHandCard(EMPTY_BOARD, 'h1', 'A')
  state = applyAction(state, { type: 'declareAction', action: playDeclareAction('A', 'h1') }).state
  state = applyAction(state, { type: 'passPriority', by: 'B' }).state
  const r = applyAction(state, { type: 'resolveStep' })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.cards['h1'].zone, 'trash', 'ケース2: resolveStepでplace通りtrashに着地')
  assertEqual(state.priority, null, 'ケース2: 窓が閉じる')
}

// --- ケース3: 上をresolveStep({cancel:true}) → zoneがhandに戻り、窓が閉じる ---
{
  let state = spawnHandCard(EMPTY_BOARD, 'h1', 'A')
  state = applyAction(state, { type: 'declareAction', action: playDeclareAction('A', 'h1') }).state
  state = applyAction(state, { type: 'passPriority', by: 'B' }).state
  const r = applyAction(state, { type: 'resolveStep', cancel: true })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.cards['h1'].zone, 'hand', 'ケース3: 取り消しでhandに戻る')
  assertEqual(state.cards['h1'].owner, 'A', 'ケース3: 持ち主のhandに戻る')
  assertEqual(state.priority, null, 'ケース3: 窓が閉じる')
  assertEqual(r.log.includes('取り消した'), true, 'ケース3: ログに取り消し文言が入る')
}

// --- ケース4: 弾かれる宣言（相手の応答待ち中に自分が宣言）→ state が完全に不変 ---
{
  let state = spawnHandCard(EMPTY_BOARD, 'h1', 'A')
  state = spawnHandCard(state, 'h2', 'A', '時間稼ぎ')
  state = applyAction(state, { type: 'declareAction', action: playDeclareAction('A', 'h1') }).state
  // 今はBの応答待ち（awaitNonActive）。Aがもう一度宣言しようとしても弾かれるはず
  const before = state
  const r = applyAction(state, { type: 'declareAction', action: playDeclareAction('A', 'h2') })
  assertEqual(r.state, before, 'ケース4: 弾かれた宣言でstateが完全に不変（カードが消えない）')
  assertEqual(r.log, '', 'ケース4: 弾かれた宣言のログは空')
  assertEqual(r.state.cards['h2'].zone, 'hand', 'ケース4: h2は手札に残ったまま')
}

// --- ケース5: 宣言中にsetMode('free') → pendingが空になり、カードが持ち主の手札に戻る ---
{
  let state = spawnHandCard(EMPTY_BOARD, 'h1', 'A')
  state = applyAction(state, { type: 'declareAction', action: playDeclareAction('A', 'h1') }).state
  assertEqual(state.cards['h1'].zone, 'pending', 'ケース5準備: pendingにいる')

  const r = applyAction(state, { type: 'setMode', mode: 'free' })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.mode, 'free', 'ケース5: modeがfreeになる')
  assertEqual(state.priority, null, 'ケース5: 窓が畳まれる')
  assertEqual(state.cards['h1'].zone, 'hand', 'ケース5: pendingのカードが手札に戻る')
  assertEqual(state.cards['h1'].owner, 'A', 'ケース5: 持ち主のhandに戻る')
  const stillPending = Object.values(state.cards).some((c) => c.zone === 'pending')
  assertEqual(stillPending, false, 'ケース5: 不変条件（priority===nullのときpendingは空）を満たす')
}

// --- ケース6: canDeclareがdeclareActionの受理と一致する（4パターン） ---
{
  function checkParity(priority: Priority | null, seat: 'A' | 'B', label: string) {
    const expected = priorityEngine.canDeclare(priority, seat)
    const probe: DeclaredAction = { by: seat, sourceIid: null, kind: 'その他', actionType: '通常型', label: 'probe' }
    const r = priorityEngine.declareAction(priority, probe)
    const actuallyAccepted = r.log !== ''
    assertEqual(expected, actuallyAccepted, `ケース6(${label}): canDeclare(${seat})=${expected} と実際の受理結果が一致`)
  }

  // パターンA: priority===null → true
  checkParity(null, 'A', 'priority null')

  // パターンB: awaitNonActive（Aが開いた窓。Bの番）
  const opened = priorityEngine.declareAction(null, { by: 'A', sourceIid: null, kind: 'その他', actionType: '通常型', label: 'x' }).priority
  checkParity(opened, 'B', 'awaitNonActive・正しい側')
  checkParity(opened, 'A', 'awaitNonActive・誤った側')

  // パターンC: processActive/processNonActive（入れ子の割り込み。どちらの席も常に受理）
  const processing: Priority = { frames: [{ active: opened!.frames[0].active, nonActive: null, step: 'processActive' }], activePlayer: 'A' }
  checkParity(processing, 'A', 'processActive・A')
  checkParity(processing, 'B', 'processActive・B')

  // パターンD: awaitActive（現在の宣言経路では未到達だが、状態機械としての整合性を確認）
  const awaitingActive: Priority = { frames: [{ active: null, nonActive: null, step: 'awaitActive' }], activePlayer: 'A' }
  checkParity(awaitingActive, 'A', 'awaitActive・正しい側')
  checkParity(awaitingActive, 'B', 'awaitActive・誤った側')
}

console.log(failures === 0 ? `\n✅ 全ケース成功` : `\n❌ ${failures}件失敗`)
process.exit(failures === 0 ? 0 : 1)
