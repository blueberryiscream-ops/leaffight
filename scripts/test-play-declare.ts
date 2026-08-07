// P3a-4 検証スクリプト。手札プレイの自動宣言と「行き先はルールが決める」解決を reducer レベルで
// 直接叩いてassertする。devDependency追加なし: Node 25のネイティブTS型剥がしで直接実行できる。
//
// 🚨 P3a-3 の「着地先(place)を宣言時に記憶する」設計は原典に反しており撤回した（PHASE3a-4.md §0）。
// 行き先はカードの種別とルールが一意に決めるため、UI側が resolveStep に `to`（ゾーンだけ）を渡す。
// core はカード種別を知らないので、ここでもテストは `to` を直接渡して検証する。

import { applyAction } from '../src/core/actions'
import { EMPTY_BOARD, type BoardState, type ZoneId } from '../src/core/board'
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

function spawnCard(
  state: BoardState,
  iid: string,
  owner: 'A' | 'B',
  zone: ZoneId,
  cardName = 'ガセネタ',
): BoardState {
  return applyAction(state, { type: 'spawnCard', iid, cardId: 'e_test', cardName, owner, zone }).state
}

function spawnHandCard(state: BoardState, iid: string, owner: 'A' | 'B', cardName = 'ガセネタ'): BoardState {
  return spawnCard(state, iid, owner, 'hand', cardName)
}

function playDeclareAction(by: 'A' | 'B', sourceIid: string): DeclaredAction {
  return { by, sourceIid, kind: 'プレイ', actionType: '通常型', label: 'ガセネタ' }
}

// --- ケース1: 手札のカードをプレイ宣言 → zoneがpendingになる／priorityが開く ---
{
  let state = spawnHandCard(EMPTY_BOARD, 'h1', 'A')
  const r = applyAction(state, { type: 'declareAction', action: playDeclareAction('A', 'h1') })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.cards['h1'].zone, 'pending', 'ケース1: 宣言でzoneがpendingになる')
  assertEqual(state.priority !== null, true, 'ケース1: priorityが開く')
  // 🚨 place（着地先）はもう存在しない。DeclaredActionは「何を宣言したか」だけを持つ
  assertEqual('place' in (state.priority!.frames[0].active as object), false, 'ケース1: 宣言にplaceが残っていない')
}

// --- ケース2: イベント相当（to={toZone:'trash'}）で解決 → ゴミ箱に行き、窓が閉じる ---
{
  let state = spawnHandCard(EMPTY_BOARD, 'h1', 'A')
  state = applyAction(state, { type: 'declareAction', action: playDeclareAction('A', 'h1') }).state
  state = applyAction(state, { type: 'passPriority', by: 'B' }).state
  const r = applyAction(state, { type: 'resolveStep', to: { toZone: 'trash' } })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.cards['h1'].zone, 'trash', 'ケース2: イベントは解決でゴミ箱へ（16-1[6]）')
  assertEqual(state.cards['h1'].owner, 'A', 'ケース2: 自分のゴミ箱へ')
  assertEqual(state.priority, null, 'ケース2: 窓が閉じる')
}

// --- ケース3: 行き先未指定（キャラ/アイテム相当）で解決 → pendingに残り、窓は閉じる ---
{
  let state = spawnHandCard(EMPTY_BOARD, 'h1', 'A', 'ほのか')
  state = applyAction(state, { type: 'declareAction', action: playDeclareAction('A', 'h1') }).state
  state = applyAction(state, { type: 'passPriority', by: 'B' }).state
  const r = applyAction(state, { type: 'resolveStep' })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.cards['h1'].zone, 'pending', 'ケース3: 行き先未指定のカードは提示エリアに残る')
  assertEqual(state.priority, null, 'ケース3: 窓は閉じる')
  // 🚨 P3a-3の不変条件「priority===null なら pending は空」は本フェーズで意図的に成り立たなくなった
  // （PHASE3a-4.md §1-5）。人間がドラッグで置くまで残るのが正しい状態
  assertEqual(
    Object.values(state.cards).some((c) => c.zone === 'pending'),
    true,
    'ケース3: priority===nullでもpendingにカードが残りうる（新しい不変条件）',
  )
}

// --- ケース4: フィールドカード相当（to={toZone:'field'}） → フィールド枠へ。既存の1枚はゴミ箱送り ---
{
  let state = spawnCard(EMPTY_BOARD, 'f_old', 'B', 'field', '旧フィールド')
  state = spawnHandCard(state, 'h1', 'A', '新フィールド')
  state = applyAction(state, { type: 'declareAction', action: playDeclareAction('A', 'h1') }).state
  state = applyAction(state, { type: 'passPriority', by: 'B' }).state
  const r = applyAction(state, { type: 'resolveStep', to: { toZone: 'field' } })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.cards['h1'].zone, 'field', 'ケース4: フィールドカードはフィールド枠へ（18-2）')
  assertEqual(state.cards['f_old'].zone, 'trash', 'ケース4: 既存のフィールドカードはゴミ箱送り（18-2）')
  assertEqual(state.cards['f_old'].owner, 'B', 'ケース4: 押し出された側は持ち主のゴミ箱へ')
  // 🚨 汎用のmoveCard押し出しは「移動元へ入れ替える」ため、対策しないと旧フィールドカードが
  // pending（提示エリア）に迷い込む。そうなっていないことを明示的に守る
  assertEqual(
    Object.values(state.cards).some((c) => c.zone === 'pending'),
    false,
    'ケース4: 押し出された側がpendingに迷い込まない',
  )
}

// --- ケース5: 弾かれる宣言（相手の応答待ち中に自分が宣言）→ state が完全に不変 ---
{
  let state = spawnHandCard(EMPTY_BOARD, 'h1', 'A')
  state = spawnHandCard(state, 'h2', 'A', '時間稼ぎ')
  state = applyAction(state, { type: 'declareAction', action: playDeclareAction('A', 'h1') }).state
  // 今はBの応答待ち（awaitNonActive）。Aがもう一度宣言しようとしても弾かれるはず
  const before = state
  const r = applyAction(state, { type: 'declareAction', action: playDeclareAction('A', 'h2') })
  assertEqual(r.state, before, 'ケース5: 弾かれた宣言でstateが完全に不変（カードが消えない）')
  assertEqual(r.log, '', 'ケース5: 弾かれた宣言のログは空')
  assertEqual(r.state.cards['h2'].zone, 'hand', 'ケース5: h2は手札に残ったまま')
}

// --- ケース6: 盤面のカードの起動型能力（kind:'能力'）はカードを動かさない ---
{
  let state = spawnCard(EMPTY_BOARD, 'c1', 'A', 'char', 'ほのか')
  const ability: DeclaredAction = {
    by: 'A',
    sourceIid: 'c1',
    kind: '能力',
    actionType: '通常型',
    label: 'ほのかの能力',
  }
  state = applyAction(state, { type: 'declareAction', action: ability }).state
  assertEqual(state.cards['c1'].zone, 'char', 'ケース6: 能力宣言では場のカードは動かない')
  state = applyAction(state, { type: 'passPriority', by: 'B' }).state
  state = applyAction(state, { type: 'resolveStep' }).state
  assertEqual(state.cards['c1'].zone, 'char', 'ケース6: 能力解決でも場のカードは動かない（15-13-1）')
  assertEqual(state.priority, null, 'ケース6: 窓が閉じる')
}

// --- ケース7: 宣言中にsetMode('free') → pendingが空になり、カードが持ち主の手札に戻る ---
{
  let state = spawnHandCard(EMPTY_BOARD, 'h1', 'A')
  state = applyAction(state, { type: 'declareAction', action: playDeclareAction('A', 'h1') }).state
  assertEqual(state.cards['h1'].zone, 'pending', 'ケース7準備: pendingにいる')

  const r = applyAction(state, { type: 'setMode', mode: 'free' })
  state = r.state
  console.log('  log:', r.log)
  assertEqual(state.mode, 'free', 'ケース7: modeがfreeになる')
  assertEqual(state.priority, null, 'ケース7: 窓が畳まれる')
  assertEqual(state.cards['h1'].zone, 'hand', 'ケース7: pendingのカードが手札に戻る')
  assertEqual(state.cards['h1'].owner, 'A', 'ケース7: 持ち主のhandに戻る')
  const stillPending = Object.values(state.cards).some((c) => c.zone === 'pending')
  // 🚨 フリーモードでは優先権UIごと消える＝提示エリアの描画場所が無くなるので、
  // ここだけは「pendingを空にする」を残す（PHASE3a-4.md §1-5）
  assertEqual(stillPending, false, 'ケース7: free化ではpendingが空になる（提示エリアが消えるため）')
}

// --- ケース8: 解決後もpendingに残ったカードは、free化で手札に戻る（置き忘れの救済） ---
{
  let state = spawnHandCard(EMPTY_BOARD, 'h1', 'A', 'ほのか')
  state = applyAction(state, { type: 'declareAction', action: playDeclareAction('A', 'h1') }).state
  state = applyAction(state, { type: 'passPriority', by: 'B' }).state
  state = applyAction(state, { type: 'resolveStep' }).state
  assertEqual(state.cards['h1'].zone, 'pending', 'ケース8準備: 解決後もpendingに残る')
  state = applyAction(state, { type: 'setMode', mode: 'free' }).state
  assertEqual(state.cards['h1'].zone, 'hand', 'ケース8: 窓が閉じた後のpendingもfree化で手札に戻る')
}

// --- ケース9: 旧盤面互換。placeを持つ古いDeclaredActionが残っていても壊れない ---
{
  let state = spawnHandCard(EMPTY_BOARD, 'h1', 'A')
  // P3a-3時代に保存された priority を手で組む（placeは型からは消えたが、保存済みJSONには残っている）
  const legacyAction = {
    by: 'A',
    sourceIid: 'h1',
    kind: 'プレイ',
    actionType: '通常型',
    label: 'ガセネタ',
    detail: 'フィールドへ',
    place: { toOwner: 'A', toZone: 'field' },
  } as unknown as DeclaredAction
  state = {
    ...state,
    cards: { ...state.cards, h1: { ...state.cards['h1'], zone: 'pending', index: 0 } },
    priority: { frames: [{ active: legacyAction, nonActive: null, step: 'processActive' }], activePlayer: 'A' },
  }
  const r = applyAction(state, { type: 'resolveStep' })
  assertEqual(r.log !== '', true, 'ケース9: 旧shapeの宣言でもresolveStepが通る（例外を投げない）')
  // 🚨 旧placeは読まない。行き先未指定＝pendingに残す（人間が置く）。旧盤面が勝手にfieldへ飛ばない
  assertEqual(r.state.cards['h1'].zone, 'pending', 'ケース9: 旧placeは無視され、提示エリアに残る')
  assertEqual(r.state.priority, null, 'ケース9: 窓は正常に閉じる')
}

// --- ケース10: canDeclareがdeclareActionの受理と一致する（4パターン） ---
{
  function checkParity(priority: Priority | null, seat: 'A' | 'B', label: string) {
    const expected = priorityEngine.canDeclare(priority, seat)
    const probe: DeclaredAction = { by: seat, sourceIid: null, kind: 'その他', actionType: '通常型', label: 'probe' }
    const r = priorityEngine.declareAction(priority, probe)
    const actuallyAccepted = r.log !== ''
    assertEqual(expected, actuallyAccepted, `ケース10(${label}): canDeclare(${seat})=${expected} と実際の受理結果が一致`)
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
