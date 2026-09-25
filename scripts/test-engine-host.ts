// つなぐ層（src/ui/engine/host.ts）のテスト — PHASE-R2u §3-5
// R2u-1 の途中で止めた版: ②④⑤ と ③ の空の場合だけ。① の通し（呼び出し→イベント→割り込み→ダメージ→ダウン）は未作成（HANDOFF-R2u-1.md）。
// 期待の出所: 11-2（宣言の機会は順に1人ずつ・見送り）oldrule.txt・PHASE-R2u §1（ホストが正・1要求＝Undo 1回）・§2-2（自動見送り）。

import { EMPTY_BOARD, fillBoardDefaults, type BoardState, type CardInstance, type Seat } from '../src/core/board'
import { emptyHistory, undo, type History } from '../src/core/history'
import { awaitingSeat, currentWindow } from '../src/core/proc'
import { drive } from '../src/engine/drive'
import { applyEngineReq, buildEngineCtx, shouldAutoPass } from '../src/ui/engine/host'

let failures = 0
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures++
    console.error(`❌ ${msg}\n   実際: ${a}\n   期待: ${e}`)
  } else console.log(`✅ ${msg}`)
}

function card(iid: string, owner: Seat, zone: CardInstance['zone']): CardInstance {
  return { iid, cardId: iid, owner, zone, index: 0, orientation: 'ready', faceUp: zone !== 'deck', kiryoku: null, attachedTo: null }
}
function board(cards: CardInstance[]): BoardState {
  const map: Record<string, CardInstance> = {}
  cards.forEach((c, i) => (map[c.iid] = { ...c, index: i }))
  return { ...EMPTY_BOARD, cards: map, turn: { active: 'A', phase: 'メイン' } }
}

const ctx = buildEngineCtx([], null)
// メインフェイズの窓を開いた盤面（カード無し＝宣言できるものが無い）
const s0 = drive(board([card('dA0', 'A', 'deck'), card('dB0', 'B', 'deck')]), ctx).state
const h0: History = { ...emptyHistory(), present: s0 }
eq(!!currentWindow(s0) && awaitingSeat(s0), 'A', '前提: メインの窓が開き、宣言の番はアクティブプレイヤー A（11-2）')

// ② ゲストの不正な要求を捨てる
const r1 = applyEngineReq(h0, ctx, { kind: 'pass', by: 'B' }, 'B')
eq(r1.ok, false, '② 番でない席の見送りは捨てる（11-2）')
const r2 = applyEngineReq(h0, ctx, { kind: 'pass', by: 'A' }, 'B')
eq(r2.ok, false, '② 他の席を名乗る要求は捨てる（ホストが正 §1）')
eq(applyEngineReq(h0, ctx, { kind: 'choose', by: 'B', id: 'x', pick: [] }, 'B').ok, false, '② 無い選択への答えは捨てる')

// ③ 自動見送り: 宣言できるものが無ければ見送る・番でない席は見送らない
eq(shouldAutoPass(s0, ctx, 'A'), true, '③ 宣言できるものが無い A は自動見送り（§2-2）')
eq(shouldAutoPass(s0, ctx, 'B'), false, '③ 番でない B は自動見送りしない')

// ④ 1要求＝history 1件（Undo 1回で要求の前に戻る）
const r3 = applyEngineReq(h0, ctx, { kind: 'pass', by: 'A' }, null)
eq(r3.ok && r3.history.past.length, 1, '④ 見送り1回で history は1件増える')
if (r3.ok) eq(undo(r3.history).present === s0, true, '④ Undo 1回で要求の前の盤面に戻る')

// ⑤ assist の旧データは free で読む（PHASE-R2u §1）
eq(fillBoardDefaults({ mode: 'assist' } as Partial<BoardState>).mode, 'free', '⑤ mode: assist の保存盤面は free として読む')

if (failures) {
  console.error(`\n${failures} 件失敗`)
  process.exit(1)
}
console.log('\nengine-host: すべて成功')
