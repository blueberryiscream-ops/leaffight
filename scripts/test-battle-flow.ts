// PHASE3d-2a.md §7 検証スクリプト。バトルを優先権の窓につなぐ自動進行（battleFlow.ts）と
// ダメージの適用（battle.ts:applyDamage）を、`applyAction`（core/actions.ts）を通して
// エンドツーエンドで叩いてassertする。devDependency追加なし: Node 25のネイティブTS型剥がし。
//
// 期待値は PHASE3d-2a.md §1 の表と、各節に引いた原典の逐語から作る（今の実装の出力を写さない）。
// 各テストのコメントに根拠を書く。

import { applyAction, type BoardAction } from '../src/core/actions'
import * as battleEngine from '../src/core/battle'
import { EMPTY_BOARD, effectiveStat, type BoardState } from '../src/core/board'
import * as priorityEngine from '../src/core/priority'

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

function dispatch(state: BoardState, action: BoardAction): BoardState {
  return applyAction(state, action).state
}

// ---------------------------------------------------------------------------
// 盤面の組み立て（リーダーA/B・待機キャラcharA1/charB1・Aのバトルカード1枚）
// ---------------------------------------------------------------------------
function setupFreshBoard(): BoardState {
  let s: BoardState = EMPTY_BOARD
  s = dispatch(s, { type: 'spawnCard', iid: 'leaderA', cardId: 'l', cardName: 'リーダーA', owner: 'A', zone: 'leader' })
  s = dispatch(s, { type: 'setOrientation', iid: 'leaderA', orientation: 'ready', cardName: 'リーダーA' })
  s = dispatch(s, { type: 'spawnCard', iid: 'leaderB', cardId: 'l', cardName: 'リーダーB', owner: 'B', zone: 'leader' })
  s = dispatch(s, { type: 'setOrientation', iid: 'leaderB', orientation: 'ready', cardName: 'リーダーB' })
  s = dispatch(s, { type: 'spawnCard', iid: 'charA1', cardId: 'c', cardName: 'キャラA1', owner: 'A', zone: 'char' })
  s = dispatch(s, { type: 'setOrientation', iid: 'charA1', orientation: 'ready', cardName: 'キャラA1' })
  s = dispatch(s, { type: 'spawnCard', iid: 'charB1', cardId: 'c', cardName: 'キャラB1', owner: 'B', zone: 'char' })
  s = dispatch(s, { type: 'setOrientation', iid: 'charB1', orientation: 'ready', cardName: 'キャラB1' })
  s = dispatch(s, { type: 'spawnCard', iid: 'bcard', cardId: 'b', cardName: 'バトルカード', owner: 'A', zone: 'battle' })
  return s
}

function setupFreshBoardNoBattleCard(): BoardState {
  let s: BoardState = EMPTY_BOARD
  s = dispatch(s, { type: 'spawnCard', iid: 'leaderA', cardId: 'l', cardName: 'リーダーA', owner: 'A', zone: 'leader' })
  s = dispatch(s, { type: 'setOrientation', iid: 'leaderA', orientation: 'ready', cardName: 'リーダーA' })
  s = dispatch(s, { type: 'spawnCard', iid: 'leaderB', cardId: 'l', cardName: 'リーダーB', owner: 'B', zone: 'leader' })
  s = dispatch(s, { type: 'setOrientation', iid: 'leaderB', orientation: 'ready', cardName: 'リーダーB' })
  s = dispatch(s, { type: 'spawnCard', iid: 'charA1', cardId: 'c', cardName: 'キャラA1', owner: 'A', zone: 'char' })
  s = dispatch(s, { type: 'setOrientation', iid: 'charA1', orientation: 'ready', cardName: 'キャラA1' })
  return s
}

/**
 * closeWindowByPassing: 開いている窓を「両者パス」で閉じる（宣言なし＝13-3-1 anti-deadlock）。
 * どちらが先に通しても、受理されない側の passPriority は engine が黙って無視する（log空・状態不変）
 * ので、常に A→B の順で呼んで問題ない（at=2のnonActiveOnly窓ではAのpassが無視されBのpassだけ効く）。
 */
function closeWindowByPassing(state: BoardState): BoardState {
  let s = dispatch(state, { type: 'passPriority', by: 'A' })
  if (s.priority !== null) s = dispatch(s, { type: 'passPriority', by: 'B' })
  return s
}

/**
 * declareBattle(A)から、[19]（バトル中アクション、最初の窓）まで両者パスのみで進める共通の踏み台。
 * 参加キャラ・種目・攻防値は各テストが指定できるよう引数化する。
 */
function advanceToAt19(
  state: BoardState,
  opts: { atkA?: number; defA?: number; atkB?: number; defB?: number } = {},
): BoardState {
  let s = dispatch(state, { type: 'declareBattle', challenger: 'A' }) // at=2
  s = closeWindowByPassing(s) // 2→4
  s = closeWindowByPassing(s) // 4→6
  s = closeWindowByPassing(s) // 6→7（行動の点。窓は開かない）
  s = dispatch(s, { type: 'setBattleParticipants', seat: 'A', iids: ['charA1'] })
  s = dispatch(s, { type: 'advanceBattleStep' }) // 7→8
  s = closeWindowByPassing(s) // 8→10
  s = closeWindowByPassing(s) // 10→11
  s = dispatch(s, { type: 'setBattleParticipants', seat: 'B', iids: ['charB1'] })
  s = dispatch(s, { type: 'advanceBattleStep' }) // 11→13
  s = closeWindowByPassing(s) // 13→15
  s = closeWindowByPassing(s) // 15→16
  s = dispatch(s, { type: 'setBattleCard', iid: 'bcard' })
  s = dispatch(s, { type: 'advanceBattleStep' }) // 16→17
  s = closeWindowByPassing(s) // 17→18
  s = dispatch(s, { type: 'setBattleValue', seat: 'A', stat: 'atk', value: opts.atkA ?? 5 })
  s = dispatch(s, { type: 'setBattleValue', seat: 'A', stat: 'def', value: opts.defA ?? 3 })
  s = dispatch(s, { type: 'setBattleValue', seat: 'B', stat: 'atk', value: opts.atkB ?? 4 })
  s = dispatch(s, { type: 'setBattleValue', seat: 'B', stat: 'def', value: opts.defB ?? 2 })
  s = dispatch(s, { type: 'advanceBattleStep' }) // 18→19（窓が開く）
  return s
}

/** advanceToAt19の続き。[19]〜[22]を両者パスのみで抜けて[26]（ダメージ適用の行動点）まで進める */
function advanceToAt26(state: BoardState): BoardState {
  let s = closeWindowByPassing(state) // 19→20
  s = closeWindowByPassing(s) // 20→21（行動の点）
  s = dispatch(s, { type: 'advanceBattleStep' }) // 21→22
  s = closeWindowByPassing(s) // 22→23（行動の点。setBattleValueは既にat=18で入力済み）
  s = dispatch(s, { type: 'advanceBattleStep' }) // 23→25
  s = closeWindowByPassing(s) // 25→26（行動の点）
  return s
}

function ability(by: 'A' | 'B', label: string) {
  return { by, sourceIid: null, kind: '能力' as const, actionType: '割込型' as const, label }
}

// =============================================================================
// 1. 全行程（assist）: [2]〜[29]を全てなぞり、訪れたatの列・窓の開いた回数・各点のstepが
//    PHASE3d-2a.md §1の表と一致することを確認する。
// =============================================================================
{
  const EXPECTED_ATS = [2, 4, 6, 7, 8, 10, 11, 13, 15, 16, 17, 18, 19, 20, 21, 22, 23, 25, 26, 27, 28, 29]
  const EXPECTED_WINDOW_COUNT = 14 // §1の表「種類」列がWの行数（[2,4,6,8,10,13,15,17,19,20,22,25,27,29]）

  const visitedAts: number[] = []
  let windowOpens = 0
  let stepMismatch = false
  let s = setupFreshBoard()

  function step(action: BoardAction) {
    const r = applyAction(s, action)
    s = r.state
    // battleFlow.ts は窓を開くたびログに「窓を開く」または「開き直す」を残す
    // （declareBattle直後の初回オープンも含む。§2-1/§2-2）。文字列一致で開いた回数を数える
    // （wasOpen/nowOpenの前後比較だと、1回のdispatch内で閉じて即開き直す遷移を見落とすため）。
    windowOpens += (r.log.match(/窓を開/g) ?? []).length
    if (s.battle) {
      if (visitedAts.length === 0 || visitedAts[visitedAts.length - 1] !== s.battle.at) {
        visitedAts.push(s.battle.at)
      }
      if (s.battle.step !== battleEngine.stepForAt(s.battle.at)) stepMismatch = true
    }
  }

  step({ type: 'declareBattle', challenger: 'A' }) // at=2（窓・nonActiveOnly）
  step({ type: 'passPriority', by: 'A' }) // 無視される（挑んだ側は宣言もパスもできない）
  step({ type: 'passPriority', by: 'B' }) // 閉じる→at=4
  step({ type: 'passPriority', by: 'A' }) // at=4
  step({ type: 'passPriority', by: 'B' }) // 閉じる→at=6
  step({ type: 'passPriority', by: 'A' }) // at=6
  step({ type: 'passPriority', by: 'B' }) // 閉じる→at=7（行動）
  step({ type: 'setBattleParticipants', seat: 'A', iids: ['charA1'] })
  step({ type: 'advanceBattleStep' }) // 7→8（窓）
  step({ type: 'passPriority', by: 'A' })
  step({ type: 'passPriority', by: 'B' }) // 閉じる→at=10
  step({ type: 'passPriority', by: 'A' })
  step({ type: 'passPriority', by: 'B' }) // 閉じる→at=11（行動）
  step({ type: 'setBattleParticipants', seat: 'B', iids: ['charB1'] })
  step({ type: 'advanceBattleStep' }) // 11→13（窓）
  step({ type: 'passPriority', by: 'A' })
  step({ type: 'passPriority', by: 'B' }) // 閉じる→at=15
  step({ type: 'passPriority', by: 'A' })
  step({ type: 'passPriority', by: 'B' }) // 閉じる→at=16（行動）
  step({ type: 'setBattleCard', iid: 'bcard' })
  step({ type: 'advanceBattleStep' }) // 16→17（窓）
  step({ type: 'passPriority', by: 'A' })
  step({ type: 'passPriority', by: 'B' }) // 閉じる→at=18（行動）
  step({ type: 'setBattleValue', seat: 'A', stat: 'atk', value: 5 })
  step({ type: 'setBattleValue', seat: 'A', stat: 'def', value: 3 })
  step({ type: 'setBattleValue', seat: 'B', stat: 'atk', value: 4 })
  step({ type: 'setBattleValue', seat: 'B', stat: 'def', value: 2 })
  step({ type: 'advanceBattleStep' }) // 18→19（窓・反復）
  step({ type: 'passPriority', by: 'A' })
  step({ type: 'passPriority', by: 'B' }) // 宣言なし→閉じる→at=20
  step({ type: 'passPriority', by: 'A' })
  step({ type: 'passPriority', by: 'B' }) // 閉じる→at=21（行動）
  step({ type: 'advanceBattleStep' }) // 21→22（窓）
  step({ type: 'passPriority', by: 'A' })
  step({ type: 'passPriority', by: 'B' }) // 閉じる→at=23（行動）
  step({ type: 'advanceBattleStep' }) // 23→25（窓）
  step({ type: 'passPriority', by: 'A' })
  step({ type: 'passPriority', by: 'B' }) // 閉じる→at=26（行動）
  step({
    type: 'applyBattleDamage',
    damages: [
      { iid: 'charA1', amount: 1, max: 5 },
      { iid: 'charB1', amount: 3, max: 5 },
    ],
  }) // 26→27（窓）
  step({ type: 'passPriority', by: 'A' })
  step({ type: 'passPriority', by: 'B' }) // 閉じる→at=28（行動）
  step({ type: 'advanceBattleStep' }) // 28→29（窓）
  step({ type: 'passPriority', by: 'A' })
  step({ type: 'passPriority', by: 'B' }) // 閉じる→バトル終了

  assertEqual(visitedAts, EXPECTED_ATS, '1: 訪れたatの列が原典20-4の立ち止まる点の順（§1の表）と一致する')
  assertEqual(windowOpens, EXPECTED_WINDOW_COUNT, '1: 窓が開いた回数が14回（§1の表の窓の実数）')
  assertTrue(!stepMismatch, '1: 各点でstepがat由来の値と一致する（不変条件）')
  assertEqual(s.battle, null, '1: 最後にbattle===null（[29]の窓が閉じてバトル終了）')
}

// =============================================================================
// 2. at=2は相手だけ: 開いた直後、挑んだ側は宣言もパスもできない。相手が宣言→解決→
//    その後にat=4の窓が開く（20-4[2][3]が[4]より先。oldrule.txt:1066-1069）
// =============================================================================
{
  let s = setupFreshBoard()
  s = dispatch(s, { type: 'declareBattle', challenger: 'A' })
  assertEqual(s.battle?.at, 2, '2: declareBattle直後はat=2')
  assertTrue(s.priority !== null, '2: at=2の窓が開いている')
  assertEqual(priorityEngine.canDeclare(s.priority, 'A'), false, '2: 開いた直後、挑んだ側(A)は宣言できない')
  assertEqual(priorityEngine.canDeclare(s.priority, 'B'), true, '2: 開いた直後、相手(B)は宣言できる')

  const beforePass = s
  s = dispatch(s, { type: 'passPriority', by: 'A' })
  assertEqual(s, beforePass, '2: 挑んだ側(A)のpassも無視される（宣言だけでなくパスもできない）')

  s = dispatch(s, { type: 'declareAction', action: ability('B', '同時アクション') })
  assertEqual(s.battle?.at, 2, '2: Bが宣言しても解決前はat=2のまま')
  s = dispatch(s, { type: 'resolveStep' })
  assertEqual(s.battle?.at, 4, '2: Bの宣言を解決した後にat=4の窓が開く（[2][3]が[4]より先）')
  assertTrue(s.priority !== null, '2: at=4の窓が開いている')
}

// =============================================================================
// 3. at=19の反復: 挑んだ側が宣言→相手パス→解決→at=19のまま窓が開き直る。次に両者パス→at=20
//    （20-4[19]「複数回使用できる機会」の実装。§2-2）
// =============================================================================
{
  let s = advanceToAt19(setupFreshBoard())
  assertEqual(s.battle?.at, 19, '3: 前提: at=19の窓が開いている')

  s = dispatch(s, { type: 'declareAction', action: ability('A', '特殊能力') })
  s = dispatch(s, { type: 'passPriority', by: 'B' })
  s = dispatch(s, { type: 'resolveStep' })
  assertEqual(s.battle?.at, 19, '3: 宣言→パス→解決してもat=19のまま（窓が開き直る）')
  assertTrue(s.priority !== null, '3: at=19の窓が開き直っている')

  s = closeWindowByPassing(s) // 両者パス（宣言なし）
  assertEqual(s.battle?.at, 20, '3: 両者が何も宣言せずパスしたらat=20へ進む')
}

// =============================================================================
// 4. [21]のループ: at=21でloopBackBattle→at=19の窓が開きloopCountが1
//    （oldrule.txt:1111「バトルを挑んだプレイヤーは手順[19]に戻るか、次の手順に進むかを選択する」）
// =============================================================================
{
  let s = advanceToAt19(setupFreshBoard())
  s = closeWindowByPassing(s) // 19→20
  s = closeWindowByPassing(s) // 20→21
  assertEqual(s.battle?.at, 21, '4: 前提: at=21にいる')
  assertEqual(s.battle?.loopCount, 0, '4: 前提: loopCountは0')

  s = dispatch(s, { type: 'loopBackBattle' })
  assertEqual(s.battle?.at, 19, '4: loopBackBattleでat=19に戻る')
  assertEqual(s.battle?.loopCount, 1, '4: loopCountが1になる')
  assertTrue(s.priority !== null, '4: at=19の窓が開く')
}

// =============================================================================
// 5. 窓の点で「次へ」は効かない／行動の点でもpriorityがあると効かない（PHASE3d-2a §2-3）
// =============================================================================
{
  // 5a: 窓の点（at=19）でadvanceBattleStepは無効
  const beforeWindow = advanceToAt19(setupFreshBoard())
  const afterWindow = dispatch(beforeWindow, { type: 'advanceBattleStep' })
  assertEqual(afterWindow, beforeWindow, '5a: 窓の点(at=19)でadvanceBattleStepは効かない')

  // 5b: 行動の点（at=7）でも、無関係な宣言でpriorityが開いていればadvanceBattleStepは無効
  let s = setupFreshBoard()
  s = dispatch(s, { type: 'declareBattle', challenger: 'A' })
  s = closeWindowByPassing(s) // 2→4
  s = closeWindowByPassing(s) // 4→6
  s = closeWindowByPassing(s) // 6→7
  assertEqual(s.battle?.at, 7, '5b: 前提: at=7（行動の点）にいる')
  assertEqual(s.priority, null, '5b: 前提: 窓は無い')

  s = dispatch(s, { type: 'declareAction', action: ability('A', '無関係な宣言') })
  assertTrue(s.priority !== null, '5b: 前提: 無関係な宣言で優先権の窓ができた')
  assertEqual(s.battle?.at, 7, '5b: 前提: battle.atはまだ7のまま（この宣言はbattleを動かさない）')

  const before5b = s
  s = dispatch(s, { type: 'advanceBattleStep' })
  assertEqual(s, before5b, '5b: 行動の点でもpriorityが開いているとadvanceBattleStepは効かない')
}

// =============================================================================
// 6. freeモード: 窓の途中でfreeに切り替えてもatは動かない。advanceBattleStepで1つずつ進む
//    （窓の点も行動の点も同じ扱い）。窓の点でassistに戻すと、その点の窓が開く（PHASE3d-2a §2-3）
// =============================================================================
{
  let s = advanceToAt19(setupFreshBoard())
  s = dispatch(s, { type: 'setMode', mode: 'free' })
  assertEqual(s.mode, 'free', '6: freeに切り替わる')
  assertEqual(s.priority, null, '6: freeにすると窓が畳まれる（setModeの既存動作）')
  assertEqual(s.battle?.at, 19, '6: freeに切り替えてもatは動かない（自動で進まない）')

  s = dispatch(s, { type: 'advanceBattleStep' })
  assertEqual(s.battle?.at, 20, '6: freeではadvanceBattleStepで1つずつ進む（窓の点(at=19)でも進める）')
  assertEqual(s.priority, null, '6: freeでは窓を開かない')

  s = dispatch(s, { type: 'setMode', mode: 'assist' })
  assertTrue(s.priority !== null, '6: assistに戻すと、その点(at=20)の窓が開く')
}

// 6b. freeモードで at=29 まで来たら「次へ」でバトルが終わる（統括の検証で追加）。
//     §2-2の3「freeでは at は advanceBattleStep で人が1つずつ進める」。at=29 は末尾なので、次＝バトル終了。
//     （修正前は at=29 で advanceStep が log 空を返し、freeではバトルを終えられなかった）
{
  let s = { ...setupFreshBoard(), mode: 'free' as const }
  s = { ...s, battle: { ...battleEngine.declareBattle('A').battle, at: 29, step: battleEngine.stepForAt(29) } }
  s = dispatch(s, { type: 'advanceBattleStep' })
  assertEqual(s.battle, null, '6b: freeでat=29から「次へ」→battle===null（バトル終了）')
}

// 6c. 表示用ラベルが全ての点にある（PHASE3d-2a §1 末尾。統括の検証で追加）
{
  const missing = battleEngine.AT_SEQUENCE.filter((at) => !battleEngine.AT_LABELS[at])
  assertEqual(missing, [], '6c: AT_SEQUENCEの全ての点にAT_LABELSがある')
}

// =============================================================================
// 7. 消耗: at=7でsetBattleParticipants→指定したキャラがrested。既にrestedのキャラはそのまま
//    （20-4[7][11] oldrule.txt:1075-1076,1084-1085）
// =============================================================================
{
  let s = setupFreshBoard()
  s = dispatch(s, { type: 'spawnCard', iid: 'charA2', cardId: 'c', cardName: 'キャラA2', owner: 'A', zone: 'char' })
  // spawnCardはzone='char'だと既定でrested（board.ts）。既にrestedのキャラを用意したことになる
  assertEqual(s.cards['charA2'].orientation, 'rested', '7: 前提: charA2は既にrested')
  assertEqual(s.cards['charA1'].orientation, 'ready', '7: 前提: charA1はready')

  s = dispatch(s, { type: 'declareBattle', challenger: 'A' })
  s = closeWindowByPassing(s) // 2→4
  s = closeWindowByPassing(s) // 4→6
  s = closeWindowByPassing(s) // 6→7
  s = dispatch(s, { type: 'setBattleParticipants', seat: 'A', iids: ['charA1', 'charA2'] })

  assertEqual(s.cards['charA1'].orientation, 'rested', '7: 指定したready状態のキャラがrestedになる')
  assertEqual(s.cards['charA2'].orientation, 'rested', '7: 既にrestedのキャラはrestedのまま')
  assertEqual(s.battle?.participants.A, ['charA1', 'charA2'], '7: participantsに指定した2体が入る')
}

// =============================================================================
// 8. 自動リーダー: 挑まれた側に待機キャラが無く未指定でat=11「次へ」→リーダーが参加・
//    autoLeader true・待機なら消耗。待機キャラがいて未指定なら進まない。
//    forceAutoLeaderなら待機キャラがいても参加する（20-4[12] oldrule.txt:1088）
// =============================================================================
{
  // 8a: 待機キャラが無い側
  let s = setupFreshBoard()
  s = dispatch(s, { type: 'setOrientation', iid: 'charB1', orientation: 'rested', cardName: 'キャラB1' }) // Bの待機キャラを消す
  s = dispatch(s, { type: 'declareBattle', challenger: 'A' })
  s = closeWindowByPassing(s) // 2→4
  s = closeWindowByPassing(s) // 4→6
  s = closeWindowByPassing(s) // 6→7
  s = dispatch(s, { type: 'setBattleParticipants', seat: 'A', iids: ['charA1'] })
  s = dispatch(s, { type: 'advanceBattleStep' }) // 7→8
  s = closeWindowByPassing(s) // 8→10
  s = closeWindowByPassing(s) // 10→11
  assertEqual(s.battle?.at, 11, '8a: 前提: at=11')
  assertEqual(s.battle?.participants.B, [], '8a: 前提: Bの参加キャラ未指定')
  assertEqual(s.cards['leaderB'].orientation, 'ready', '8a: 前提: リーダーBはready')

  s = dispatch(s, { type: 'advanceBattleStep' }) // 待機キャラ無し→autoAssignLeaderを経て13へ
  assertEqual(s.battle?.participants.B, ['leaderB'], '8a: リーダーが自動で参加キャラになる')
  assertEqual(s.battle?.autoLeader.B, true, '8a: autoLeader.Bがtrueになる（「指定した」ことにならない印）')
  assertEqual(s.cards['leaderB'].orientation, 'rested', '8a: 待機だったリーダーが消耗する（20-4[12]）')
  assertEqual(s.battle?.at, 13, '8a: at=13まで進む')

  // 8b: 待機キャラがいて未指定なら進まない
  let s2 = setupFreshBoard()
  s2 = dispatch(s2, { type: 'declareBattle', challenger: 'A' })
  s2 = closeWindowByPassing(s2)
  s2 = closeWindowByPassing(s2)
  s2 = closeWindowByPassing(s2)
  s2 = dispatch(s2, { type: 'setBattleParticipants', seat: 'A', iids: ['charA1'] })
  s2 = dispatch(s2, { type: 'advanceBattleStep' })
  s2 = closeWindowByPassing(s2)
  s2 = closeWindowByPassing(s2)
  assertEqual(s2.battle?.at, 11, '8b: 前提: at=11（Bにはcharb1という待機キャラがいる）')
  const before8b = s2
  s2 = dispatch(s2, { type: 'advanceBattleStep' })
  assertEqual(s2, before8b, '8b: 待機キャラがいて未指定なら進まない')

  // 8c: forceAutoLeaderBattleなら待機キャラがいても参加する
  s2 = dispatch(s2, { type: 'forceAutoLeaderBattle', seat: 'B' })
  assertEqual(s2.battle?.participants.B, ['leaderB'], '8c: forceAutoLeaderBattleで待機キャラがいてもリーダーが参加する')
  assertEqual(s2.battle?.autoLeader.B, true, '8c: autoLeader.Bがtrueになる')
}

// =============================================================================
// 9. ダメージ: 攻5/防3 と 攻4/防4 → 受けるダメージは 4−3=1 と 5−4=1（20-10）。
//    0以下は気力が変わらない。気力1のキャラが1ダメージ→resultDownedに入る／
//    気力0のキャラが1ダメージ→入らない（「１以上から０以下」。15-5 oldrule.txt:633）
// =============================================================================
{
  let s = setupFreshBoard()
  s = dispatch(s, { type: 'spawnCard', iid: 'charA2', cardId: 'c', cardName: 'キャラA2', owner: 'A', zone: 'char' })
  s = dispatch(s, { type: 'setKiryoku', iid: 'charA1', value: 1, cardName: 'キャラA1' }) // 気力1→1ダメージでダウン
  s = dispatch(s, { type: 'setKiryoku', iid: 'charB1', value: 0, cardName: 'キャラB1' }) // 気力0→1ダメージでもダウンしない
  s = dispatch(s, { type: 'setKiryoku', iid: 'charA2', value: 3, cardName: 'キャラA2' }) // 0ダメージ用

  s = advanceToAt19(s, { atkA: 5, defA: 3, atkB: 4, defB: 4 })
  const dmg = battleEngine.computeDamage(s.battle!)
  assertEqual(dmg, { A: 1, B: 1 }, '9: ダメージ式（20-10）: Aが受けるのは4-3=1、Bが受けるのは5-4=1')

  s = advanceToAt26(s)
  assertEqual(s.battle?.at, 26, '9: 前提: at=26')

  s = dispatch(s, {
    type: 'applyBattleDamage',
    damages: [
      { iid: 'charA1', amount: dmg.A, max: 5 }, // 1ダメージ
      { iid: 'charB1', amount: dmg.B, max: 5 }, // 1ダメージ
      { iid: 'charA2', amount: 0, max: 5 }, // 0以下はダメージ扱いしない（20-10 oldrule.txt:1157）
    ],
  })

  assertEqual(s.cards['charA1'].kiryoku, 0, '9: charA1の気力が1→0になる')
  assertEqual(s.cards['charB1'].kiryoku, -1, '9: charB1の気力が0→-1になる（ダメージ自体は適用される）')
  assertEqual(s.cards['charA2'].kiryoku, 3, '9: amount=0のcharA2は気力が変わらない')
  assertEqual(s.battle?.resultDowned, ['charA1'], '9: 気力が1以上から0以下になったcharA1だけresultDownedに入る（charB1は元から0以下なので入らない）')
  assertEqual(s.battle?.at, 27, '9: 適用後at=27に進む')
  assertTrue(s.priority !== null, '9: at=27の窓が開く（assist）')
}

// =============================================================================
// 10. 中断の自動検出: at=19の窓の処理中に参加キャラをゴミ箱へ→aborted・at=28。窓は残る。
//     解決して閉じてからat=28「次へ」→at=29を経ずにbattle===null（20-6-1 oldrule.txt:1138-1139）
// =============================================================================
{
  let s = advanceToAt19(setupFreshBoard())
  assertEqual(s.battle?.at, 19, '10: 前提: at=19の窓が開いている')
  assertEqual(s.battle?.aborted, false, '10: 前提: まだ中断していない')

  s = dispatch(s, { type: 'toTrash', iid: 'charA1', cardName: 'キャラA1' }) // 参加キャラが場から失われる
  assertEqual(s.battle?.aborted, true, '10: 参加キャラの喪失でabortedになる（20-6）')
  assertEqual(s.battle?.at, 28, '10: 中断でat=28になる（[28]は行うが[29]は行わない）')
  assertTrue(s.priority !== null, '10: 中断した時点で開いていた窓は消えない')

  s = closeWindowByPassing(s) // 処理中の宣言を人が解決を続ける（ここでは宣言なしパス）
  assertEqual(s.priority, null, '10: 窓が閉じた')

  s = dispatch(s, { type: 'advanceBattleStep' })
  assertEqual(s.battle, null, '10: at=28の「次へ」でat=29を経ずにbattle===null（20-6-1）')
}

// =============================================================================
// 11. 結果でダウンしたキャラ: resultDownedに入ったキャラをat=27でゴミ箱へ→中断しない。
//     入っていない参加キャラをat=25でゴミ箱へ→中断する（20-6括弧書き／[25]窓の効果のケース）
// =============================================================================
{
  // 11a: resultDownedに入ったキャラ（at=27でゴミ箱へ）→中断しない
  let s = setupFreshBoard()
  s = dispatch(s, { type: 'setKiryoku', iid: 'charA1', value: 1, cardName: 'キャラA1' })
  s = advanceToAt19(s, { atkA: 5, defA: 0, atkB: 1, defB: 0 }) // Aが受けるダメージ=atkB-defA=1-0=1
  s = advanceToAt26(s)
  assertEqual(s.battle?.at, 26, '11a: 前提: at=26')
  s = dispatch(s, { type: 'applyBattleDamage', damages: [{ iid: 'charA1', amount: 1, max: 5 }] })
  assertEqual(s.battle?.resultDowned, ['charA1'], '11a: charA1がresultDownedに入る')
  assertEqual(s.battle?.at, 27, '11a: at=27に進む')
  assertTrue(s.priority !== null, '11a: at=27の窓が開く')

  s = dispatch(s, { type: 'toTrash', iid: 'charA1', cardName: 'キャラA1' })
  assertEqual(s.battle?.aborted, false, '11a: resultDownedに記録済みの参加キャラのゴミ箱送りは中断しない（20-6括弧書き）')

  // 11b: resultDownedに入っていない参加キャラ（at=25でゴミ箱へ）→中断する
  let s2 = advanceToAt19(setupFreshBoard())
  s2 = closeWindowByPassing(s2) // 19→20
  s2 = closeWindowByPassing(s2) // 20→21
  s2 = dispatch(s2, { type: 'advanceBattleStep' }) // 21→22
  s2 = closeWindowByPassing(s2) // 22→23
  s2 = dispatch(s2, { type: 'advanceBattleStep' }) // 23→25（窓が開く）
  assertEqual(s2.battle?.at, 25, '11b: 前提: at=25')
  assertEqual(s2.battle?.resultDowned, [], '11b: 前提: resultDownedは空（[26]をまだ通っていない）')

  s2 = dispatch(s2, { type: 'toTrash', iid: 'charA1', cardName: 'キャラA1' })
  assertEqual(s2.battle?.aborted, true, '11b: resultDownedに無い参加キャラの喪失（[25]窓の効果）は中断する')
}

// =============================================================================
// 12. バトルカードがゴミ箱に行っても中断しない（at=19。20-9・12-2・FAQ oldfaq.txt:3443-3444）
// =============================================================================
{
  let s = advanceToAt19(setupFreshBoard())
  assertEqual(s.battle?.battleCardIid, 'bcard', '12: 前提: バトルカードがセットされている')
  s = dispatch(s, { type: 'toTrash', iid: 'bcard', cardName: 'バトルカード' })
  assertEqual(s.battle?.aborted, false, '12: バトルカードがゴミ箱送りされても中断しない（20-9/12-2/FAQ）')
}

// =============================================================================
// 13. 宣言の入口: バトル中の2本目→拒否／未使用のバトルカードが両者に無い→拒否
//     （相手側にだけあれば受理＝「いずれかのフィールド」）／挑んだ側に待機キャラが無い→拒否。
//     canDeclareBattleの返す理由がnull/非nullで一致（20-3 oldrule.txt:1060-1061）
// =============================================================================
{
  // 13a: バトル中の2本目は拒否
  let s = advanceToAt19(setupFreshBoard())
  const before13a = s
  s = dispatch(s, { type: 'declareBattle', challenger: 'B' })
  assertEqual(s, before13a, '13a: バトル中の2本目のdeclareBattleは拒否される（DESIGN §5.2 C-2）')

  // 13b: 未使用のバトルカードがどちらにも無い→拒否
  const s2 = setupFreshBoardNoBattleCard()
  const reason2 = battleEngine.canDeclareBattle(s2, 'A')
  assertTrue(reason2 !== null, '13b: バトルカードがどちらにも無いとcanDeclareBattleが理由を返す')
  const declined2 = dispatch(s2, { type: 'declareBattle', challenger: 'A' })
  assertEqual(declined2, s2, '13b: バトルカードが無いとdeclareBattleは拒否される（state不変）')

  // 13c: 相手側にだけバトルカードがあれば受理できる（「いずれかのフィールド」）
  let s3 = setupFreshBoardNoBattleCard()
  s3 = dispatch(s3, { type: 'spawnCard', iid: 'bcardB', cardId: 'b', cardName: 'バトルカードB', owner: 'B', zone: 'battle' })
  const reason3 = battleEngine.canDeclareBattle(s3, 'A')
  assertEqual(reason3, null, '13c: 相手側にだけバトルカードがあれば受理できる')
  s3 = dispatch(s3, { type: 'declareBattle', challenger: 'A' })
  assertEqual(s3.battle?.at, 2, '13c: 実際にdeclareBattleが受理される')

  // 13d: 挑んだ側に待機キャラが無い→拒否
  let s4 = setupFreshBoard()
  s4 = dispatch(s4, { type: 'setOrientation', iid: 'charA1', orientation: 'rested', cardName: 'キャラA1' })
  s4 = dispatch(s4, { type: 'setOrientation', iid: 'leaderA', orientation: 'rested', cardName: 'リーダーA' })
  const reason4 = battleEngine.canDeclareBattle(s4, 'A')
  assertTrue(reason4 !== null, '13d: 挑んだ側に待機キャラが無いとcanDeclareBattleが理由を返す')
  const declined4 = dispatch(s4, { type: 'declareBattle', challenger: 'A' })
  assertEqual(declined4, s4, '13d: 挑んだ側に待機キャラが無いとdeclareBattleは拒否される（state不変）')

  // 13e: canDeclareBattleの返す理由がnull/非nullで実際の受理結果と一致する
  const s5 = setupFreshBoard()
  assertEqual(battleEngine.canDeclareBattle(s5, 'A'), null, '13e: 通常盤面ではcanDeclareBattleがnullを返す')
  const accepted5 = dispatch(s5, { type: 'declareBattle', challenger: 'A' })
  assertTrue(accepted5.battle !== null, '13e: reason===nullのとき実際にdeclareBattleが受理される（一致）')
}

// =============================================================================
// 14. 非回帰: 既存の4スイート（test:core-priority/test:timing/test:play-declare/test:battle）が
//     緑のまま。このファイル自体はP3d-1のtest-battle.tsとは別ファイルなので直接の変更点は無いが、
//     applyAction経由でbattleFlow.afterActionが常時走るようになった影響が既存4スイートに
//     出ないことは `npm run test` の全体実行で確認する（HANDOFF参照）。
// =============================================================================
{
  // battle===nullの通常操作がbattleFlowの影響を受けないことをこのファイル内でも最小限確認する
  let s = setupFreshBoard()
  const before14 = s
  s = dispatch(s, { type: 'setKiryoku', iid: 'charA1', value: 4, cardName: 'キャラA1' })
  assertTrue(s !== before14, '14: battle===nullでも通常のアクションは適用される')
  assertEqual(s.battle, null, '14: battle===nullのままなら battleFlow は何もしない')
}

// =============================================================================
// 15. 旧state: atの無いbattleを読み込むとnullになる（ui/board/useBoard.ts:normalizeBattleが使う
//     battle.ts:isValidBattleShape。normalizePriorityと同じ流儀。PHASE3d-2a §6）
// =============================================================================
{
  const oldShapeBattle = {
    challenger: 'A',
    step: '宣言',
    participants: { A: [], B: [] },
    autoLeader: { A: false, B: false },
    battleCardIid: null,
    atk: { A: null, B: null },
    def: { A: null, B: null },
    loopCount: 0,
    resultDowned: [],
    aborted: false,
    abortReason: null,
    // at フィールドなし（P3d-1の旧shape）
  }
  assertEqual(battleEngine.isValidBattleShape(oldShapeBattle), false, '15: atフィールドの無いbattleはisValidBattleShape=false')
  const oldBoard: BoardState = { ...EMPTY_BOARD, battle: oldShapeBattle as unknown as BoardState['battle'] }
  const normalized: BoardState = oldBoard.battle !== null && !battleEngine.isValidBattleShape(oldBoard.battle) ? { ...oldBoard, battle: null } : oldBoard
  assertEqual(normalized.battle, null, '15: atの無いbattleを読み込むとnullになる（useBoard.ts:normalizeBattleと同じ判定）')

  // 非回帰: atがある現行shapeは正規化で消えない
  const freshBattle = battleEngine.declareBattle('A').battle
  assertEqual(battleEngine.isValidBattleShape(freshBattle), true, '15b: atのある現行shapeはisValidBattleShape=true（消されない）')
}

// =============================================================================
// 16. PHASE3d-3 §2-3: decideBattleValues（[23]で4値を一括確定してat=25へ）
// =============================================================================
{
  // at=23まで進める（advanceToAt19→19-22を両者パスで抜ける。advanceToAt26の前半と同じ手順）
  function advanceToAt23(state: BoardState): BoardState {
    let s = closeWindowByPassing(state) // 19→20
    s = closeWindowByPassing(s) // 20→21
    s = dispatch(s, { type: 'advanceBattleStep' }) // 21→22
    s = closeWindowByPassing(s) // 22→23
    return s
  }

  let s = advanceToAt23(advanceToAt19(setupFreshBoard()))
  assertEqual(s.battle!.at, 23, '16a: 前提としてat=23に到達している')

  const decided = dispatch(s, {
    type: 'decideBattleValues',
    atk: { A: 7, B: 6 },
    def: { A: 1, B: 2 },
  })
  assertEqual(decided.battle!.atk, { A: 7, B: 6 }, '16b: decideBattleValuesでatkが一括で入る')
  assertEqual(decided.battle!.def, { A: 1, B: 2 }, '16c: decideBattleValuesでdefが一括で入る')
  assertEqual(decided.battle!.at, 25, '16d: decideBattleValues後at=25へ進む（同じdispatchで前進も済む）')

  // at≠23はno-op
  const atNot23 = { ...battleEngine.declareBattle('A').battle } // at=2
  const noop = battleEngine.decideBattleValues(atNot23, { atk: { A: 1, B: 1 }, def: { A: 1, B: 1 } })
  assertEqual(noop.log, '', '16e: at≠23のdecideBattleValuesはno-op（log空）')
  assertEqual(noop.battle, atNot23, '16f: at≠23のdecideBattleValuesは状態不変')

  // assistでpriorityが開いていれば（宣言/処理中）no-op（§2-3「ゲートはadvanceBattleStepと同じ」）。
  // at=23自体はACTION_ATSで通常priorityは無いが、ゲート単体を確かめるため[19]の窓が開いた
  // state（priority!==null）のbattle.atだけ23にすり替えて投げる。
  const s19WindowOpen = advanceToAt19(setupFreshBoard())
  assertTrue(s19WindowOpen.priority !== null, '16g: 前提として[19]の窓が開いている（priority!==null）')
  const s23WithOpenPriority: BoardState = { ...s19WindowOpen, battle: { ...s19WindowOpen.battle!, at: 23 } }
  const gatedResult = applyAction(s23WithOpenPriority, {
    type: 'decideBattleValues',
    atk: { A: 1, B: 1 },
    def: { A: 1, B: 1 },
  })
  assertEqual(gatedResult.log, '', '16h: assistでpriorityが開いていればat=23でもdecideBattleValuesはno-op')
  assertEqual(gatedResult.state, s23WithOpenPriority, '16i: ゲートされたdecideBattleValuesは状態不変')
}

// =============================================================================
// 17. PHASE3d-3 §3-2: [28]から出るとき、攻防修正（このバトル）だけを失わせる
// =============================================================================
{
  function advanceToAt28(state: BoardState): BoardState {
    let s = closeWindowByPassing(state) // 19→20
    s = closeWindowByPassing(s) // 20→21
    s = dispatch(s, { type: 'advanceBattleStep' }) // 21→22
    s = closeWindowByPassing(s) // 22→23
    s = dispatch(s, { type: 'advanceBattleStep' }) // 23→25
    s = closeWindowByPassing(s) // 25→26
    s = dispatch(s, {
      type: 'applyBattleDamage',
      damages: [{ iid: 'charB1', amount: 1, max: 5 }],
    }) // 26→27
    s = closeWindowByPassing(s) // 27→28
    return s
  }

  let s = advanceToAt28(advanceToAt19(setupFreshBoard()))
  assertEqual(s.battle!.at, 28, '17a: 前提としてat=28に到達している')

  s = dispatch(s, {
    type: 'addModifier',
    modifier: { id: 'm1', targetIid: 'charA1', sourceLabel: 'テスト攻防', kind: '攻防修正', battleStat: 'atk', delta: 2, scope: 'このバトル' },
    cardName: 'キャラA1',
  })
  s = dispatch(s, {
    type: 'addModifier',
    modifier: { id: 'm2', targetIid: 'charA1', sourceLabel: 'テスト能力値', kind: '能力値修正', stat: '力', delta: 3, scope: 'このバトル' },
    cardName: 'キャラA1',
  })
  s = dispatch(s, {
    type: 'addModifier',
    modifier: { id: 'm3', targetIid: 'charA1', sourceLabel: 'テスト攻防（ターン終了時）', kind: '攻防修正', battleStat: 'def', delta: 1, scope: 'ターン終了時' },
    cardName: 'キャラA1',
  })
  assertEqual(Object.keys(s.modifiers).length, 3, '17b: 前提として修正3件が付いている')

  const advanced = dispatch(s, { type: 'advanceBattleStep' }) // 28→29
  assertEqual(advanced.modifiers['m1'], undefined, '17c: 攻防修正・このバトル はat=28を出るときに消える（20-4[28]）')
  assertEqual(advanced.modifiers['m2']?.delta, 3, '17d: 能力値修正（scopeこのバトル含む）は残る（12-1）')
  assertEqual(advanced.modifiers['m3']?.delta, 1, '17e: 攻防修正・ターン終了時（scopeがこのバトル以外）は残る')

  // 中断経由でも同じ（20-6-1）
  let s2 = advanceToAt28(advanceToAt19(setupFreshBoard()))
  s2 = dispatch(s2, {
    type: 'addModifier',
    modifier: { id: 'm4', targetIid: 'charA1', sourceLabel: 'テスト攻防2', kind: '攻防修正', battleStat: 'atk', delta: 5, scope: 'このバトル' },
    cardName: 'キャラA1',
  })
  s2 = dispatch(s2, { type: 'abortBattle', reason: 'テスト中断' })
  assertEqual(s2.battle!.at, 28, '17f: 前提として中断後もat=28')
  const advancedAborted = dispatch(s2, { type: 'advanceBattleStep' }) // 28(aborted)→battle=null
  assertEqual(advancedAborted.battle, null, '17g: 中断後のadvanceBattleStepでbattle=nullになる')
  assertEqual(advancedAborted.modifiers['m4'], undefined, '17h: 中断経由でも攻防修正・このバトル は消える（20-6-1でも[28]は行う）')
}

// =============================================================================
// 18. PHASE3d-3 §3-1: effectiveStatは攻防修正を数えない
// =============================================================================
{
  const withMods: BoardState = {
    ...EMPTY_BOARD,
    cards: { c1: { iid: 'c1', cardId: 'c', owner: 'A', zone: 'char', index: 0, orientation: 'ready', faceUp: true, kiryoku: null, attachedTo: null } },
    modifiers: {
      m1: { id: 'm1', targetIid: 'c1', sourceLabel: 'a', kind: '能力値修正', stat: '力', delta: 2, scope: 'このバトル' },
      m2: { id: 'm2', targetIid: 'c1', sourceLabel: 'b', kind: '攻防修正', battleStat: 'atk', delta: 100, scope: 'このバトル' },
    },
  }
  const eff = effectiveStat(withMods, 'c1', 3, '力')
  assertEqual(eff, 5, '18: effectiveStatは能力値修正だけ数える（攻防修正の100は無視・3+2=5）')
}

console.log(failures === 0 ? `\n✅ 全ケース成功` : `\n❌ ${failures}件失敗`)
process.exit(failures === 0 ? 0 : 1)
