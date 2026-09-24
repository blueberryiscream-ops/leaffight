// PHASE3d-1.md §6 検証スクリプト。core/battle.ts のバトル状態機械（7段）を直接叩いてassertする。
// devDependency追加なし: Node 25のネイティブTS型剥がしで直接実行できる（test-timing.tsと同じ流儀）。

import * as battleEngine from '../src/core/battle'
import type { Battle } from '../src/core/battle'
import { EMPTY_BOARD, type BoardState, type CardInstance, type Seat } from '../src/core/board'

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

function boardWith(cards: CardInstance[], battle: Battle | null = null): BoardState {
  const map: Record<string, CardInstance> = {}
  for (const c of cards) map[c.iid] = c
  return { ...EMPTY_BOARD, cards: map, battle }
}

// PHASE3d-2a: advanceStepは`at`を1点ずつ進める純関数になった（窓/行動の区別を見ない）。
// 旧テスト（7段単位で1回のadvanceStepを呼んでいた）をatベースに書き直すための踏み台。
// 前提未達で詰まったら（at が変わらなければ）そこで止める。
function advanceTo(battle: Battle, targetAt: number): Battle {
  let b = battle
  for (let i = 0; i < 30 && b.at !== targetAt; i++) {
    const next = battleEngine.advanceStep(b).battle
    if (next.at === b.at) break // 前提未達で進めない
    b = next
  }
  return b
}

// =============================================================================
// 1. 宣言 → 7段を順に進めて『終了』に到達する
// =============================================================================
{
  const board = boardWith([
    card('leaderA', { owner: 'A', zone: 'leader' }),
    card('leaderB', { owner: 'B', zone: 'leader' }),
    card('charA1', { owner: 'A', zone: 'char' }),
    card('charB1', { owner: 'B', zone: 'char' }),
    card('bcard', { owner: 'A', zone: 'battle' }),
  ])

  let { battle } = battleEngine.declareBattle('A')
  assertEqual(battle.step, '宣言', '1: declareBattleでstep=宣言')
  assertEqual(battle.at, 2, '1: declareBattleでat=2')

  battle = advanceTo(battle, 6)
  assertEqual(battle.step, '挑んだ側キャラ指定', '1: 宣言→挑んだ側キャラ指定（at=6まで進む）')

  battle = battleEngine.setParticipants(battle, 'A', ['charA1']).battle
  battle = advanceTo(battle, 10)
  assertEqual(battle.step, '挑まれた側キャラ指定', '1: 参加キャラ指定後、挑まれた側キャラ指定へ（at=10まで進む）')

  battle = battleEngine.setParticipants(battle, 'B', ['charB1']).battle
  battle = advanceTo(battle, 15)
  assertEqual(battle.step, '種目決定', '1: 挑まれた側指定後、種目決定へ（at=15まで進む）')

  const setCardResult = battleEngine.setBattleCard(board, battle, 'bcard')
  battle = setCardResult.battle
  battle = advanceTo(battle, 19)
  assertEqual(battle.step, 'バトル中アクション', '1: 種目決定後、バトル中アクションへ（at=19まで進む）')

  battle = battleEngine.setValue(battle, 'A', 'atk', 5).battle
  battle = battleEngine.setValue(battle, 'A', 'def', 3).battle
  battle = battleEngine.setValue(battle, 'B', 'atk', 4).battle
  battle = battleEngine.setValue(battle, 'B', 'def', 2).battle
  battle = advanceTo(battle, 25)
  assertEqual(battle.step, '結果', '1: バトル中アクション後、結果へ（at=25まで進む）')

  battle = advanceTo(battle, 28)
  assertEqual(battle.step, '終了', '1: 結果後、終了へ（7段完走・at=28）')
}

// =============================================================================
// 2. 前提未達では進まない: 参加キャラ0のまま advanceStep → 状態不変・log空
// =============================================================================
{
  let { battle } = battleEngine.declareBattle('A')
  battle = advanceTo(battle, 7) // 宣言→挑んだ側キャラ指定（at=7, 参加キャラ指定の行動点）
  assertEqual(battle.step, '挑んだ側キャラ指定', '2: 前提: at=7（挑んだ側キャラ指定）にいる')

  const before = battle
  const result = battleEngine.advanceStep(battle) // participants['A']が空のまま進めようとする（at=7を出る前提未達）
  assertEqual(result.log, '', '2: 参加キャラ0のまま advanceStep → logが空')
  assertEqual(result.battle, before, '2: 参加キャラ0のまま advanceStep → 状態が変わらない')
}

// =============================================================================
// 3. 複数参加: setParticipants('B', [iid1, iid2, iid3]) が配列で保持される（C-1）
// =============================================================================
{
  let { battle } = battleEngine.declareBattle('A')
  battle = battleEngine.setParticipants(battle, 'B', ['b1', 'b2', 'b3']).battle
  assertEqual(battle.participants.B, ['b1', 'b2', 'b3'], '3: 複数参加キャラが配列で保持される')
}

// =============================================================================
// 4. 自動リーダー参加: 待機キャラが無い側で autoAssignLeader → リーダーがparticipantsに入り autoLeader=true
// =============================================================================
{
  const board = boardWith([
    card('leaderB', { owner: 'B', zone: 'leader' }),
    card('restedB1', { owner: 'B', zone: 'char', orientation: 'rested' }), // 待機(ready)ではない
  ])
  let { battle } = battleEngine.declareBattle('A')
  const result = battleEngine.autoAssignLeader(board, battle, 'B')
  battle = result.battle
  assertEqual(battle.participants.B, ['leaderB'], '4: 待機キャラが無い側はリーダーが参加キャラになる')
  assertEqual(battle.autoLeader.B, true, '4: autoLeader.B が true になる（20-8。「指定した」ことにならない印）')
  assertTrue(result.log !== '', '4: autoAssignLeaderのlogが空でない')
}

// 4b. 待機キャラがいる側では autoAssignLeader は何もしない（非回帰）
{
  const board = boardWith([
    card('leaderA', { owner: 'A', zone: 'leader' }),
    card('readyA1', { owner: 'A', zone: 'char', orientation: 'ready' }),
  ])
  let { battle } = battleEngine.declareBattle('A')
  const result = battleEngine.autoAssignLeader(board, battle, 'A')
  assertEqual(result.log, '', '4b: 待機キャラがいる側では autoAssignLeader は何もしない')
  assertEqual(result.battle.participants.A, [], '4b: participantsも変わらない')
}

// =============================================================================
// 5. 種目決定でバトルカードが used=true になる
// =============================================================================
{
  const board = boardWith([card('bcard1', { owner: 'A', zone: 'battle' })])
  let { battle } = battleEngine.declareBattle('A')
  const result = battleEngine.setBattleCard(board, battle, 'bcard1')
  assertEqual(result.battle.battleCardIid, 'bcard1', '5: battleCardIidがセットされる')
  assertEqual(result.state.cards['bcard1'].used, true, '5: 種目にしたカードが used=true になる')
}

// =============================================================================
// 6. [21]のループ: loopBack で step が『バトル中アクション』のまま loopCount が増える
// =============================================================================
{
  // loopBackは at=21（[21]バトルを挑んだプレイヤーが[19]に戻るか選ぶ点）でだけ有効。
  // oldrule.txt:1111「バトルを挑んだプレイヤーは手順[19]に戻るか、次の手順に進むかを選択する」
  let { battle } = battleEngine.declareBattle('A')
  battle = { ...battle, at: 21, step: battleEngine.stepForAt(21) }
  assertEqual(battle.loopCount, 0, '6: 初期loopCountは0')
  battle = battleEngine.loopBack(battle).battle
  assertEqual(battle.at, 19, '6: loopBack後はat=19に戻る')
  assertEqual(battle.step, 'バトル中アクション', '6: loopBack後もstepはバトル中アクションのまま')
  assertEqual(battle.loopCount, 1, '6: loopCountが1に増える')
  battle = { ...battle, at: 21 } // 次の周でまた[21]に到達した想定
  battle = battleEngine.loopBack(battle).battle
  assertEqual(battle.loopCount, 2, '6: 繰り返すたびloopCountが増える（2回目）')
}

// 6b. バトル中アクション以外での loopBack は何もしない（非回帰）
{
  let { battle } = battleEngine.declareBattle('A')
  const result = battleEngine.loopBack(battle)
  assertEqual(result.log, '', '6b: 宣言段でのloopBackは何もしない')
  assertEqual(result.battle.loopCount, 0, '6b: loopCountも変わらない')
}

// =============================================================================
// 7. ダメージ式: 攻5/防3 → 2、攻3/防5 → 0（0以下は無効）、両者同時に出る
// =============================================================================
{
  let { battle } = battleEngine.declareBattle('A')
  battle = battleEngine.setValue(battle, 'A', 'atk', 5).battle // Aの攻撃力5
  battle = battleEngine.setValue(battle, 'B', 'def', 3).battle // Bの防御力3 → Bが受けるダメージ = 5-3 = 2
  battle = battleEngine.setValue(battle, 'B', 'atk', 3).battle // Bの攻撃力3
  battle = battleEngine.setValue(battle, 'A', 'def', 5).battle // Aの防御力5 → Aが受けるダメージ = 3-5 = -2→0
  const dmg = battleEngine.computeDamage(battle)
  assertEqual(dmg, { A: 0, B: 2 }, '7: ダメージ式が両者同時に正しく算出される（0以下は無効）')
}

// =============================================================================
// 8. 中断(a): 前提を満たせず abortBattle → aborted=true / step='終了'
// =============================================================================
{
  let { battle } = battleEngine.declareBattle('A')
  battle = battleEngine.advanceStep(battle).battle // 挑んだ側キャラ指定
  // 参加キャラを指定できない（前提未達）→ 呼び出し側がabortBattleを呼ぶ想定
  battle = battleEngine.abortBattle(battle, '参加キャラを指定できない（20-4[7]の中断判定）').battle
  assertEqual(battle.aborted, true, '8: 中断(a)でaborted=trueになる')
  assertEqual(battle.step, '終了', '8: 中断(a)でstep=終了になる')
  assertTrue(battle.abortReason !== null, '8: abortReasonが記録される')
}

// =============================================================================
// 9. 中断(b): detectAbort が参加キャラの喪失を検出する。
//    差し戻し（PHASE3d-1-差し戻し.md）対応: 期待値は「今の実装の出力」でなく原典の逐語から作る。
// =============================================================================
{
  // 9a. バトル中アクション段で参加キャラが場から消える → 中断
  let { battle } = battleEngine.declareBattle('A')
  battle = { ...battle, step: 'バトル中アクション', participants: { A: ['charA1'], B: ['charB1'] } }
  const before = boardWith(
    [card('charA1', { owner: 'A', zone: 'char' }), card('charB1', { owner: 'B', zone: 'char' })],
    battle,
  )
  const after = boardWith([card('charB1', { owner: 'B', zone: 'char' })], battle) // charA1が盤外に消えた
  const reason = battleEngine.detectAbort(before, after, battle)
  assertTrue(reason !== null, '9a: バトル中アクション段の参加キャラ喪失は中断を検出する')

  // 9b. 結果段で resultDowned に入っている参加キャラが消えた → 中断にしない（[26]由来のダウン。20-6括弧書き）
  const battleResultDowned: Battle = { ...battle, step: '結果', resultDowned: ['charA1'] }
  const beforeResult = boardWith(
    [card('charA1', { owner: 'A', zone: 'char' }), card('charB1', { owner: 'B', zone: 'char' })],
    battleResultDowned,
  )
  const afterResult = boardWith(
    [card('charA1', { owner: 'A', zone: 'trash' }), card('charB1', { owner: 'B', zone: 'char' })],
    battleResultDowned,
  )
  const reasonResult = battleEngine.detectAbort(beforeResult, afterResult, battleResultDowned)
  assertEqual(reasonResult, null, '9b: resultDownedに記録済みの参加キャラ喪失は中断として検出しない（[26]・20-6括弧書き）')

  // 9c. 結果段でも resultDowned に入っていない参加キャラの喪失は中断する。
  //     oldrule.txt:1114-1119（20-4結果段）: [25]《バトルの結果の計算をしたとき》の処理、アクション宣言の
  //     機会（窓）→[26]必要ならばダメージ処理、ダウン処理を行う→[27]《バトルの結果を出したとき》の処理、
  //     アクション宣言の機会（窓）。"結果"段には[25][27]の2つの窓があり、[25]の窓で誰かが効果を使い、
  //     それによって参加キャラが場を離れた場合は[26]由来のダウンではないので中断すべき
  //     （PHASE3d-1-差し戻し.md §2。段だけで判定してはいけない具体例）
  const battleResultOther: Battle = { ...battle, step: '結果', resultDowned: [] } // 誰もresultDownedに入れていない
  const beforeOther = boardWith(
    [card('charA1', { owner: 'A', zone: 'char' }), card('charB1', { owner: 'B', zone: 'char' })],
    battleResultOther,
  )
  const afterOther = boardWith([card('charB1', { owner: 'B', zone: 'char' })], battleResultOther) // [25]の窓の効果でcharA1が消えた想定
  const reasonOther = battleEngine.detectAbort(beforeOther, afterOther, battleResultOther)
  assertTrue(reasonOther !== null, '9c: 結果段でもresultDownedに無い参加キャラの喪失は中断する（[25]窓の効果のケース）')

  // 9d. バトルカードがゴミ箱送りされても detectAbort は null（続行）。
  //     20-9（oldrule.txt:1151-1152）「そのバトルカードがフィールドから取り除かれたとしても、決定された
  //     攻撃属性と防御属性はバトル種目が変更されない限り有効です。」
  //     12-2（oldrule.txt:509-510）「バトルカードに関しては、バトルが行われている限りカードの有無は
  //     問われず、バトルが行われている間有効です。」
  //     FAQ（oldfaq.txt:3443-3444）「バトル中にバトルカードがゴミ箱送りされた場合…／バトルは続行します。」
  //     （旧実装はここを「中断」としていたが、統括の指示書の誤りだった。反転させた＝差し戻し③）
  const battleWithCard: Battle = { ...battle, step: 'バトル中アクション', battleCardIid: 'bcard1' }
  const beforeCard = boardWith(
    [card('charA1', { owner: 'A', zone: 'char' }), card('charB1', { owner: 'B', zone: 'char' }), card('bcard1', { owner: 'A', zone: 'battle' })],
    battleWithCard,
  )
  const afterCard = boardWith(
    [card('charA1', { owner: 'A', zone: 'char' }), card('charB1', { owner: 'B', zone: 'char' }), card('bcard1', { owner: 'A', zone: 'trash' })],
    battleWithCard,
  )
  const reasonCard = battleEngine.detectAbort(beforeCard, afterCard, battleWithCard)
  assertEqual(reasonCard, null, '9d: バトルカードがゴミ箱送りされてもdetectAbortはnull（バトルは続行する。20-9/12-2/FAQ）')

  // 9e. 種目決定段（[19]より前）での喪失は20-6の対象外 → 検出しない（変更なし）
  const battleEarly: Battle = { ...battle, step: '種目決定', battleCardIid: 'bcard1' }
  const beforeEarly = boardWith([card('bcard1', { owner: 'A', zone: 'battle' })], battleEarly)
  const afterEarly = boardWith([card('bcard1', { owner: 'A', zone: 'trash' })], battleEarly)
  const reasonEarly = battleEngine.detectAbort(beforeEarly, afterEarly, battleEarly)
  assertEqual(reasonEarly, null, '9e: [19]より前の段（種目決定）は20-6の中断判定の対象外')

  // 9f. 終了段で参加キャラが消えても → null（差し戻し追加分）。
  //     20-6の範囲は[19]〜[28]。[28]はアクション宣言の機会を持たない処理段だが、§5.2の7段圧縮では
  //     [28]と[29]（バトル終了後の通常の窓）が1つの'終了'段に合体していて、盤面からは「まだ[28]の
  //     途中か、もう[29]の通常の窓に入ったか」を区別できない。区別できないものを機械的に中断と
  //     断定すると、通常のバトル終了後の効果まで誤って中断扱いにしかねないため、'終了'段では
  //     自動判定せず、人間が状況を見てabortBattleを呼ぶ運用にした（PHASE3d-1-差し戻し.md 統括4補足）。
  const battleEnd: Battle = { ...battle, step: '終了' }
  const beforeEnd = boardWith([card('charA1', { owner: 'A', zone: 'char' }), card('charB1', { owner: 'B', zone: 'char' })], battleEnd)
  const afterEnd = boardWith([card('charB1', { owner: 'B', zone: 'char' })], battleEnd)
  const reasonEnd = battleEngine.detectAbort(beforeEnd, afterEnd, battleEnd)
  assertEqual(reasonEnd, null, '9f: 終了段（[28]/[29]混在）では参加キャラが消えても自動検出しない')
}

// =============================================================================
// 9g. 非回帰: 旧shapeのBattle（resultDownedフィールドが無い）を読んでも detectAbort が壊れない
// =============================================================================
{
  const oldShapeBattle = {
    challenger: 'A' as Seat,
    step: 'バトル中アクション' as const,
    participants: { A: ['charA1'], B: [] as string[] },
    autoLeader: { A: false, B: false },
    battleCardIid: null,
    atk: { A: null, B: null },
    def: { A: null, B: null },
    loopCount: 0,
    aborted: false,
    abortReason: null,
    // resultDowned フィールドなし（差し戻し前の旧shapeを模す）
  } as unknown as Battle
  const before = boardWith([card('charA1', { owner: 'A', zone: 'char' })], oldShapeBattle)
  const after = boardWith([], oldShapeBattle)
  const reason = battleEngine.detectAbort(before, after, oldShapeBattle)
  assertTrue(reason !== null, '9g: resultDownedが無い旧shapeのBattleでもdetectAbortは例外を投げず中断を検出する')
}

// =============================================================================
// 10. 中断しても種目は used=true のまま（ロールバックしない）
// =============================================================================
{
  const board = boardWith([card('bcard1', { owner: 'A', zone: 'battle' })])
  let { battle } = battleEngine.declareBattle('A')
  const setCardResult = battleEngine.setBattleCard(board, battle, 'bcard1')
  battle = setCardResult.battle
  const stateAfterSetCard = setCardResult.state
  battle = battleEngine.abortBattle(battle, 'テスト中断').battle
  assertEqual(battle.aborted, true, '10: 中断後 aborted=true')
  assertEqual(stateAfterSetCard.cards['bcard1'].used, true, '10: 中断後もバトル種目カードは used=true のまま（ロールバックしない）')
}

// =============================================================================
// 11. 非回帰: 旧盤面（battleフィールドが無いstate）を読んでも壊れない
// =============================================================================
{
  // 旧バージョンで保存された盤面を模す（battleフィールドが無い）。ui/board/useBoard.ts と同じ
  // 補完パターン {...EMPTY_BOARD, ...saved} で復元する。
  const oldSaved = {
    cards: { c1: card('c1') },
    modifiers: {},
    priority: null,
    mode: 'assist' as const,
    // battle フィールドなし（旧盤面を模す）
  }
  const restored: BoardState = { ...EMPTY_BOARD, ...oldSaved }
  assertEqual(restored.battle, null, '11: 旧盤面を{...EMPTY_BOARD, ...saved}で補完するとbattle=nullになる')
  assertTrue(restored.cards['c1'] !== undefined, '11: 旧盤面のカードデータはそのまま残る')

  // battle=nullの状態でBoardAction相当の操作（advanceBattleStep等）を呼んでも壊れない
  const noBattleResult = battleEngine.advanceStep({
    challenger: 'A' as Seat,
    at: 2,
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
  })
  assertTrue(noBattleResult.battle.at === 4 && noBattleResult.battle.step === '宣言', '11: battle:nullな旧盤面と無関係に、battle.ts自体は単独でも動く（atが1点進む）')
}

// =============================================================================
// 12. PHASE3d-3 §2-3: setValue(..., null) で「自動に戻す」（nullに戻る）
// =============================================================================
{
  let { battle } = battleEngine.declareBattle('A')
  battle = battleEngine.setValue(battle, 'A', 'atk', 5).battle
  assertEqual(battle.atk.A, 5, '12a: 前提として手入力で5が入っている')
  const reverted = battleEngine.setValue(battle, 'A', 'atk', null)
  assertEqual(reverted.battle.atk.A, null, '12b: setValue(..., null) でnull（自動）に戻る')
  assertTrue(reverted.log.includes('自動'), '12c: ログに「自動に戻した」旨が出る')
}

console.log(failures === 0 ? `\n✅ 全ケース成功` : `\n❌ ${failures}件失敗`)
process.exit(failures === 0 ? 0 : 1)
